import type { Pool, RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDefaultCampaignRuleSet } from '@douyin/contracts';
import type { CampaignRuleSet } from '@douyin/contracts';

import { bootstrapFirstAdmin } from '../auth/bootstrap-admin.js';
import { createMysqlPool, runMigrations } from '../database/migrations.js';
import { seedInitialWorkspace } from '../database/seed.js';
import { createCampaign, updateCampaign } from './campaign-service.js';
import { createCollectionRun } from './run-service.js';

const databaseUrl = process.env.MYSQL_TEST_URL;
const describeWithMysql = databaseUrl ? describe : describe.skip;

interface SnapshotRow extends RowDataPacket {
  id: string;
  rules_json: CampaignRuleSet;
  version: number;
}

describeWithMysql('采集运行规则快照', () => {
  const workspaceId = '1e000000-0000-4000-8000-000000000001';
  let pool: Pool;
  let actorUserId: string;

  beforeAll(async () => {
    pool = createMysqlPool(databaseUrl!);
    await runMigrations(pool);
    await seedInitialWorkspace(pool, {
      workspaceId,
      workspaceSlug: 'run-snapshot-test',
      workspaceName: '运行快照测试',
    });
    const admin = await bootstrapFirstAdmin(pool, {
      workspaceId,
      email: 'run-snapshot@example.test',
      displayName: '运行测试管理员',
      password: 'StrongRunSnapshot2026',
    });
    actorUserId = admin.userId;
  });

  afterAll(async () => {
    await pool.end();
  });

  it('冻结每次运行的规则，任务编辑只影响下一次运行', async () => {
    const originalRules = createDefaultCampaignRuleSet();
    const campaign = await createCampaign(pool, {
      workspaceId,
      actorUserId,
      name: '规则快照任务',
      recommendationProfileDescription: '校园日常推荐流',
      rules: originalRules,
    });

    const firstRun = await createCollectionRun(pool, {
      workspaceId,
      actorUserId,
      campaignId: campaign.id,
    });
    const changedRules = createDefaultCampaignRuleSet();
    const followerRule = changedRules.hardRules.find((rule) => rule.type === 'follower-range');
    if (followerRule?.type === 'follower-range') followerRule.max = 8_000;
    await updateCampaign(pool, {
      workspaceId,
      actorUserId,
      campaignId: campaign.id,
      expectedVersion: campaign.version,
      rules: changedRules,
    });
    const secondRun = await createCollectionRun(pool, {
      workspaceId,
      actorUserId,
      campaignId: campaign.id,
    });

    const [snapshots] = await pool.query<SnapshotRow[]>(
      `SELECT id, version, rules_json
       FROM campaign_rule_versions
       WHERE campaign_id = ?
       ORDER BY version`,
      [campaign.id],
    );
    expect(firstRun).toMatchObject({ status: 'ready', ruleVersion: 1 });
    expect(secondRun).toMatchObject({ status: 'ready', ruleVersion: 2 });
    expect(snapshots.map((snapshot) => snapshot.version)).toEqual([1, 2]);
    expect(snapshots[0]?.rules_json.hardRules).toContainEqual(
      expect.objectContaining({ type: 'follower-range', max: 5_000 }),
    );
    expect(snapshots[1]?.rules_json.hardRules).toContainEqual(
      expect.objectContaining({ type: 'follower-range', max: 8_000 }),
    );
    expect(firstRun.rules.hardRules).toContainEqual(
      expect.objectContaining({ type: 'follower-range', max: 5_000 }),
    );
  });
});
