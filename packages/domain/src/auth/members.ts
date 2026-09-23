import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';

import { writeAuditEvent } from '../audit/audit-events.js';
import type { WorkspaceRole } from './permissions.js';
import { UserNotFoundError } from './sessions.js';

export class LastActiveAdminError extends Error {
  public constructor() {
    super('工作区必须保留至少一名启用状态的管理员，请先提升另一名管理员再操作');
    this.name = 'LastActiveAdminError';
  }
}

export class SelfDisableError extends Error {
  public constructor() {
    super('不能停用当前登录的自己，请让另一名管理员操作');
    this.name = 'SelfDisableError';
  }
}

const memberActionSchema = z
  .object({
    actorUserId: z.uuid(),
    targetUserId: z.uuid(),
    workspaceId: z.uuid(),
  })
  .strict();

const roleChangeSchema = memberActionSchema
  .extend({
    role: z.enum(['admin', 'operator', 'readonly']),
  })
  .strict();

interface MemberRow extends RowDataPacket {
  role: WorkspaceRole;
  status: string;
}

/**
 * 停用成员：置 `users.status='disabled'`、撤销其全部会话与设备、写审计。
 *
 * `users.status` 不在 `memberships` 上，因此停用是全局的，会影响该用户在所有工作区的状态；
 * 当前只有一个 seed 工作区，多工作区启用前需要重新设计。
 */
export async function disableUserAccount(
  pool: Pool,
  rawInput: unknown,
): Promise<{ status: 'disabled'; targetUserId: string }> {
  const input = memberActionSchema.parse(rawInput);
  if (input.actorUserId === input.targetUserId) throw new SelfDisableError();
  return withTransaction(pool, async (connection) => {
    const activeAdmins = await lockWorkspaceMembers(connection, input.workspaceId);
    const member = await lockTargetMember(connection, input.workspaceId, input.targetUserId);
    assertCanLoseAdmin(member.role, activeAdmins);

    await connection.execute(`UPDATE users SET status = 'disabled' WHERE id = ?`, [
      input.targetUserId,
    ]);
    const [sessions] = await connection.execute<ResultSetHeader>(
      `UPDATE sessions SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP(3))
       WHERE user_id = ?`,
      [input.targetUserId],
    );
    const [devices] = await connection.execute<ResultSetHeader>(
      `UPDATE devices
       SET status = 'revoked', revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP(3))
       WHERE owner_user_id = ?`,
      [input.targetUserId],
    );
    await writeAuditEvent(connection, {
      action: 'account.disabled',
      actorUserId: input.actorUserId,
      subjectId: input.targetUserId,
      subjectType: 'user',
      summary: {
        devicesRevoked: devices.affectedRows,
        sessionsRevoked: sessions.affectedRows,
      },
      workspaceId: input.workspaceId,
    });
    return { status: 'disabled' as const, targetUserId: input.targetUserId };
  });
}

/**
 * 重新启用成员：只把 `users.status` 置回 `active` 并写审计。
 *
 * 刻意**不**恢复设备授权：停用期间被撤销的设备令牌绑定的是运营本机的浏览器画像，
 * 管理员无从判断那台机器是否仍在同一人手上，因此需要本人在本机重新配对。
 */
export async function enableUserAccount(
  pool: Pool,
  rawInput: unknown,
): Promise<{ status: 'active'; targetUserId: string }> {
  const input = memberActionSchema.parse(rawInput);
  return withTransaction(pool, async (connection) => {
    // 这里不需要护栏结论，但仍然先取同一把工作区锁：所有成员生命周期操作都按
    // 「先工作区、后目标行」的同一顺序加锁，才不会出现互相等待的死锁。
    await lockWorkspaceMembers(connection, input.workspaceId);
    await lockTargetMember(connection, input.workspaceId, input.targetUserId);
    await connection.execute(`UPDATE users SET status = 'active' WHERE id = ?`, [
      input.targetUserId,
    ]);
    await writeAuditEvent(connection, {
      action: 'account.enabled',
      actorUserId: input.actorUserId,
      subjectId: input.targetUserId,
      subjectType: 'user',
      summary: { devicesRestored: false },
      workspaceId: input.workspaceId,
    });
    return { status: 'active' as const, targetUserId: input.targetUserId };
  });
}

