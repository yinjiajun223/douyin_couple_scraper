import type { RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { CampaignRuleSet } from '@douyin/contracts';

import { createMysqlPool, runMigrations } from './migrations.js';
import { seedInitialWorkspace, WORKSPACE_ROLE_DEFINITIONS } from './seed.js';

const databaseUrl = process.env.MYSQL_TEST_URL;
const describeWithMysql = databaseUrl ? describe : describe.skip;

describeWithMysql('初始工作区种子', () => {
  const pool = createMysqlPool(databaseUrl!);
  const workspaceId = '15000000-0000-4000-8000-000000000001';

  beforeAll(async () => {
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('重复运行只保留一个工作区、三种角色和一个默认模板', async () => {
    const options = {
      workspaceId,
      workspaceSlug: 'seed-test',
      workspaceName: '种子测试工作区',
    };
    await seedInitialWorkspace(pool, options);
    await seedInitialWorkspace(pool, options);

    const [workspaces] = await pool.query<RowDataPacket[]>(
      'SELECT id FROM workspaces WHERE id = ?',
      [workspaceId],
    );
    const [roles] = await pool.query<RowDataPacket[]>(
      'SELECT role_key FROM workspace_roles WHERE workspace_id = ? ORDER BY role_key',
      [workspaceId],
    );
    const [templates] = await pool.query<RowDataPacket[]>(
      'SELECT rules_json FROM campaign_templates WHERE workspace_id = ?',
      [workspaceId],
    );

    expect(workspaces).toHaveLength(1);
    expect(roles.map((row) => row.role_key)).toEqual(
      WORKSPACE_ROLE_DEFINITIONS.map((role) => role.key).sort(),
    );
    expect(templates).toHaveLength(1);

    const rules = templates[0]?.rules_json as CampaignRuleSet;
    expect(rules.hardRules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'follower-range', min: 0, max: 5000 }),
        expect.objectContaining({
          type: 'recent-post-likes',
          windowDays: 15,
          minimumLikes: 10000,
          minimumMatchingPosts: 1,
        }),
      ]),
    );
    expect(rules.aiRules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'estimated-age-band', minAge: 18, maxAge: 24 }),
        expect.objectContaining({ type: 'amateur-status' }),
      ]),
    );
    expect(rules.aiRules.some((rule) => rule.type === 'content-fit')).toBe(false);
  });
});
