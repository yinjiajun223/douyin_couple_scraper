import { createHash, randomUUID } from 'node:crypto';

import type { Pool, RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMysqlPool, runMigrations } from '../database/migrations.js';
import { seedInitialWorkspace } from '../database/seed.js';
import { bootstrapFirstAdmin } from './bootstrap-admin.js';
import {
  acceptInvitation,
  createInvitation,
  InvitationAlreadyUsedError,
  InvitationNotFoundError,
  InvitationRevokedError,
  listPendingInvitations,
  revokeInvitation,
} from './invitations.js';

const databaseUrl = process.env.MYSQL_TEST_URL;
const describeWithMysql = databaseUrl ? describe : describe.skip;

describeWithMysql('邀请列表与撤销', () => {
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const suffix = randomUUID().slice(0, 8);
  const password = 'StrongInvitation2026';
  const email = (name: string) => `invite-${name}-${suffix}@example.test`;
  let pool: Pool;
  let adminUserId = '';

  const invite = (name: string, role: 'admin' | 'operator' | 'readonly' = 'operator') =>
    createInvitation(pool, {
      workspaceId,
      email: email(name),
      role,
      invitedByUserId: adminUserId,
      expiresInSeconds: 3_600,
    });

  beforeAll(async () => {
    pool = createMysqlPool(databaseUrl!);
    await runMigrations(pool);
    for (const [id, name, slug] of [
      [workspaceId, '邀请管理测试', `invitation-test-${suffix}`],
      [otherWorkspaceId, '邀请越权测试', `invitation-other-${suffix}`],
    ] as const) {
      await seedInitialWorkspace(pool, {
        workspaceId: id,
        workspaceName: name,
        workspaceSlug: slug,
      });
    }
    adminUserId = (
      await bootstrapFirstAdmin(pool, {
        displayName: '邀请管理员',
        email: `invitation-admin-${suffix}@example.test`,
        password,
        workspaceId,
      })
    ).userId;
    const otherAdmin = await bootstrapFirstAdmin(pool, {
      displayName: '另一工作区管理员',
      email: `invitation-other-admin-${suffix}@example.test`,
      password,
      workspaceId: otherWorkspaceId,
    });
    expect(otherAdmin.userId).toBeTruthy();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('待处理邀请列表只返回元数据，不含任何令牌材料', async () => {
    const pending = await invite('pending');
    const pendingReadonly = await invite('pending-readonly', 'readonly');
    const accepted = await invite('accepted');
    const revoked = await invite('revoked');
    const expired = await invite('expired');

    await acceptInvitation(pool, {
      token: accepted.token,
      displayName: '已接受成员',
      password,
    });
    await revokeInvitation(pool, {
      actorUserId: adminUserId,
      invitationId: revoked.invitationId,
      workspaceId,
    });
    await pool.execute(
      'UPDATE invitations SET expires_at = DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 1 HOUR) WHERE id = ?',
      [expired.invitationId],
    );

    const invitations = await listPendingInvitations(pool, workspaceId);
    expect(invitations.map((invitation) => invitation.email).sort()).toEqual(
      [email('pending'), email('pending-readonly')].sort(),
    );
    const listed = invitations.find((invitation) => invitation.id === pending.invitationId);
    expect(listed).toMatchObject({
      email: email('pending'),
      invitedByDisplayName: '邀请管理员',
      role: 'operator',
    });
    expect(listed?.invitedAt).toBeInstanceOf(Date);
    expect(listed?.expiresAt).toBeInstanceOf(Date);
    expect(invitations.find((item) => item.id === pendingReadonly.invitationId)?.role).toBe(
      'readonly',
    );

    // 令牌明文与哈希都不得出现在响应里：列表是管理员界面数据，泄露即等于交出建号能力。
    const serialized = JSON.stringify(invitations);
    expect(serialized).not.toContain(pending.token);
    expect(serialized).not.toContain(createHash('sha256').update(pending.token).digest('hex'));
    for (const invitation of invitations) {
      expect(Object.keys(invitation).sort()).toEqual([
        'email',
        'expiresAt',
        'id',
        'invitedAt',
        'invitedByDisplayName',
        'role',
      ]);
    }
  });

  it('撤销写入审计，已接受与已撤销的邀请不能再次撤销', async () => {
    const target = await invite('revoke-target');
    const result = await revokeInvitation(pool, {
      actorUserId: adminUserId,
      invitationId: target.invitationId,
      workspaceId,
    });
    expect(result).toEqual({ invitationId: target.invitationId, revoked: true });

    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT revoked_at, accepted_at, expires_at FROM invitations WHERE id = ?',
      [target.invitationId],
    );
    expect(rows[0]?.revoked_at).toBeInstanceOf(Date);
    expect(rows[0]?.accepted_at).toBeNull();
    // 撤销不销毁原始过期时间，审计才能区分「自然过期」与「主动撤销」。
    expect(rows[0]?.expires_at).toBeInstanceOf(Date);

    const [audits] = await pool.query<RowDataPacket[]>(
      `SELECT actor_user_id, summary_json FROM audit_events
       WHERE workspace_id = ? AND action = 'account.invitation_revoked' AND subject_id = ?`,
      [workspaceId, target.invitationId],
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]?.actor_user_id).toBe(adminUserId);
    expect(audits[0]?.summary_json).toMatchObject({
      email: email('revoke-target'),
      role: 'operator',
    });

    await expect(
      revokeInvitation(pool, {
        actorUserId: adminUserId,
        invitationId: target.invitationId,
        workspaceId,
      }),
    ).rejects.toBeInstanceOf(InvitationRevokedError);

    const used = await invite('already-used');
    await acceptInvitation(pool, { token: used.token, displayName: '已接受成员乙', password });
    await expect(
      revokeInvitation(pool, {
        actorUserId: adminUserId,
        invitationId: used.invitationId,
        workspaceId,
      }),
    ).rejects.toBeInstanceOf(InvitationAlreadyUsedError);

    const pending = await invite('not-found-probe');
    await expect(
      revokeInvitation(pool, {
        actorUserId: adminUserId,
        invitationId: randomUUID(),
        workspaceId,
      }),
    ).rejects.toBeInstanceOf(InvitationNotFoundError);
    // 跨工作区按不存在处理，撤销不到别的工作区的邀请。
    await expect(
      revokeInvitation(pool, {
        actorUserId: adminUserId,
        invitationId: pending.invitationId,
        workspaceId: otherWorkspaceId,
      }),
    ).rejects.toBeInstanceOf(InvitationNotFoundError);
    const [untouched] = await pool.query<RowDataPacket[]>(
      'SELECT revoked_at FROM invitations WHERE id = ?',
      [pending.invitationId],
    );
    expect(untouched[0]?.revoked_at).toBeNull();
  });

  it('已撤销的邀请无法完成账户设置，也不留下任何成员记录', async () => {
    const target = await invite('revoked-accept');
    await revokeInvitation(pool, {
      actorUserId: adminUserId,
      invitationId: target.invitationId,
      workspaceId,
    });

    await expect(
      acceptInvitation(pool, { token: target.token, displayName: '不应创建成员', password }),
    ).rejects.toBeInstanceOf(InvitationRevokedError);

    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT (SELECT COUNT(*) FROM users WHERE email = ?)
            + (SELECT COUNT(*) FROM memberships WHERE workspace_id = ?
                AND user_id IN (SELECT id FROM users WHERE email = ?)) AS total`,
      [email('revoked-accept'), workspaceId, email('revoked-accept')],
    );
    expect(Number(rows[0]?.total)).toBe(0);
    const [invitation] = await pool.query<RowDataPacket[]>(
      'SELECT accepted_at, accepted_by_user_id FROM invitations WHERE id = ?',
      [target.invitationId],
    );
    expect(invitation[0]?.accepted_at).toBeNull();
    expect(invitation[0]?.accepted_by_user_id).toBeNull();
  });
});
