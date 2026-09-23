import { createHash, randomUUID } from 'node:crypto';

import type { Pool, RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMysqlPool, runMigrations } from '../database/migrations.js';
import { seedInitialWorkspace } from '../database/seed.js';
import { bootstrapFirstAdmin } from './bootstrap-admin.js';
import { authenticateDevice } from './devices.js';
import { acceptInvitation, createInvitation } from './invitations.js';
import {
  changeMemberRole,
  disableUserAccount,
  enableUserAccount,
  LastActiveAdminError,
  SelfDisableError,
} from './members.js';
import { authenticateSession, loginWithPassword } from './sessions.js';

const databaseUrl = process.env.MYSQL_TEST_URL;
const describeWithMysql = databaseUrl ? describe : describe.skip;

describeWithMysql('成员生命周期', () => {
  // 全部 ID 与邮箱都是运行时随机的：成员用例要反复停用/启用，
  // 固定夹具会与其他套件在同一测试库里互相踩。
  const workspaceId = randomUUID();
  const suffix = randomUUID().slice(0, 8);
  const password = 'StrongMemberLifecycle2026';
  const deviceToken = `device-${randomUUID()}`;
  const deviceId = randomUUID();
  let pool: Pool;
  let adminA = '';
  let adminB = '';
  let operatorC = '';
  let readonlyD = '';

  const readMember = async (userId: string) => {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT users.status, memberships.role FROM memberships
       JOIN users ON users.id = memberships.user_id
       WHERE memberships.workspace_id = ? AND memberships.user_id = ?`,
      [workspaceId, userId],
    );
    return rows[0];
  };

  const readAudit = async (action: string, subjectId: string) => {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT actor_user_id, summary_json FROM audit_events
       WHERE workspace_id = ? AND action = ? AND subject_id = ?
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [workspaceId, action, subjectId],
    );
    return rows[0];
  };

  beforeAll(async () => {
    pool = createMysqlPool(databaseUrl!);
    await runMigrations(pool);
    await seedInitialWorkspace(pool, {
      workspaceId,
      workspaceName: '成员生命周期测试',
      workspaceSlug: `member-lifecycle-${suffix}`,
    });
    adminA = (
      await bootstrapFirstAdmin(pool, {
        displayName: '成员管理员甲',
        email: `member-admin-a-${suffix}@example.test`,
        password,
        workspaceId,
      })
    ).userId;

    const invited: Record<string, string> = {};
    for (const [key, role, name] of [
      ['adminB', 'admin', '成员管理员乙'],
      ['operatorC', 'operator', '成员运营丙'],
      ['readonlyD', 'readonly', '成员只读丁'],
    ] as const) {
      const invitation = await createInvitation(pool, {
        workspaceId,
        email: `member-${key.toLowerCase()}-${suffix}@example.test`,
        role,
        invitedByUserId: adminA,
        expiresInSeconds: 3_600,
      });
      invited[key] = (
        await acceptInvitation(pool, {
          token: invitation.token,
          displayName: name,
          password,
        })
      ).userId;
    }
    adminB = invited.adminB!;
    operatorC = invited.operatorC!;
    readonlyD = invited.readonlyD!;

    await pool.execute(
      `INSERT INTO devices (id, workspace_id, owner_user_id, name, token_hash)
       VALUES (?, ?, ?, '丙的采集设备', ?)`,
      [deviceId, workspaceId, operatorC, createHash('sha256').update(deviceToken).digest('hex')],
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  it('停用写入执行操作的管理员，并级联撤销会话与设备', async () => {
    const login = await loginWithPassword(pool, {
      workspaceId,
      email: `member-operatorc-${suffix}@example.test`,
      password,
    });
    expect(await authenticateDevice(pool, deviceToken)).toMatchObject({ deviceId });

    await disableUserAccount(pool, {
      actorUserId: adminA,
      targetUserId: operatorC,
      workspaceId,
    });

    expect(await readMember(operatorC)).toMatchObject({ role: 'operator', status: 'disabled' });
    // 会话立即失效：既有令牌读不到 principal，重新登录也被拒绝。
    expect(await authenticateSession(pool, login.sessionToken)).toBeNull();
    await expect(
      loginWithPassword(pool, {
        workspaceId,
        email: `member-operatorc-${suffix}@example.test`,
        password,
      }),
    ).rejects.toThrow();
    // 设备被级联撤销，令牌不再可用。
    const [devices] = await pool.query<RowDataPacket[]>(
      'SELECT status, revoked_at FROM devices WHERE id = ?',
      [deviceId],
    );
    expect(devices[0]?.status).toBe('revoked');
    expect(devices[0]?.revoked_at).toBeInstanceOf(Date);
    expect(await authenticateDevice(pool, deviceToken)).toBeNull();

    const audit = await readAudit('account.disabled', operatorC);
    expect(audit?.actor_user_id).toBe(adminA);
    expect(audit?.summary_json).toMatchObject({ devicesRevoked: 1, sessionsRevoked: 1 });
  });

  it('护栏拒绝自我停用，也拒绝让工作区失去最后一名启用管理员', async () => {
    await expect(
      disableUserAccount(pool, {
        actorUserId: adminA,
        targetUserId: adminA,
        workspaceId,
      }),
    ).rejects.toBeInstanceOf(SelfDisableError);

    // 乙仍是启用管理员时，降级甲不会被拦；先把乙降级，甲就成了最后一名。
    await changeMemberRole(pool, {
      actorUserId: adminA,
      targetUserId: adminB,
      role: 'operator',
      workspaceId,
    });
    expect(await readMember(adminB)).toMatchObject({ role: 'operator', status: 'active' });

    await expect(
      changeMemberRole(pool, {
        actorUserId: adminB,
        targetUserId: adminA,
        role: 'operator',
        workspaceId,
      }),
    ).rejects.toBeInstanceOf(LastActiveAdminError);
    await expect(
      disableUserAccount(pool, {
        actorUserId: adminB,
        targetUserId: adminA,
        workspaceId,
      }),
    ).rejects.toBeInstanceOf(LastActiveAdminError);

    expect(await readMember(adminA)).toMatchObject({ role: 'admin', status: 'active' });
    const [leaks] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS total FROM audit_events
       WHERE workspace_id = ? AND subject_id = ?
         AND action IN ('account.disabled', 'account.role_changed')`,
      [workspaceId, adminA],
    );
    expect(Number(leaks[0]?.total)).toBe(0);

    // 恢复乙的管理员身份，供后续并发用例使用。
    await changeMemberRole(pool, {
      actorUserId: adminA,
      targetUserId: adminB,
      role: 'admin',
      workspaceId,
    });
    expect(await readMember(adminB)).toMatchObject({ role: 'admin', status: 'active' });
  });

  it('启用只恢复账户状态，不复活被撤销的设备', async () => {
    await enableUserAccount(pool, {
      actorUserId: adminA,
      targetUserId: operatorC,
      workspaceId,
    });

    expect(await readMember(operatorC)).toMatchObject({ role: 'operator', status: 'active' });
    // 本人可以重新登录，但设备仍是 revoked，必须在本机重新配对。
    await expect(
      loginWithPassword(pool, {
        workspaceId,
        email: `member-operatorc-${suffix}@example.test`,
        password,
      }),
    ).resolves.toMatchObject({ principal: { role: 'operator' } });
    const [devices] = await pool.query<RowDataPacket[]>(
      'SELECT status, revoked_at FROM devices WHERE id = ?',
      [deviceId],
    );
    expect(devices[0]?.status).toBe('revoked');
    expect(devices[0]?.revoked_at).toBeInstanceOf(Date);
    expect(await authenticateDevice(pool, deviceToken)).toBeNull();

    const audit = await readAudit('account.enabled', operatorC);
    expect(audit?.actor_user_id).toBe(adminA);
    expect(audit?.summary_json).toMatchObject({ devicesRestored: false });
  });

  it('角色变更对已登录成员的既有会话即时生效', async () => {
    const login = await loginWithPassword(pool, {
      workspaceId,
      email: `member-readonlyd-${suffix}@example.test`,
      password,
    });
    expect(await authenticateSession(pool, login.sessionToken)).toMatchObject({
      role: 'readonly',
    });

    await changeMemberRole(pool, {
      actorUserId: adminA,
      targetUserId: readonlyD,
      role: 'operator',
      workspaceId,
    });

    // 不重新登录、不撤销会话：角色是每次请求从数据库解析的。
    expect(await authenticateSession(pool, login.sessionToken)).toMatchObject({
      role: 'operator',
      userId: readonlyD,
    });
    const audit = await readAudit('account.role_changed', readonlyD);
    expect(audit?.actor_user_id).toBe(adminA);
    expect(audit?.summary_json).toMatchObject({ from: 'readonly', to: 'operator' });
  });

  it('两名管理员并发互相降级时只有一人成功，工作区不会失去管理员', async () => {
    const outcomes = await Promise.allSettled([
      changeMemberRole(pool, {
        actorUserId: adminA,
        targetUserId: adminB,
        role: 'operator',
        workspaceId,
      }),
      changeMemberRole(pool, {
        actorUserId: adminB,
        targetUserId: adminA,
        role: 'operator',
        workspaceId,
      }),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(rejected?.status).toBe('rejected');
    expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(LastActiveAdminError);

    const [admins] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS total FROM memberships
       JOIN users ON users.id = memberships.user_id
       WHERE memberships.workspace_id = ? AND memberships.role = 'admin'
         AND users.status = 'active'`,
      [workspaceId],
    );
    expect(Number(admins[0]?.total)).toBe(1);
  });
});
