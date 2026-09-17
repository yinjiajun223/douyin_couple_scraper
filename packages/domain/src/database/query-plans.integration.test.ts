import type { RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDefaultCampaignRuleSet } from '@douyin/contracts';

import { createMysqlPool, runMigrations } from './migrations.js';

const databaseUrl = process.env.MYSQL_TEST_URL;
const describeWithMysql = databaseUrl ? describe : describe.skip;

interface ExplainRow extends RowDataPacket {
  key: string | null;
  possible_keys: string | null;
  type: string;
}

describeWithMysql('关键查询索引计划', () => {
  const pool = createMysqlPool(databaseUrl!);
  const workspaceId = '16000000-0000-4000-8000-000000000001';
  const userId = '26000000-0000-4000-8000-000000000001';
  const deviceId = '36000000-0000-4000-8000-000000000001';
  const campaignId = '46000000-0000-4000-8000-000000000001';
  const ruleId = '46000000-0000-4000-8000-000000000002';
  const runId = '46000000-0000-4000-8000-000000000003';

  beforeAll(async () => {
    await runMigrations(pool);
    await pool.execute('INSERT INTO workspaces (id, slug, name) VALUES (?, ?, ?)', [
      workspaceId,
      'query-plan-test',
      '查询计划测试',
    ]);
    await pool.execute(
      'INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)',
      [userId, 'query-plan@example.test', 'argon2-test-hash', '查询测试员'],
    );
    await pool.execute(
      `INSERT INTO devices (id, workspace_id, owner_user_id, name, token_hash)
       VALUES (?, ?, ?, ?, ?)`,
      [deviceId, workspaceId, userId, '查询测试设备', deviceId.replaceAll('-', '').padEnd(64, '0')],
    );
    const rules = JSON.stringify(createDefaultCampaignRuleSet());
    await pool.execute(
      `INSERT INTO campaigns
       (id, workspace_id, name, rule_schema_version, rules_json, created_by_user_id)
       VALUES (?, ?, '查询计划任务', 1, ?, ?)`,
      [campaignId, workspaceId, rules, userId],
    );
    await pool.execute(
      `INSERT INTO campaign_rule_versions
       (id, workspace_id, campaign_id, version, rule_schema_version, rules_json, created_by_user_id)
       VALUES (?, ?, ?, 1, 1, ?, ?)`,
      [ruleId, workspaceId, campaignId, rules, userId],
    );
    await pool.execute(
      `INSERT INTO collection_runs
       (id, workspace_id, campaign_id, rule_version_id, progress_json, created_by_user_id)
       VALUES (?, ?, ?, ?, '{}', ?)`,
      [runId, workspaceId, campaignId, ruleId, userId],
    );

    for (let chunkStart = 0; chunkStart < 1000; chunkStart += 200) {
      const creatorValues: unknown[] = [];
      const observationValues: unknown[] = [];
      const candidateValues: unknown[] = [];
      const creatorPlaceholders: string[] = [];
      const observationPlaceholders: string[] = [];
      const candidatePlaceholders: string[] = [];

      for (let offset = 0; offset < 200; offset += 1) {
        const index = chunkStart + offset;
        const suffix = index.toString().padStart(12, '0');
        const creatorId = `56000000-0000-4000-8000-${suffix}`;
        const observationId = `66000000-0000-4000-8000-${suffix}`;
        const candidateId = `76000000-0000-4000-8000-${suffix}`;
        creatorPlaceholders.push('(?, ?, ?, ?, ?, ?, ?)');
        creatorValues.push(
          creatorId,
          workspaceId,
          'douyin',
          `query-plan-creator-${index}`,
          `https://www.douyin.com/user/query-plan-${index}`,
          '2026-09-15 10:00:00.000',
          '2026-09-15 10:00:00.000',
        );
        observationPlaceholders.push('(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
        observationValues.push(
          observationId,
          workspaceId,
          creatorId,
          runId,
          deviceId,
          `查询达人${index}`,
          1000 + index,
          String(1000 + index),
          `https://www.douyin.com/user/query-plan-${index}`,
          0.98,
          '1.0.0',
          '1.0.0',
          '2026-09-15 10:00:00.000',
        );
        candidatePlaceholders.push('(?, ?, ?, ?, ?, ?, ?, ?, ?)');
        candidateValues.push(
          candidateId,
          workspaceId,
          campaignId,
          creatorId,
          runId,
          observationId,
          userId,
          'pass',
          index % 2 === 0 ? 'to_contact' : 'pending_review',
        );
      }

      await pool.query(
        `INSERT INTO creators
         (id, workspace_id, platform, platform_creator_id, canonical_profile_url,
          first_observed_at, last_observed_at)
         VALUES ${creatorPlaceholders.join(',')}`,
        creatorValues,
      );
      await pool.query(
        `INSERT INTO creator_observations
         (id, workspace_id, creator_id, run_id, device_id, nickname, follower_count,
          follower_count_raw, profile_url, parser_confidence, collector_version,
          parser_version, observed_at)
         VALUES ${observationPlaceholders.join(',')}`,
        observationValues,
      );
      await pool.query(
        `INSERT INTO campaign_candidates
         (id, workspace_id, campaign_id, creator_id, latest_run_id,
          latest_creator_observation_id, assignee_user_id, hard_filter_status, pipeline_status)
         VALUES ${candidatePlaceholders.join(',')}`,
        candidateValues,
      );
    }

    for (let chunkStart = 0; chunkStart < 1000; chunkStart += 250) {
      const values: unknown[] = [];
      const placeholders: string[] = [];
      for (let offset = 0; offset < 250; offset += 1) {
        const index = chunkStart + offset;
        const suffix = index.toString().padStart(12, '0');
        placeholders.push('(?, ?, ?, ?, ?, ?, ?)');
        values.push(
          `86000000-0000-4000-8000-${suffix}`,
          workspaceId,
          'ai-screening',
          `query-plan-job-${index}`,
          JSON.stringify({ index }),
          index % 3 === 0 ? 'ready' : 'succeeded',
          index % 10,
        );
      }
      await pool.query(
        `INSERT INTO background_jobs
         (id, workspace_id, job_type, deduplication_key, payload_json, status, priority)
         VALUES ${placeholders.join(',')}`,
        values,
      );
    }
    await pool.query('ANALYZE TABLE campaign_candidates, background_jobs');
  });

  afterAll(async () => {
    await pool.end();
  });

  it('候选组合筛选使用有界复合索引', async () => {
    const [plan] = await pool.query<ExplainRow[]>(
      `EXPLAIN SELECT id, pipeline_status, assignee_user_id
       FROM campaign_candidates
       WHERE workspace_id = ?
         AND campaign_id = ?
         AND pipeline_status = 'to_contact'
         AND assignee_user_id = ?
       ORDER BY updated_at DESC
       LIMIT 50`,
      [workspaceId, campaignId, userId],
    );

    expect(plan[0]?.possible_keys).toContain('idx_campaign_candidates_filter');
    expect(plan[0]?.key).toBe('idx_campaign_candidates_filter');
    expect(plan[0]?.type).not.toBe('ALL');
  });

  it('worker领取到期任务使用领取索引', async () => {
    const [plan] = await pool.query<ExplainRow[]>(
      `EXPLAIN SELECT id
       FROM background_jobs
       WHERE status = 'ready'
         AND run_at <= CURRENT_TIMESTAMP(3)
         AND lease_expires_at IS NULL
       ORDER BY priority, run_at, id
       LIMIT 20
       FOR UPDATE SKIP LOCKED`,
    );

    expect(plan[0]?.possible_keys).toContain('idx_background_jobs_claim');
    expect(plan[0]?.key).toBe('idx_background_jobs_claim');
    expect(plan[0]?.type).not.toBe('ALL');
  });
});
