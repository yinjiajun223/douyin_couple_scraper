import type { Pool } from 'mysql2/promise';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  acceptInvitation,
  bootstrapFirstAdmin,
  createInvitation,
  createMysqlPool,
  runMigrations,
  seedInitialWorkspace,
} from '@douyin/domain';
import type { Permission } from '@douyin/domain';

import { authorizeBrowserRequest, buildServer } from './server.js';

const databaseUrl = process.env.MYSQL_TEST_URL;
const describeWithMysql = databaseUrl ? describe : describe.skip;

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

describeWithMysql('角色 API 权限矩阵', () => {
  const workspaceId = '1a000000-0000-4000-8000-000000000001';
  const password = 'StrongRolePassword2026';
  const accounts = {
    admin: 'role-admin@example.test',
    operator: 'role-operator@example.test',
    operatorB: 'role-operator-b@example.test',
    readonly: 'role-readonly@example.test',
  } as const;
  let pool: Pool;
  let operatorUserId = '';

  beforeAll(async () => {
    pool = createMysqlPool(databaseUrl!);
    await runMigrations(pool);
    await seedInitialWorkspace(pool, {
      workspaceId,
      workspaceSlug: 'role-api-test',
      workspaceName: '角色API测试',
    });
    const admin = await bootstrapFirstAdmin(pool, {
      workspaceId,
      email: accounts.admin,
      displayName: '权限管理员',
      password,
    });

    for (const role of ['operator', 'readonly'] as const) {
      const invitation = await createInvitation(pool, {
        workspaceId,
        email: accounts[role],
        role,
        invitedByUserId: admin.userId,
        expiresInSeconds: 3600,
      });
      const accepted = await acceptInvitation(pool, {
        token: invitation.token,
        displayName: role === 'operator' ? '权限运营' : '权限只读',
        password,
      });
      if (role === 'operator') operatorUserId = accepted.userId;
    }
    const operatorBInvitation = await createInvitation(pool, {
      workspaceId,
      email: accounts.operatorB,
      role: 'operator',
      invitedByUserId: admin.userId,
      expiresInSeconds: 3600,
    });
    await acceptInvitation(pool, {
      token: operatorBInvitation.token,
      displayName: '权限运营乙',
      password,
    });

    const ids = {
      campaign: '1a000000-0000-4000-8000-000000000010',
      rule: '1a000000-0000-4000-8000-000000000011',
      run: '1a000000-0000-4000-8000-000000000012',
      device: '1a000000-0000-4000-8000-000000000013',
      creator: '1a000000-0000-4000-8000-000000000014',
      observation: '1a000000-0000-4000-8000-000000000015',
      candidate: '1a000000-0000-4000-8000-000000000016',
      media: '1a000000-0000-4000-8000-000000000017',
    };
    await pool.execute(
      `INSERT INTO devices (id, workspace_id, owner_user_id, name, token_hash)
       VALUES (?, ?, ?, '权限范围设备', ?)`,
      [ids.device, workspaceId, operatorUserId, `${'1'.repeat(63)}f`],
    );
    await pool.execute(
      `INSERT INTO campaigns
       (id, workspace_id, name, rule_schema_version, rules_json, created_by_user_id)
       VALUES (?, ?, '权限范围任务', 1, '{}', ?)`,
      [ids.campaign, workspaceId, admin.userId],
    );
    await pool.execute(
      `INSERT INTO campaign_rule_versions
       (id, workspace_id, campaign_id, version, rule_schema_version, rules_json, created_by_user_id)
       VALUES (?, ?, ?, 1, 1, '{}', ?)`,
      [ids.rule, workspaceId, ids.campaign, admin.userId],
    );
    await pool.execute(
      `INSERT INTO collection_runs
       (id, workspace_id, campaign_id, rule_version_id, progress_json, created_by_user_id)
       VALUES (?, ?, ?, ?, '{}', ?)`,
      [ids.run, workspaceId, ids.campaign, ids.rule, operatorUserId],
    );
    await pool.execute(
      `INSERT INTO creators
       (id, workspace_id, platform, platform_creator_id, first_observed_at, last_observed_at)
       VALUES (?, ?, 'douyin', 'api-scope-creator', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
      [ids.creator, workspaceId],
    );
    await pool.execute(
      `INSERT INTO creator_observations
       (id, workspace_id, creator_id, run_id, device_id, nickname, profile_url,
        parser_confidence, collector_version, parser_version, observed_at)
       VALUES (?, ?, ?, ?, ?, '运营甲私有达人', 'https://www.douyin.com/user/api-scope-creator',
               0.99, '1.0.0', '1.0.0', CURRENT_TIMESTAMP(3))`,
      [ids.observation, workspaceId, ids.creator, ids.run, ids.device],
    );
    await pool.execute(
      `INSERT INTO run_creator_sources
       (workspace_id, run_id, creator_id, device_id, first_observation_id,
        first_observed_at, last_observed_at, observation_count)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3), 1)`,
      [workspaceId, ids.run, ids.creator, ids.device, ids.observation],
    );
    await pool.execute(
      `INSERT INTO campaign_candidates
       (id, workspace_id, campaign_id, creator_id, latest_run_id,
        latest_creator_observation_id, hard_filter_status)
       VALUES (?, ?, ?, ?, ?, ?, 'pass')`,
      [ids.candidate, workspaceId, ids.campaign, ids.creator, ids.run, ids.observation],
    );
    await pool.execute(
      `INSERT INTO media_objects
       (id, workspace_id, creator_observation_id, object_key, purpose, mime_type,
        byte_size, checksum_sha256, status, confirmed_at)
       VALUES (?, ?, ?, 'api-scope/private.webp', 'profile_screenshot', 'image/webp',
               100, ?, 'confirmed', CURRENT_TIMESTAMP(3))`,
      [ids.media, workspaceId, ids.observation, 'f'.repeat(64)],
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  async function createAuthorizationServer() {
    const server = buildServer({ pool, logger: false, secureCookies: true });
    const addProbe = (path: string, permission: Permission, requireCsrf: boolean) => {
      server.route({
        method: requireCsrf ? 'POST' : 'GET',
        url: path,
        handler: async (request, reply) => {
          const principal = await authorizeBrowserRequest(
            pool,
            request,
            reply,
            permission,
            requireCsrf,
          );
          if (!principal) return;
          return reply.code(requireCsrf ? 204 : 200).send({ role: principal.role });
        },
      });
    };
    addProbe('/test/campaign-write', 'campaign:write', true);
    addProbe('/test/candidate-read', 'candidate:read', false);
    addProbe('/test/ai-connection-manage', 'ai-connection:manage', true);
    return server;
  }

  async function login(
    server: FastifyInstance,
    role: keyof typeof accounts,
  ): Promise<{ cookie: string; csrfToken: string }> {
    const response = await server.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { workspaceId, email: accounts[role], password },
    });
    return {
      cookie: firstHeader(response.headers['set-cookie'])!.split(';')[0]!,
      csrfToken: response.json().csrfToken as string,
    };
  }

  it('管理员可管理系统连接，运营仅可写业务，只读仅可读', async () => {
    const server = await createAuthorizationServer();
    const admin = await login(server, 'admin');
    const operator = await login(server, 'operator');
    const readonly = await login(server, 'readonly');

    const adminAi = await server.inject({
      method: 'POST',
      url: '/test/ai-connection-manage',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
    });
    const operatorCampaign = await server.inject({
      method: 'POST',
      url: '/test/campaign-write',
      headers: { cookie: operator.cookie, 'x-csrf-token': operator.csrfToken },
    });
    const operatorAi = await server.inject({
      method: 'POST',
      url: '/test/ai-connection-manage',
      headers: { cookie: operator.cookie, 'x-csrf-token': operator.csrfToken },
    });
    const readonlyRead = await server.inject({
      method: 'GET',
      url: '/test/candidate-read',
      headers: { cookie: readonly.cookie },
    });
    const readonlyWrite = await server.inject({
      method: 'POST',
      url: '/test/campaign-write',
      headers: { cookie: readonly.cookie, 'x-csrf-token': readonly.csrfToken },
    });
    const readonlyOutreachWrite = await server.inject({
      method: 'PUT',
      url: '/candidates/00000000-0000-4000-8000-000000000999/outreach',
      headers: { cookie: readonly.cookie, 'x-csrf-token': readonly.csrfToken },
      payload: { expectedVersion: 0, nextAction: '不应写入' },
    });
    const adminAudit = await server.inject({
      method: 'GET',
      url: '/audit-events',
      headers: { cookie: admin.cookie },
    });
    const operatorAudit = await server.inject({
      method: 'GET',
      url: '/audit-events',
      headers: { cookie: operator.cookie },
    });
    const operatorTemplates = await server.inject({
      method: 'GET',
      url: '/campaign-templates',
      headers: { cookie: operator.cookie },
    });
    const operatorAssignees = await server.inject({
      method: 'GET',
      url: '/members/assignable',
      headers: { cookie: operator.cookie },
    });
    const readonlyAssignees = await server.inject({
      method: 'GET',
      url: '/members/assignable',
      headers: { cookie: readonly.cookie },
    });

    expect(adminAi.statusCode).toBe(204);
    expect(operatorCampaign.statusCode).toBe(204);
    expect(operatorAi.statusCode).toBe(403);
    expect(readonlyRead.statusCode).toBe(200);
    expect(readonlyWrite.statusCode).toBe(403);
    expect(readonlyOutreachWrite.statusCode).toBe(403);
    expect(adminAudit.statusCode).toBe(200);
    expect(operatorAudit.statusCode).toBe(403);
    expect(operatorTemplates.statusCode).toBe(403);
    expect(operatorAssignees.statusCode).toBe(200);
    expect(operatorAssignees.json().members).toHaveLength(4);
    for (const member of operatorAssignees.json().members as Record<string, unknown>[]) {
      expect(Object.keys(member).sort()).toEqual(['displayName', 'id']);
    }
    expect(readonlyAssignees.statusCode).toBe(403);
    await server.close();
  });

  it('候选列表、详情、导出、截图、AI 与写接口都拒绝跨运营访问', async () => {
    const server = buildServer({
      pool,
      logger: false,
      objectStorage: {
        createSignedGetUrl: async ({ objectKey }) => `https://oss.example/${objectKey}`,
        createSignedPutUrl: async () => '',
        deleteObject: async () => undefined,
        headObject: async () => ({
          byteSize: 100,
          checksumSha256: 'f'.repeat(64),
          contentType: 'image/webp',
          etag: 'etag',
        }),
      },
      secureCookies: true,
    });
    const operatorA = await login(server, 'operator');
    const operatorB = await login(server, 'operatorB');
    const admin = await login(server, 'admin');
    const candidateId = '1a000000-0000-4000-8000-000000000016';
    const mediaId = '1a000000-0000-4000-8000-000000000017';

    const listA = await server.inject({
      method: 'GET',
      url: '/candidates',
      headers: { cookie: operatorA.cookie },
    });
    const listB = await server.inject({
      method: 'GET',
      url: '/candidates',
      headers: { cookie: operatorB.cookie },
    });
    const adminAsA = await server.inject({
      method: 'GET',
      url: `/candidates?memberUserId=${operatorUserId}`,
      headers: { cookie: admin.cookie },
    });
    expect(listA.json().candidates).toHaveLength(1);
    expect(listB.json().candidates).toEqual([]);
    expect(adminAsA.json().candidates).toHaveLength(1);

    const readOnlyRequests = await Promise.all([
      server.inject({
        method: 'GET',
        url: `/candidates/${candidateId}`,
        headers: { cookie: operatorB.cookie },
      }),
      server.inject({
        method: 'GET',
        url: `/media/${mediaId}/access`,
        headers: { cookie: operatorB.cookie },
      }),
    ]);
    expect(readOnlyRequests.map((response) => response.statusCode)).toEqual([404, 404]);

    const csrfHeaders = {
      cookie: operatorB.cookie,
      'x-csrf-token': operatorB.csrfToken,
    };
    const writeRequests = await Promise.all([
      server.inject({
        method: 'POST',
        url: `/candidates/${candidateId}/reviews`,
        headers: csrfHeaders,
        payload: { decision: 'approved', expectedVersion: 1, reason: '不应成功' },
      }),
      server.inject({
        method: 'POST',
        url: `/candidates/${candidateId}/pipeline`,
        headers: csrfHeaders,
        payload: { expectedVersion: 1, nextStatus: 'to_contact' },
      }),
      server.inject({
        method: 'PUT',
        url: `/candidates/${candidateId}/outreach`,
        headers: csrfHeaders,
        payload: { expectedVersion: 0, nextAction: '不应成功' },
      }),
      server.inject({
        method: 'POST',
        url: `/candidates/${candidateId}/notes`,
        headers: csrfHeaders,
        payload: { body: '不应成功' },
      }),
      server.inject({
        method: 'POST',
        url: `/candidates/${candidateId}/ai-analyses`,
        headers: csrfHeaders,
      }),
    ]);
    expect(writeRequests.map((response) => response.statusCode)).toEqual([404, 404, 404, 404, 404]);

    const exported = await server.inject({
      method: 'GET',
      url: '/exports/candidates.csv',
      headers: { cookie: operatorB.cookie },
    });
    const dashboard = await server.inject({
      method: 'GET',
      url: '/dashboard',
      headers: { cookie: operatorB.cookie },
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.body).not.toContain('运营甲私有达人');
    expect(dashboard.json()).toMatchObject({ pendingReview: 0, toContact: 0 });
    await server.close();
  });
});
