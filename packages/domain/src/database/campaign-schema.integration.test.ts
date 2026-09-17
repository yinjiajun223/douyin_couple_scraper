import type { RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDefaultCampaignRuleSet } from '@douyin/contracts';

import { createMysqlPool, runMigrations } from './migrations.js';

const databaseUrl = process.env.MYSQL_TEST_URL;
const describeWithMysql = databaseUrl ? describe : describe.skip;

describeWithMysql('筛选任务与规则快照数据模型', () => {
  const pool = createMysqlPool(databaseUrl!);
  const workspaceId = '11000000-0000-4000-8000-000000000001';
  const userId = '21000000-0000-4000-8000-000000000001';
  const campaignId = '41000000-0000-4000-8000-000000000001';
  const ruleVersionId = '42000000-0000-4000-8000-000000000001';
  const initialRules = createDefaultCampaignRuleSet();

  beforeAll(async () => {
    await runMigrations(pool);
    await pool.execute('INSERT INTO workspaces (id, slug, name) VALUES (?, ?, ?)', [
      workspaceId,
      'campaign-test',
      '任务测试工作区',
    ]);
    await pool.execute(
      'INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)',
      [userId, 'campaign@example.test', 'argon2-test-hash', '任务管理员'],
    );
    await pool.execute(
      `INSERT INTO campaigns
       (id, workspace_id, name, recommendation_profile_description, rule_schema_version, rules_json, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        campaignId,
        workspaceId,
        '初始任务',
        '情侣日常推荐画像',
        1,
        JSON.stringify(initialRules),
        userId,
      ],
    );
    await pool.execute(
      `INSERT INTO campaign_rule_versions
       (id, workspace_id, campaign_id, version, rule_schema_version, rules_json, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [ruleVersionId, workspaceId, campaignId, 1, 1, JSON.stringify(initialRules), userId],
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  it('创建任务、规则版本、运行和设备关联表', async () => {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = DATABASE()
         AND table_name IN ('campaign_templates', 'campaigns', 'campaign_rule_versions', 'collection_runs', 'run_devices')`,
    );

    expect(rows).toHaveLength(5);
  });

  it('数据库拒绝更新或删除历史规则版本', async () => {
    await expect(
      pool.execute('UPDATE campaign_rule_versions SET version = 2 WHERE id = ?', [ruleVersionId]),
    ).rejects.toMatchObject({ code: 'ER_SIGNAL_EXCEPTION' });
    await expect(
      pool.execute('DELETE FROM campaign_rule_versions WHERE id = ?', [ruleVersionId]),
    ).rejects.toMatchObject({ code: 'ER_SIGNAL_EXCEPTION' });
  });

  it('编辑当前任务不改变历史运行规则', async () => {
    const changedRules = createDefaultCampaignRuleSet();
    const followerRule = changedRules.hardRules.find((rule) => rule.type === 'follower-range');
    if (followerRule?.type === 'follower-range') followerRule.max = 8_000;

    await pool.execute('UPDATE campaigns SET rules_json = ? WHERE id = ?', [
      JSON.stringify(changedRules),
      campaignId,
    ]);
    await pool.execute(
      `INSERT INTO collection_runs
       (id, workspace_id, campaign_id, rule_version_id, progress_json, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        '43000000-0000-4000-8000-000000000001',
        workspaceId,
        campaignId,
        ruleVersionId,
        '{}',
        userId,
      ],
    );

    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT c.rules_json AS current_rules, rv.rules_json AS snapshot_rules
       FROM collection_runs r
       JOIN campaigns c ON c.id = r.campaign_id
       JOIN campaign_rule_versions rv ON rv.id = r.rule_version_id
       WHERE r.id = '43000000-0000-4000-8000-000000000001'`,
    );

    const current = rows[0]?.current_rules as typeof initialRules;
    const snapshot = rows[0]?.snapshot_rules as typeof initialRules;
    expect(current.hardRules).toContainEqual(
      expect.objectContaining({ type: 'follower-range', max: 8_000 }),
    );
    expect(snapshot.hardRules).toContainEqual(
      expect.objectContaining({ type: 'follower-range', max: 5_000 }),
    );
  });
});
