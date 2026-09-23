import { randomUUID } from 'node:crypto';

import type { Pool } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  bootstrapFirstAdmin,
  createMysqlPool,
  disableUserAccount,
  runMigrations,
  seedInitialWorkspace,
} from '@douyin/domain';

import { buildServer } from './server.js';

const databaseUrl = process.env.MYSQL_TEST_URL;
const describeWithMysql = databaseUrl ? describe : describe.skip;

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

describeWithMysql('浏览器登录与会话安全', () => {
  const workspaceId = '18000000-0000-4000-8000-000000000001';
  const credentials = {
    workspaceId,
    email: 'session-admin@example.test',
    displayName: '会话管理员',
    password: 'StrongSession2026',
  };
  const loginPayload = {
    workspaceId,
    email: credentials.email,
    password: credentials.password,
  };
  let pool: Pool;
  let userId: string;

  beforeAll(async () => {
    pool = createMysqlPool(databaseUrl!);
    await runMigrations(pool);
    await seedInitialWorkspace(pool, {
      workspaceId,
      workspaceSlug: 'session-auth-test',
      workspaceName: '会话认证测试',
    });
    userId = (await bootstrapFirstAdmin(pool, credentials)).userId;
  });

  afterAll(async () => {
    await pool.end();
  });

  it('登录签发安全 Cookie，受保护请求可读取当前成员', async () => {
    const server = buildServer({ pool, logger: false, secureCookies: true });
    const login = await server.inject({
      method: 'POST',
      url: '/auth/login',
      payload: loginPayload,
    });
    const setCookie = firstHeader(login.headers['set-cookie']);
    const cookieHeader = setCookie?.split(';')[0];

    expect(login.statusCode).toBe(200);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Strict');
    expect(cookieHeader).toBeTruthy();

    const me = await server.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie: cookieHeader! },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().csrfToken).toBe(login.json().csrfToken);
    expect(me.headers['cache-control']).toBe('no-store');
    expect(me.json().user).toEqual(
      expect.objectContaining({ id: userId, role: 'admin', workspaceId }),
    );
    await server.close();
  });

  it('状态变更请求需要 CSRF，退出后会话立即失效', async () => {
    const server = buildServer({ pool, logger: false, secureCookies: true });
    const login = await server.inject({
      method: 'POST',
      url: '/auth/login',
      payload: loginPayload,
    });
    const cookieHeader = firstHeader(login.headers['set-cookie'])?.split(';')[0];
    const csrfToken = login.json().csrfToken as string;

    const withoutCsrf = await server.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie: cookieHeader! },
    });
    expect(withoutCsrf.statusCode).toBe(403);

    const logout = await server.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie: cookieHeader!, 'x-csrf-token': csrfToken },
    });
    expect(logout.statusCode).toBe(204);
    const me = await server.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie: cookieHeader! },
    });
    expect(me.statusCode).toBe(401);
    await server.close();
  });

  it('停用账户会撤销现有会话并拒绝再次登录', async () => {
    const server = buildServer({ pool, logger: false, secureCookies: true });
    const login = await server.inject({
      method: 'POST',
      url: '/auth/login',
      payload: loginPayload,
    });
    const cookieHeader = firstHeader(login.headers['set-cookie'])?.split(';')[0];
    // 停用必须由另一名管理员执行：自我停用被护栏拒绝，且目标不能是最后一名启用管理员。
    const actorAdminId = randomUUID();
    await pool.execute(
      `INSERT INTO users (id, email, password_hash, display_name)
       VALUES (?, ?, 'integration-test-only', '停用操作管理员')`,
      [actorAdminId, `session-disable-actor-${actorAdminId}@example.test`],
    );
    await pool.execute(
      `INSERT INTO memberships (workspace_id, user_id, role) VALUES (?, ?, 'admin')`,
      [workspaceId, actorAdminId],
    );
    await disableUserAccount(pool, {
      actorUserId: actorAdminId,
      targetUserId: userId,
      workspaceId,
    });

    const me = await server.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie: cookieHeader! },
    });
    const loginAgain = await server.inject({
      method: 'POST',
      url: '/auth/login',
      payload: loginPayload,
    });
    expect(me.statusCode).toBe(401);
    expect(loginAgain.statusCode).toBe(401);
    await server.close();
  });
});
