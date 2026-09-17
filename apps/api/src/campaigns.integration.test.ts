import type { Pool } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDefaultCampaignRuleSet } from '@douyin/contracts';
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

describeWithMysql('筛选模板与任务 API', () => {
  const workspaceId = '1d000000-0000-4000-8000-000000000001';
  const credentials = {
    workspaceId,
    email: 'campaign-admin@example.test',
    displayName: '任务管理员',
    password: 'StrongCampaignAdmin2026',
  };
  let pool: Pool;

  beforeAll(async () => {
    pool = createMysqlPool(databaseUrl!);
    await runMigrations(pool);
    await seedInitialWorkspace(pool, {
      workspaceId,
      workspaceSlug: 'campaign-api-test',
      workspaceName: '任务API测试',
    });
    await bootstrapFirstAdmin(pool, credentials);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('从模板创建任务，复制后修改与归档不影响来源', async () => {
    const server = buildServer({ pool, logger: false, secureCookies: true });
    const login = await server.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {
        workspaceId,
        email: credentials.email,
        password: credentials.password,
      },
    });
    const headers = {
      cookie: firstHeader(login.headers['set-cookie'])!.split(';')[0]!,
      'x-csrf-token': login.json().csrfToken as string,
    };
    const originalRules = createDefaultCampaignRuleSet();
    const template = await server.inject({
      method: 'POST',
      url: '/campaign-templates',
      headers,
      payload: { name: '校园素人模板', description: '用于校园圈层', rules: originalRules },
    });
    expect(template.statusCode).toBe(201);

    const original = await server.inject({
      method: 'POST',
      url: '/campaigns',
      headers,
      payload: {
        name: '九月校园任务',
        recommendationProfileDescription: '校园日常与宿舍生活',
        templateId: template.json().id,
      },
    });
    expect(original.statusCode).toBe(201);

    const copied = await server.inject({
      method: 'POST',
      url: `/campaigns/${original.json().id}/copy`,
      headers,
      payload: { name: '十月校园任务' },
    });
    expect(copied.statusCode).toBe(201);

    const changedRules = createDefaultCampaignRuleSet();
    const followerRule = changedRules.hardRules.find((rule) => rule.type === 'follower-range');
    if (followerRule?.type === 'follower-range') followerRule.max = 8000;
    const changed = await server.inject({
      method: 'PATCH',
      url: `/campaigns/${copied.json().id}`,
      headers,
      payload: { expectedVersion: 1, rules: changedRules },
    });
    expect(changed.statusCode).toBe(200);

    const archived = await server.inject({
      method: 'POST',
      url: `/campaigns/${copied.json().id}/archive`,
      headers,
    });
    expect(archived.statusCode).toBe(200);

    const listed = await server.inject({ method: 'GET', url: '/campaigns', headers });
    const campaigns = listed.json().campaigns as Array<{
      id: string;
      rules_json: ReturnType<typeof createDefaultCampaignRuleSet>;
      status: string;
    }>;
    const originalCampaign = campaigns.find((item) => item.id === original.json().id);
    const copiedCampaign = campaigns.find((item) => item.id === copied.json().id);
    expect(originalCampaign?.status).toBe('active');
    expect(originalCampaign?.rules_json.hardRules).toContainEqual(
      expect.objectContaining({ type: 'follower-range', max: 5000 }),
    );
    expect(copiedCampaign?.status).toBe('archived');
    expect(copiedCampaign?.rules_json.hardRules).toContainEqual(
      expect.objectContaining({ type: 'follower-range', max: 8000 }),
    );

    const templates = await server.inject({ method: 'GET', url: '/campaign-templates', headers });
    const createdTemplate = (
      templates.json().templates as Array<{ id: string; rules_json: typeof originalRules }>
    ).find((item) => item.id === template.json().id);
    expect(createdTemplate?.rules_json.hardRules).toContainEqual(
      expect.objectContaining({ type: 'follower-range', max: 5000 }),
    );
    await server.close();
  });

  it('创建运行时冻结规则，后续编辑只进入下一次运行', async () => {
    const server = buildServer({ pool, logger: false, secureCookies: true });
    const login = await server.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {
        workspaceId,
        email: credentials.email,
        password: credentials.password,
      },
    });
    const headers = {
      cookie: firstHeader(login.headers['set-cookie'])!.split(';')[0]!,
      'x-csrf-token': login.json().csrfToken as string,
    };
    const originalRules = createDefaultCampaignRuleSet();
    const campaign = await server.inject({
      method: 'POST',
      url: '/campaigns',
      headers,
      payload: {
        name: '运行快照 API 任务',
        recommendationProfileDescription: '校园推荐流',
        rules: originalRules,
      },
    });
    expect(campaign.statusCode).toBe(201);

    const firstRun = await server.inject({
      method: 'POST',
      url: `/campaigns/${campaign.json().id}/runs`,
      headers,
    });
    expect(firstRun.statusCode).toBe(201);
    expect(firstRun.json()).toMatchObject({ status: 'ready', ruleVersion: 1 });

    const changedRules = createDefaultCampaignRuleSet();
    const followerRule = changedRules.hardRules.find((rule) => rule.type === 'follower-range');
    if (followerRule?.type === 'follower-range') followerRule.max = 8_000;
    const changed = await server.inject({
      method: 'PATCH',
      url: `/campaigns/${campaign.json().id}`,
      headers,
      payload: { expectedVersion: 1, rules: changedRules },
    });
    expect(changed.statusCode).toBe(200);

    const secondRun = await server.inject({
      method: 'POST',
      url: `/campaigns/${campaign.json().id}/runs`,
      headers,
    });
    expect(secondRun.statusCode).toBe(201);
    expect(secondRun.json()).toMatchObject({ status: 'ready', ruleVersion: 2 });
    expect(firstRun.json().rules.hardRules).toContainEqual(
      expect.objectContaining({ type: 'follower-range', max: 5_000 }),
    );
    expect(secondRun.json().rules.hardRules).toContainEqual(
      expect.objectContaining({ type: 'follower-range', max: 8_000 }),
    );
    await server.close();
  });
});
