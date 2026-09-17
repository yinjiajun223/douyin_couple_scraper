import type { RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDefaultCampaignRuleSet } from '@douyin/contracts';

import { createMysqlPool, runMigrations } from './migrations.js';

const databaseUrl = process.env.MYSQL_TEST_URL;
const describeWithMysql = databaseUrl ? describe : describe.skip;

describeWithMysql('候选判断与合作数据模型', () => {
  const pool = createMysqlPool(databaseUrl!);
  const workspaceId = '13000000-0000-4000-8000-000000000001';
  const userId = '23000000-0000-4000-8000-000000000001';
  const deviceId = '33000000-0000-4000-8000-000000000001';
  const creatorId = '53000000-0000-4000-8000-000000000001';
  const observationId = '63000000-0000-4000-8000-000000000001';
  const campaigns = [
    {
      id: '43000000-0000-4000-8000-000000000001',
      ruleId: '43000000-0000-4000-8000-000000000011',
      runId: '43000000-0000-4000-8000-000000000021',
      candidateId: '73000000-0000-4000-8000-000000000001',
    },
    {
      id: '43000000-0000-4000-8000-000000000002',
      ruleId: '43000000-0000-4000-8000-000000000012',
      runId: '43000000-0000-4000-8000-000000000022',
      candidateId: '73000000-0000-4000-8000-000000000002',
    },
  ] as const;

  beforeAll(async () => {
    await runMigrations(pool);
    await pool.execute('INSERT INTO workspaces (id, slug, name) VALUES (?, ?, ?)', [
      workspaceId,
      'candidate-decisions-test',
      '候选工作流测试',
    ]);
    await pool.execute(
      'INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)',
      [userId, 'candidate@example.test', 'argon2-test-hash', '复核员'],
    );
    await pool.execute(
      `INSERT INTO devices (id, workspace_id, owner_user_id, name, token_hash)
       VALUES (?, ?, ?, ?, ?)`,
      [deviceId, workspaceId, userId, '候选测试设备', deviceId.replaceAll('-', '').padEnd(64, '0')],
    );

    const rules = JSON.stringify(createDefaultCampaignRuleSet());
    for (const [index, campaign] of campaigns.entries()) {
      await pool.execute(
        `INSERT INTO campaigns
         (id, workspace_id, name, rule_schema_version, rules_json, created_by_user_id)
         VALUES (?, ?, ?, 1, ?, ?)`,
        [campaign.id, workspaceId, `独立任务${index + 1}`, rules, userId],
      );
      await pool.execute(
        `INSERT INTO campaign_rule_versions
         (id, workspace_id, campaign_id, version, rule_schema_version, rules_json, created_by_user_id)
         VALUES (?, ?, ?, 1, 1, ?, ?)`,
        [campaign.ruleId, workspaceId, campaign.id, rules, userId],
      );
      await pool.execute(
        `INSERT INTO collection_runs
         (id, workspace_id, campaign_id, rule_version_id, progress_json, created_by_user_id)
         VALUES (?, ?, ?, ?, '{}', ?)`,
        [campaign.runId, workspaceId, campaign.id, campaign.ruleId, userId],
      );
    }

    await pool.execute(
      `INSERT INTO creators
       (id, workspace_id, platform, platform_creator_id, canonical_profile_url, first_observed_at, last_observed_at)
       VALUES (?, ?, 'douyin', 'shared-creator', 'https://www.douyin.com/user/shared-creator',
               '2026-09-15 10:00:00.000', '2026-09-15 10:00:00.000')`,
      [creatorId, workspaceId],
    );
    await pool.execute(
      `INSERT INTO creator_observations
       (id, workspace_id, creator_id, run_id, device_id, nickname, follower_count,
        follower_count_raw, profile_url, parser_confidence, collector_version,
        parser_version, observed_at)
       VALUES (?, ?, ?, ?, ?, '共享达人', 1800, '1800',
               'https://www.douyin.com/user/shared-creator', 0.98, '1.0.0', '1.0.0',
               '2026-09-15 10:00:00.000')`,
      [observationId, workspaceId, creatorId, campaigns[0].runId, deviceId],
    );

    for (const campaign of campaigns) {
      await pool.execute(
        `INSERT INTO campaign_candidates
         (id, workspace_id, campaign_id, creator_id, latest_run_id,
          latest_creator_observation_id, hard_filter_status)
         VALUES (?, ?, ?, ?, ?, ?, 'pass')`,
        [campaign.candidateId, workspaceId, campaign.id, creatorId, campaign.runId, observationId],
      );
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  it('同一达人在两个任务中拥有独立候选和状态', async () => {
    await pool.execute(
      `UPDATE campaign_candidates
       SET pipeline_status = 'to_contact', version = version + 1
       WHERE id = ? AND version = 1`,
      [campaigns[0].candidateId],
    );
    await pool.execute(
      `UPDATE campaign_candidates
       SET pipeline_status = 'unsuitable', version = version + 1
       WHERE id = ? AND version = 1`,
      [campaigns[1].candidateId],
    );

    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT campaign_id, pipeline_status, version
       FROM campaign_candidates WHERE creator_id = ? ORDER BY campaign_id`,
      [creatorId],
    );

    expect(rows).toEqual([
      expect.objectContaining({
        campaign_id: campaigns[0].id,
        pipeline_status: 'to_contact',
        version: 2,
      }),
      expect.objectContaining({
        campaign_id: campaigns[1].id,
        pipeline_status: 'unsuitable',
        version: 2,
      }),
    ]);
  });

  it('唯一键阻止同一任务重复挂载同一达人', async () => {
    await expect(
      pool.execute(
        `INSERT INTO campaign_candidates
         (id, workspace_id, campaign_id, creator_id, latest_run_id,
          latest_creator_observation_id, hard_filter_status)
         VALUES (?, ?, ?, ?, ?, ?, 'pass')`,
        [
          '73000000-0000-4000-8000-000000000099',
          workspaceId,
          campaigns[0].id,
          creatorId,
          campaigns[0].runId,
          observationId,
        ],
      ),
    ).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
  });

  it('乐观版本条件拒绝基于旧版本的静默覆盖', async () => {
    const [result] = await pool.execute(
      `UPDATE campaign_candidates
       SET pipeline_status = 'contacted', version = version + 1
       WHERE id = ? AND version = 1`,
      [campaigns[0].candidateId],
    );

    expect(result).toMatchObject({ affectedRows: 0 });
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT pipeline_status, version FROM campaign_candidates WHERE id = ?',
      [campaigns[0].candidateId],
    );
    expect(rows[0]).toEqual(expect.objectContaining({ pipeline_status: 'to_contact', version: 2 }));
  });
});
