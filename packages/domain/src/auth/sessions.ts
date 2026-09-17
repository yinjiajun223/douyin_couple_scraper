import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import type { Pool, RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';

import { writeAuditEvent } from '../audit/audit-events.js';
import { hashPassword, verifyPassword } from './passwords.js';

export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

const loginInputSchema = z
  .object({
    workspaceId: z.uuid(),
    email: z
      .email()
      .max(320)
      .transform((value) => value.trim().toLowerCase()),
    password: z.string().min(1).max(200),
  })
  .strict();

interface CredentialRow extends RowDataPacket {
  display_name: string;
  email: string;
  password_hash: string;
  role: SessionPrincipal['role'];
  status: string;
  user_id: string;
}

interface SessionRow extends RowDataPacket {
  csrf_secret_hash: string;
  display_name: string;
  email: string;
  role: SessionPrincipal['role'];
  session_id: string;
  user_id: string;
  workspace_id: string;
}

export class InvalidCredentialsError extends Error {
  constructor() {
    super('邮箱或密码错误');
    this.name = 'InvalidCredentialsError';
  }
}

export class UserNotFoundError extends Error {
  constructor() {
    super('找不到指定工作区成员');
    this.name = 'UserNotFoundError';
  }
}

export interface SessionPrincipal {
  sessionId: string;
  workspaceId: string;
  userId: string;
  email: string;
  displayName: string;
  role: 'admin' | 'operator' | 'readonly';
  csrfSecretHash: string;
}

export interface LoginResult {
  sessionToken: string;
  csrfToken: string;
  expiresAt: Date;
  principal: SessionPrincipal;
}

let dummyPasswordHashPromise: Promise<string> | undefined;

export async function loginWithPassword(pool: Pool, rawInput: unknown): Promise<LoginResult> {
  const input = loginInputSchema.parse(rawInput);
  const [rows] = await pool.query<CredentialRow[]>(
    `SELECT users.id AS user_id, users.email, users.display_name, users.password_hash,
            users.status, memberships.role
     FROM users
     JOIN memberships ON memberships.user_id = users.id
     WHERE memberships.workspace_id = ? AND users.email = ?
     LIMIT 1`,
    [input.workspaceId, input.email],
  );
  const credential = rows[0];
  const passwordHash = credential?.password_hash ?? (await getDummyPasswordHash());
  const passwordMatches = await verifyPassword(passwordHash, input.password);
  if (!credential || !passwordMatches || credential.status !== 'active') {
    throw new InvalidCredentialsError();
  }

  const sessionId = randomUUID();
  const sessionToken = randomBytes(32).toString('base64url');
  const csrfToken = deriveSessionCsrfToken(sessionToken);
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
  const csrfSecretHash = hashToken(csrfToken);
  await pool.execute(
    `INSERT INTO sessions
     (id, workspace_id, user_id, token_hash, csrf_secret_hash, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      sessionId,
      input.workspaceId,
      credential.user_id,
      hashToken(sessionToken),
      csrfSecretHash,
      expiresAt,
    ],
  );

  return {
    sessionToken,
    csrfToken,
    expiresAt,
    principal: {
      sessionId,
      workspaceId: input.workspaceId,
      userId: credential.user_id,
      email: credential.email,
      displayName: credential.display_name,
      role: credential.role,
      csrfSecretHash,
    },
  };
}

export async function authenticateSession(
  pool: Pool,
  sessionToken: string | undefined,
): Promise<SessionPrincipal | null> {
  if (!sessionToken) return null;
  const [rows] = await pool.query<SessionRow[]>(
    `SELECT sessions.id AS session_id, sessions.workspace_id, sessions.user_id,
            sessions.csrf_secret_hash, users.email, users.display_name, memberships.role
     FROM sessions
     JOIN users ON users.id = sessions.user_id
     JOIN memberships
       ON memberships.workspace_id = sessions.workspace_id
      AND memberships.user_id = sessions.user_id
     WHERE sessions.token_hash = ?
       AND sessions.revoked_at IS NULL
       AND sessions.expires_at > CURRENT_TIMESTAMP(3)
       AND users.status = 'active'
     LIMIT 1`,
    [hashToken(sessionToken)],
  );
  const session = rows[0];
  if (!session) return null;

  await pool.execute('UPDATE sessions SET last_seen_at = CURRENT_TIMESTAMP(3) WHERE id = ?', [
    session.session_id,
  ]);
  return {
    sessionId: session.session_id,
    workspaceId: session.workspace_id,
    userId: session.user_id,
    email: session.email,
    displayName: session.display_name,
    role: session.role,
    csrfSecretHash: session.csrf_secret_hash,
  };
}

export function isValidCsrfToken(
  principal: SessionPrincipal,
  csrfToken: string | undefined,
): boolean {
  if (!csrfToken) return false;
  const actual = Buffer.from(hashToken(csrfToken), 'hex');
  const expected = Buffer.from(principal.csrfSecretHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Stable across tabs; the HttpOnly session secret is never returned to JavaScript. */
export function deriveSessionCsrfToken(sessionToken: string): string {
  return createHmac('sha256', sessionToken).update('douyin-browser-csrf-v1').digest('base64url');
}

export async function revokeSession(pool: Pool, sessionToken: string): Promise<void> {
  await pool.execute(
    `UPDATE sessions SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP(3))
     WHERE token_hash = ?`,
    [hashToken(sessionToken)],
  );
}

export async function revokeAllUserSessions(pool: Pool, userId: string): Promise<void> {
  await pool.execute(
    `UPDATE sessions SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP(3))
     WHERE user_id = ?`,
    [userId],
  );
}

export async function disableUserAccount(
  pool: Pool,
  workspaceId: string,
  userId: string,
): Promise<void> {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [members] = await connection.query<RowDataPacket[]>(
      `SELECT user_id FROM memberships
       WHERE workspace_id = ? AND user_id = ?
       FOR UPDATE`,
      [workspaceId, userId],
    );
    if (members.length === 0) throw new UserNotFoundError();

    await connection.execute("UPDATE users SET status = 'disabled' WHERE id = ?", [userId]);
    await connection.execute(
      `UPDATE sessions SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP(3))
       WHERE user_id = ?`,
      [userId],
    );
    await connection.execute(
      `UPDATE devices
       SET status = 'revoked', revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP(3))
       WHERE owner_user_id = ?`,
      [userId],
    );
    await writeAuditEvent(connection, {
      workspaceId,
      actorUserId: userId,
      action: 'account.disabled',
      subjectType: 'user',
      subjectId: userId,
      summary: { sessionsRevoked: true, devicesRevoked: true },
    });
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

async function getDummyPasswordHash(): Promise<string> {
  dummyPasswordHashPromise ??= hashPassword('NonexistentUser2026');
  return dummyPasswordHashPromise;
}
