import type { Pool, RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  bootstrapFirstAdmin,
  createMysqlPool,
  runMigrations,
  seedInitialWorkspace,
} from '@douyin/domain';

import { buildServer } from './server.js';

const databaseUrl = process.env.MYSQL_TEST_URL;
const describeWithMysql = databaseUrl ? describe : describe.skip;

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

describeWithMysql('邀请制账户流程', () => {
  const workspaceId = '19000000-0000-4000-8000-000000000001';
  const adminCredentials = {
    workspaceId,
    email: 'invite-admin@example.test',
    displayName: '邀请管理员',
    password: 'StrongInviteAdmin2026',
  };
  let pool: Pool;

  beforeAll(async () => {
    pool = createMysqlPool(databaseUrl!);
    await runMigrations(pool);
    await seedInitialWorkspace(pool, {
      workspaceId,
      workspaceSlug: 'invitation-test',
      workspaceName: '邀请流程测试',
    });
    await bootstrapFirstAdmin(pool, adminCredentials);
  });

  afterAll(async () => {
    await pool.end();
  });

  async function adminSession() {
    const server = buildServer({ pool, logger: false, secureCookies: true });
    const login = await server.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {
        workspaceId,
        email: adminCredentials.email,
        password: adminCredentials.password,
      },
    });
    return {
      server,
      cookie: firstHeader(login.headers['set-cookie'])?.split(';')[0],
      csrfToken: login.json().csrfToken as string,
    };
  }

  it('管理员创建邀请，成员接受后邀请立即失效', async () => {
    const { server, cookie, csrfToken } = await adminSession();
    const created = await server.inject({
      method: 'POST',
      url: '/invitations',
      headers: { cookie: cookie!, 'x-csrf-token': csrfToken },
      payload: { email: 'operator.invited@example.test', role: 'operator', expiresInHours: 24 },
    });
    expect(created.statusCode).toBe(201);
    const token = created.json().token as string;

    const accepted = await server.inject({
      method: 'POST',
      url: '/auth/invitations/accept',
      payload: { token, displayName: '受邀运营', password: 'StrongOperator2026' },
    });
    expect(accepted.statusCode).toBe(201);
    expect(accepted.json()).toEqual(expect.objectContaining({ workspaceId, role: 'operator' }));

    const reused = await server.inject({
      method: 'POST',
      url: '/auth/invitations/accept',
      payload: { token, displayName: '重复使用', password: 'StrongOperator2026' },
    });
    expect(reused.statusCode).toBe(409);

    const memberLogin = await server.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {
        workspaceId,
        email: 'operator.invited@example.test',
        password: 'StrongOperator2026',
      },
    });
    expect(memberLogin.statusCode).toBe(200);
    expect(memberLogin.json().user.role).toBe('operator');
    await server.close();
  });

  it('过期邀请不能创建成员', async () => {
    const { server, cookie, csrfToken } = await adminSession();
    const created = await server.inject({
      method: 'POST',
      url: '/invitations',
      headers: { cookie: cookie!, 'x-csrf-token': csrfToken },
      payload: { email: 'expired.invited@example.test', role: 'readonly', expiresInHours: 1 },
    });
    await pool.execute(
      `UPDATE invitations SET expires_at = '2020-01-01 00:00:00.000' WHERE id = ?`,
      [created.json().invitationId],
    );

    const accepted = await server.inject({
      method: 'POST',
      url: '/auth/invitations/accept',
      payload: {
        token: created.json().token,
        displayName: '过期成员',
        password: 'StrongReadonly2026',
      },
    });
    expect(accepted.statusCode).toBe(410);
    const [users] = await pool.query<RowDataPacket[]>(
      "SELECT id FROM users WHERE email = 'expired.invited@example.test'",
    );
    expect(users).toHaveLength(0);
    await server.close();
  });

  it('未获邀请的公开注册请求不存在且不会写入账户', async () => {
    const server = buildServer({ pool, logger: false, secureCookies: true });
    const response = await server.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        workspaceId,
        email: 'uninvited@example.test',
        displayName: '未邀请用户',
        password: 'StrongUninvited2026',
      },
    });
    expect(response.statusCode).toBe(404);
    const [users] = await pool.query<RowDataPacket[]>(
      "SELECT id FROM users WHERE email = 'uninvited@example.test'",
    );
    expect(users).toHaveLength(0);
    await server.close();
  });
  it('撤销后的邀请从列表消失、不能再撤销，接受时返回 410', async () => {
    const { server, cookie, csrfToken } = await adminSession();
    const created = await server.inject({
      method: 'POST',
      url: '/invitations',
      headers: { cookie: cookie!, 'x-csrf-token': csrfToken },
      payload: { email: 'revoked.invited@example.test', role: 'operator', expiresInHours: 24 },
    });
    const invitationId = created.json().invitationId as string;
    const token = created.json().token as string;

    const listed = await server.inject({
      method: 'GET',
      url: '/invitations',
      headers: { cookie: cookie! },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().invitations.map((item: { id: string }) => item.id)).toContain(
      invitationId,
    );
    // 列表响应不含令牌明文，也不含令牌哈希。
    expect(JSON.stringify(listed.json())).not.toContain(token);

    const withoutCsrf = await server.inject({
      method: 'POST',
      url: `/invitations/${invitationId}/revoke`,
      headers: { cookie: cookie! },
    });
    expect(withoutCsrf.statusCode).toBe(403);

    const revoked = await server.inject({
      method: 'POST',
      url: `/invitations/${invitationId}/revoke`,
      headers: { cookie: cookie!, 'x-csrf-token': csrfToken },
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toEqual({ invitationId, revoked: true });

    const again = await server.inject({
      method: 'POST',
      url: `/invitations/${invitationId}/revoke`,
      headers: { cookie: cookie!, 'x-csrf-token': csrfToken },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: 'INVITATION_REVOKED' });

    const afterRevoke = await server.inject({
      method: 'GET',
      url: '/invitations',
      headers: { cookie: cookie! },
    });
    expect(afterRevoke.json().invitations.map((item: { id: string }) => item.id)).not.toContain(
      invitationId,
    );

    const accepted = await server.inject({
      method: 'POST',
      url: '/auth/invitations/accept',
      payload: { token, displayName: '撤销后成员', password: 'StrongOperator2026' },
    });
    expect(accepted.statusCode).toBe(410);
    expect(accepted.json()).toMatchObject({ code: 'INVITATION_REVOKED' });
    const [users] = await pool.query<RowDataPacket[]>(
      "SELECT id FROM users WHERE email = 'revoked.invited@example.test'",
    );
    expect(users).toHaveLength(0);
    await server.close();
  });
});
