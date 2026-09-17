import { randomUUID } from 'node:crypto';

import type { Pool, RowDataPacket } from 'mysql2/promise';

import { writeAuditEvent } from '../audit/audit-events.js';
import { adminBootstrapInputSchema, hashPassword } from './passwords.js';

const BOOTSTRAP_LOCK_NAME = 'douyin_ops_bootstrap_admin';

interface AdminRow extends RowDataPacket {
  email: string;
  user_id: string;
}

interface LockRow extends RowDataPacket {
  acquired: number;
}

export class AdminAlreadyBootstrappedError extends Error {
  constructor() {
    super('首位管理员已经初始化，不能通过 bootstrap 创建其他管理员');
    this.name = 'AdminAlreadyBootstrappedError';
  }
}

export class AdminBootstrapLockError extends Error {
  constructor() {
    super('管理员初始化正在由另一个进程执行，请稍后重试');
    this.name = 'AdminBootstrapLockError';
  }
}

export interface AdminBootstrapResult {
  status: 'created' | 'already_initialized';
  userId: string;
}

export async function bootstrapFirstAdmin(
  pool: Pool,
  rawInput: unknown,
): Promise<AdminBootstrapResult> {
  const input = adminBootstrapInputSchema.parse(rawInput);
  const connection = await pool.getConnection();
  let transactionStarted = false;
  let lockAcquired = false;

  try {
    const [lockRows] = await connection.query<LockRow[]>('SELECT GET_LOCK(?, 10) AS acquired', [
      BOOTSTRAP_LOCK_NAME,
    ]);
    lockAcquired = lockRows[0]?.acquired === 1;
    if (!lockAcquired) throw new AdminBootstrapLockError();

    await connection.beginTransaction();
    transactionStarted = true;
    const [admins] = await connection.query<AdminRow[]>(
      `SELECT users.id AS user_id, users.email
       FROM memberships
       JOIN users ON users.id = memberships.user_id
       WHERE memberships.workspace_id = ? AND memberships.role = 'admin'
       ORDER BY memberships.created_at
       LIMIT 1
       FOR UPDATE`,
      [input.workspaceId],
    );
    const existingAdmin = admins[0];
    if (existingAdmin) {
      if (existingAdmin.email.toLowerCase() !== input.email) {
        throw new AdminAlreadyBootstrappedError();
      }
      await connection.commit();
      transactionStarted = false;
      return { status: 'already_initialized', userId: existingAdmin.user_id };
    }

    const [usersWithEmail] = await connection.query<AdminRow[]>(
      'SELECT id AS user_id, email FROM users WHERE email = ? LIMIT 1 FOR UPDATE',
      [input.email],
    );
    if (usersWithEmail.length > 0) throw new AdminAlreadyBootstrappedError();

    const userId = randomUUID();
    const passwordHash = await hashPassword(input.password);
    await connection.execute(
      `INSERT INTO users (id, email, password_hash, display_name, status)
       VALUES (?, ?, ?, ?, 'active')`,
      [userId, input.email, passwordHash, input.displayName],
    );
    await connection.execute(
      `INSERT INTO memberships (workspace_id, user_id, role)
       VALUES (?, ?, 'admin')`,
      [input.workspaceId, userId],
    );
    await writeAuditEvent(connection, {
      workspaceId: input.workspaceId,
      actorUserId: userId,
      action: 'account.bootstrap_admin',
      subjectType: 'user',
      subjectId: userId,
      summary: { email: input.email, role: 'admin' },
    });
    await connection.commit();
    transactionStarted = false;
    return { status: 'created', userId };
  } catch (error) {
    if (transactionStarted) await connection.rollback();
    throw error;
  } finally {
    if (lockAcquired) await connection.query('SELECT RELEASE_LOCK(?)', [BOOTSTRAP_LOCK_NAME]);
    connection.release();
  }
}
