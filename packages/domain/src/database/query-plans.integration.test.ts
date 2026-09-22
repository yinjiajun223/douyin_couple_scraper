import type { RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDefaultCampaignRuleSet } from '@douyin/contracts';

import { createMysqlPool, runMigrations } from './migrations.js';

const databaseUrl = process.env.MYSQL_TEST_URL;
const describeWithMysql = databaseUrl ? describe : describe.skip;

interface ExplainRow extends RowDataPacket {
  Extra: string | null;
  key: string | null;
  possible_keys: string | null;
  table: string;
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

    // 孤儿证据回收面对的真实分布：入库闸门之后绝大多数观测都没有候选行，
    // 因此反连接几乎不排除任何行，media_objects 侧的访问方式决定整条查询的代价。
    // confirmed_at 按稳态分布分桶：85% 在近 7 天内（两条回收路径都不命中），
    // 10% 超过 7 天宽限期（只命中孤儿路径），5% 超过 180 天保留期（两条都命中）。
    for (let chunkStart = 0; chunkStart < 1000; chunkStart += 250) {
      const creatorValues: unknown[] = [];
      const observationValues: unknown[] = [];
      const mediaValues: unknown[] = [];
      const creatorPlaceholders: string[] = [];
      const observationPlaceholders: string[] = [];
      const mediaPlaceholders: string[] = [];

      for (let offset = 0; offset < 250; offset += 1) {
        const index = chunkStart + offset;
        const suffix = index.toString().padStart(12, '0');
        creatorPlaceholders.push('(?, ?, ?, ?, ?, ?, ?)');
        creatorValues.push(
          `57000000-0000-4000-8000-${suffix}`,
          workspaceId,
          'douyin',
          `query-plan-orphan-${index}`,
          `https://www.douyin.com/user/query-plan-orphan-${index}`,
          '2026-09-15 10:00:00.000',
          '2026-09-15 10:00:00.000',
        );
        observationPlaceholders.push('(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
        observationValues.push(
          `67000000-0000-4000-8000-${suffix}`,
          workspaceId,
          `57000000-0000-4000-8000-${suffix}`,
          runId,
          deviceId,
          `孤儿达人${index}`,
          1000 + index,
          String(1000 + index),
          `https://www.douyin.com/user/query-plan-orphan-${index}`,
          0.98,
          '1.0.0',
          '1.0.0',
          '2026-09-15 10:00:00.000',
        );
        const bucket = index % 20;
        const confirmedDaysAgo =
          bucket === 19 ? 200 + (index % 700) : bucket >= 17 ? 8 + (index % 90) : index % 7;
        mediaPlaceholders.push(
          '(?, ?, ?, ?, ?, ?, ?, ?, ?, TIMESTAMPADD(DAY, -?, CURRENT_TIMESTAMP(3)))',
        );
        mediaValues.push(
          `96000000-0000-4000-8000-${suffix}`,
          workspaceId,
          `67000000-0000-4000-8000-${suffix}`,
          `query-plan/orphan/${suffix}.webp`,
          'profile_screenshot',
          'image/webp',
          2048,
          'c'.repeat(64),
          index % 10 === 0 ? 'pending' : 'confirmed',
          confirmedDaysAgo,
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
        `INSERT INTO media_objects
         (id, workspace_id, creator_observation_id, object_key, purpose, mime_type,
          byte_size, checksum_sha256, status, confirmed_at)
         VALUES ${mediaPlaceholders.join(',')}`,
        mediaValues,
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
    await pool.query('ANALYZE TABLE campaign_candidates, background_jobs, media_objects');
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

  // 下面两条守护 media-cleanup 的两条 confirmed 路径。worker 传入的 workspaceId 是 NULL，
  // `(? IS NULL OR workspace_id = ?)` 因此不可用作索引条件；没有 (status, confirmed_at)
  // 时两条查询都会全表扫 media_objects 再 filesort，代价随证据总量线性增长且每小时重跑一次。
  it('孤儿证据回收按状态索引有界扫描', async () => {
    const [plan] = await pool.query<ExplainRow[]>(
      `EXPLAIN SELECT media.id, media.object_key, media.status
       FROM media_objects media
       JOIN creator_observations creator
         ON creator.workspace_id = media.workspace_id
        AND creator.id = media.creator_observation_id
       WHERE media.status = 'confirmed'
         AND media.confirmed_at <= ?
         AND (? IS NULL OR media.workspace_id = ?)
         AND NOT EXISTS (
           SELECT 1
           FROM campaign_candidates candidates
           WHERE candidates.workspace_id = media.workspace_id
             AND candidates.creator_id = creator.creator_id
         )
       ORDER BY media.confirmed_at
       LIMIT ?`,
      [new Date(Date.now() - 7 * 86_400_000), null, null, 100],
    );

    const media = plan.find((row) => row.table === 'media');
    expect(media?.key).toBe('idx_media_objects_status_confirmed');
    expect(media?.type).not.toBe('ALL');
    expect(media?.Extra ?? '').not.toContain('filesort');
    const candidates = plan.find((row) => row.table === 'candidates');
    expect(candidates?.key).not.toBeNull();
  });

  it('超期证据留存回收按状态索引有界扫描', async () => {
    const [plan] = await pool.query<ExplainRow[]>(
      `EXPLAIN SELECT media.id, media.object_key, media.status
       FROM media_objects media
       LEFT JOIN creator_observations creator
         ON creator.workspace_id = media.workspace_id
        AND creator.id = media.creator_observation_id
       LEFT JOIN post_observations post
         ON post.workspace_id = media.workspace_id
        AND post.id = media.post_observation_id
       LEFT JOIN collection_runs run
         ON run.workspace_id = media.workspace_id
        AND run.id = COALESCE(creator.run_id, post.run_id)
       LEFT JOIN campaigns campaign
         ON campaign.workspace_id = media.workspace_id
        AND campaign.id = run.campaign_id
       WHERE media.status = 'confirmed'
         AND media.confirmed_at <= ?
         AND (? IS NULL OR media.workspace_id = ?)
         AND (campaign.id IS NULL OR campaign.status = 'archived')
       ORDER BY media.confirmed_at
       LIMIT ?`,
      [new Date(Date.now() - 180 * 86_400_000), null, null, 100],
    );

    const media = plan.find((row) => row.table === 'media');
    expect(media?.key).toBe('idx_media_objects_status_confirmed');
    expect(media?.type).not.toBe('ALL');
    expect(media?.Extra ?? '').not.toContain('filesort');
  });
});
