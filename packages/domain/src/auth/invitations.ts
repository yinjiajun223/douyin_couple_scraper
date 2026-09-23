import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { Pool, RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';

import { writeAuditEvent } from '../audit/audit-events.js';
import { hashPassword, strongPasswordSchema } from './passwords.js';

const roleSchema = z.enum(['admin', 'operator', 'readonly']);

const createInvitationInputSchema = z
  .object({
    workspaceId: z.uuid(),
    email: z
      .email()
      .max(320)
      .transform((value) => value.trim().toLowerCase()),
    role: roleSchema,
    invitedByUserId: z.uuid(),
    expiresInSeconds: z
      .number()
      .int()
      .min(60)
      .max(30 * 24 * 60 * 60),
  })
  .strict();

const acceptInvitationInputSchema = z
  .object({
    token: z.string().min(32).max(200),
    displayName: z.string().trim().min(2).max(200),
    password: strongPasswordSchema,
  })
  .strict();

interface InvitationRow extends RowDataPacket {
  accepted_at: Date | null;
  email: string;
  expires_at: Date;
  id: string;
  revoked_at: Date | null;
  role: 'admin' | 'operator' | 'readonly';
  workspace_id: string;
}

interface PendingInvitationRow extends RowDataPacket {
  created_at: Date;
  email: string;
  expires_at: Date;
  id: string;
  invited_by_name: string | null;
  role: 'admin' | 'operator' | 'readonly';
}

const revokeInvitationInputSchema = z
  .object({
    actorUserId: z.uuid(),
    invitationId: z.uuid(),
    workspaceId: z.uuid(),
  })
  .strict();

export class InvitationNotFoundError extends Error {
  constructor() {
    super('邀请不存在');
    this.name = 'InvitationNotFoundError';
  }
}

export class InvitationExpiredError extends Error {
  constructor() {
    super('邀请已过期');
    this.name = 'InvitationExpiredError';
  }
}

export class InvitationAlreadyUsedError extends Error {
  constructor() {
    super('邀请已经使用');
    this.name = 'InvitationAlreadyUsedError';
  }
}

export class InvitationRevokedError extends Error {
  constructor() {
    super('邀请已被撤销');
    this.name = 'InvitationRevokedError';
  }
}

export class InvitedEmailAlreadyExistsError extends Error {
  constructor() {
    super('受邀邮箱已经存在账户');
    this.name = 'InvitedEmailAlreadyExistsError';
  }
}

export interface CreateInvitationResult {
  invitationId: string;
  token: string;
  expiresAt: Date;
}

export interface AcceptInvitationResult {
  userId: string;
  workspaceId: string;
  role: 'admin' | 'operator' | 'readonly';
}

export async function createInvitation(
  pool: Pool,
  rawInput: unknown,
): Promise<CreateInvitationResult> {
  const input = createInvitationInputSchema.parse(rawInput);
  const invitationId = randomUUID();
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + input.expiresInSeconds * 1000);
  await pool.execute(
    `INSERT INTO invitations
     (id, workspace_id, email, role, token_hash, expires_at, invited_by_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      invitationId,
      input.workspaceId,
      input.email,
      input.role,
      hashToken(token),
      expiresAt,
      input.invitedByUserId,
    ],
  );
  await writeAuditEvent(pool, {
    workspaceId: input.workspaceId,
    actorUserId: input.invitedByUserId,
    action: 'account.invitation_created',
    subjectType: 'invitation',
    subjectId: invitationId,
    summary: { email: input.email, role: input.role, expiresAt: expiresAt.toISOString() },
  });
  return { invitationId, token, expiresAt };
}

export async function acceptInvitation(
  pool: Pool,
  rawInput: unknown,
): Promise<AcceptInvitationResult> {
  const input = acceptInvitationInputSchema.parse(rawInput);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query<InvitationRow[]>(
      `SELECT id, workspace_id, email, role, expires_at, accepted_at, revoked_at
       FROM invitations WHERE token_hash = ? LIMIT 1 FOR UPDATE`,
      [hashToken(input.token)],
    );
    const invitation = rows[0];
    if (!invitation) throw new InvitationNotFoundError();
    if (invitation.accepted_at) throw new InvitationAlreadyUsedError();
    // 撤销优先于过期判定：两者都拒绝接受，但「管理员主动撤销」是更有用的原因，
    // 也保留原始 expires_at，使审计能区分自然过期与主动撤销。
    if (invitation.revoked_at) throw new InvitationRevokedError();
    if (invitation.expires_at.getTime() <= Date.now()) throw new InvitationExpiredError();

    const [existingUsers] = await connection.query<RowDataPacket[]>(
      'SELECT id FROM users WHERE email = ? LIMIT 1 FOR UPDATE',
      [invitation.email],
    );
    if (existingUsers.length > 0) throw new InvitedEmailAlreadyExistsError();

    const userId = randomUUID();
    const passwordHash = await hashPassword(input.password);
    await connection.execute(
      `INSERT INTO users (id, email, password_hash, display_name, status)
       VALUES (?, ?, ?, ?, 'active')`,
      [userId, invitation.email, passwordHash, input.displayName],
    );
    await connection.execute(
      'INSERT INTO memberships (workspace_id, user_id, role) VALUES (?, ?, ?)',
      [invitation.workspace_id, userId, invitation.role],
    );
    await connection.execute(
      `UPDATE invitations
       SET accepted_at = CURRENT_TIMESTAMP(3), accepted_by_user_id = ?
       WHERE id = ?`,
      [userId, invitation.id],
    );
    await writeAuditEvent(connection, {
      workspaceId: invitation.workspace_id,
      actorUserId: userId,
      action: 'account.invitation_accepted',
      subjectType: 'user',
      subjectId: userId,
      summary: { invitationId: invitation.id, email: invitation.email, role: invitation.role },
    });
    await connection.commit();
    return { userId, workspaceId: invitation.workspace_id, role: invitation.role };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

/**
 * 列出本工作区尚未接受、未撤销且未过期的邀请。
 *
 * 刻意不 SELECT `token_hash`：邀请列表是管理员界面数据，令牌材料（明文或哈希）
 * 一旦进入响应就等于把账户创建能力泄露给任何能读到该响应的人。
 */
export async function listPendingInvitations(pool: Pool, workspaceId: string) {
  const [rows] = await pool.query<PendingInvitationRow[]>(
    `SELECT invitations.id, invitations.email, invitations.role, invitations.created_at,
            invitations.expires_at, users.display_name AS invited_by_name
     FROM invitations
     LEFT JOIN users ON users.id = invitations.invited_by_user_id
     WHERE invitations.workspace_id = ?
       AND invitations.accepted_at IS NULL
       AND invitations.revoked_at IS NULL
       AND invitations.expires_at > CURRENT_TIMESTAMP(3)
     ORDER BY invitations.created_at DESC, invitations.id DESC`,
    [workspaceId],
  );
  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    role: row.role,
    invitedAt: row.created_at,
    expiresAt: row.expires_at,
    invitedByDisplayName: row.invited_by_name,
  }));
}

/** 撤销一个尚未被接受的邀请；已接受或已撤销的邀请拒绝再次撤销。 */
export async function revokeInvitation(
  pool: Pool,
  rawInput: unknown,
): Promise<{ invitationId: string; revoked: true }> {
  const input = revokeInvitationInputSchema.parse(rawInput);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query<InvitationRow[]>(
      `SELECT id, workspace_id, email, role, expires_at, accepted_at, revoked_at
       FROM invitations
       WHERE workspace_id = ? AND id = ?
       LIMIT 1 FOR UPDATE`,
      [input.workspaceId, input.invitationId],
    );
    const invitation = rows[0];
    if (!invitation) throw new InvitationNotFoundError();
    if (invitation.accepted_at) throw new InvitationAlreadyUsedError();
    if (invitation.revoked_at) throw new InvitationRevokedError();

    await connection.execute(
      'UPDATE invitations SET revoked_at = CURRENT_TIMESTAMP(3) WHERE id = ?',
      [input.invitationId],
    );
    await writeAuditEvent(connection, {
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      action: 'account.invitation_revoked',
      subjectType: 'invitation',
      subjectId: input.invitationId,
      summary: { email: invitation.email, role: invitation.role },
    });
    await connection.commit();
    return { invitationId: input.invitationId, revoked: true };
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