/**
 * 变更成员角色。`authenticateSession` 每次请求都从数据库解析角色，
 * 因此变更对已登录成员即时生效，无需撤销会话。
 */
export async function changeMemberRole(
  pool: Pool,
  rawInput: unknown,
): Promise<{ role: WorkspaceRole; targetUserId: string }> {
  const input = roleChangeSchema.parse(rawInput);
  return withTransaction(pool, async (connection) => {
    const activeAdmins = await lockWorkspaceMembers(connection, input.workspaceId);
    const member = await lockTargetMember(connection, input.workspaceId, input.targetUserId);
    if (member.role !== input.role) {
      // 降级与停用移除的是同一样东西——管理员身份，因此共用同一条护栏。
      // 走到这里说明角色确实在变，目标当前是管理员就一定是降级。
      assertCanLoseAdmin(member.role, activeAdmins);
      await connection.execute(
        `UPDATE memberships SET role = ? WHERE workspace_id = ? AND user_id = ?`,
        [input.role, input.workspaceId, input.targetUserId],
      );
      await writeAuditEvent(connection, {
        action: 'account.role_changed',
        actorUserId: input.actorUserId,
        subjectId: input.targetUserId,
        subjectType: 'user',
        summary: { from: member.role, to: input.role },
        workspaceId: input.workspaceId,
      });
    }
    return { role: input.role, targetUserId: input.targetUserId };
  });
}

/**
 * 取工作区成员范围的排他锁，并返回当前**启用状态**的管理员人数。
 *
 * 计数必须是加锁读，而且必须在锁定目标行之前执行：
 * - 只锁目标行挡不住两名管理员并发互相降级——各自锁各自的行、互不阻塞，
 *   双方都会数到 2 个管理员然后一起通过，工作区随后失去全部管理员，
 *   只能靠 `bootstrap-admin` CLI 救援；
 * - 加锁顺序若不统一（一个先锁行、一个先锁范围）会直接死锁。
 * 所有成员生命周期操作都先走这一把锁，因此彼此串行化，后提交者能看到前者的结果。
 */
async function lockWorkspaceMembers(
  connection: PoolConnection,
  workspaceId: string,
): Promise<number> {
  const [rows] = await connection.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS total
     FROM memberships
     JOIN users ON users.id = memberships.user_id
     WHERE memberships.workspace_id = ?
       AND memberships.role = 'admin'
       AND users.status = 'active'
     FOR UPDATE`,
    [workspaceId],
  );
  return Number(rows[0]?.total ?? 0);
}

/** 只有「目标当前是管理员」才需要护栏；提升他人不会减少管理员数量。 */
function assertCanLoseAdmin(currentRole: WorkspaceRole, activeAdmins: number): void {
  if (currentRole !== 'admin') return;
  if (activeAdmins <= 1) throw new LastActiveAdminError();
}

async function lockTargetMember(
  connection: PoolConnection,
  workspaceId: string,
  targetUserId: string,
): Promise<MemberRow> {
  const [rows] = await connection.query<MemberRow[]>(
    `SELECT memberships.role, users.status
     FROM memberships
     JOIN users ON users.id = memberships.user_id
     WHERE memberships.workspace_id = ? AND memberships.user_id = ?
     LIMIT 1
     FOR UPDATE`,
    [workspaceId, targetUserId],
  );
  const member = rows[0];
  if (!member) throw new UserNotFoundError();
  return member;
}

async function withTransaction<T>(pool: Pool, work: (connection: PoolConnection) => Promise<T>) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
