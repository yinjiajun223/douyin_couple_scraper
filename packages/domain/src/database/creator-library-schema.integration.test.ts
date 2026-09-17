import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDefaultCampaignRuleSet } from '@douyin/contracts';

import { createMysqlPool, runMigrations } from './migrations.js';

const databaseUrl = process.env.MYSQL_TEST_URL;
const describeWithMysql = databaseUrl ? describe : describe.skip;

describeWithMysql('达人事实库数据模型', () => {
  const pool = createMysqlPool(databaseUrl!);
  const workspaceId = '12000000-0000-4000-8000-000000000001';
  const userId = '22000000-0000-4000-8000-000000000001';
  const deviceOneId = '32000000-0000-4000-8000-000000000001';
  const deviceTwoId = '32000000-0000-4000-8000-000000000002';
  const campaignId = '42000000-0000-4000-8000-000000000001';
  const ruleVersionId = '42000000-0000-4000-8000-000000000002';
  const runOneId = '42000000-0000-4000-8000-000000000003';
  const runTwoId = '42000000-0000-4000-8000-000000000004';
  const creatorId = '52000000-0000-4000-8000-000000000001';
  const firstObservationId = '62000000-0000-4000-8000-000000000001';
  const secondObservationId = '62000000-0000-4000-8000-000000000002';

  beforeAll(async () => {
    await runMigrations(pool);
    await pool.execute('INSERT INTO workspaces (id, slug, name) VALUES (?, ?, ?)', [
      workspaceId,
      'creator-library-test',
      '达人事实库测试',
    ]);
    await pool.execute(
      'INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)',
      [userId, 'creator-library@example.test', 'argon2-test-hash', '采集员'],
    );
    const devices: Array<readonly [string, string]> = [
      [deviceOneId, '设备一'],
      [deviceTwoId, '设备二'],
    ];
    for (const [id, name] of devices) {
      await pool.execute(
        `INSERT INTO devices
         (id, workspace_id, owner_user_id, name, token_hash)
         VALUES (?, ?, ?, ?, ?)`,
        [id, workspaceId, userId, name, id.replaceAll('-', '').padEnd(64, '0')],
      );
    }

    const rules = JSON.stringify(createDefaultCampaignRuleSet());
    await pool.execute(
      `INSERT INTO campaigns
       (id, workspace_id, name, rule_schema_version, rules_json, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [campaignId, workspaceId, '达人库测试任务', 1, rules, userId],
    );
    await pool.execute(
      `INSERT INTO campaign_rule_versions
       (id, workspace_id, campaign_id, version, rule_schema_version, rules_json, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [ruleVersionId, workspaceId, campaignId, 1, 1, rules, userId],
    );
    for (const runId of [runOneId, runTwoId]) {
      await pool.execute(
        `INSERT INTO collection_runs
         (id, workspace_id, campaign_id, rule_version_id, progress_json, created_by_user_id)
         VALUES (?, ?, ?, ?, '{}', ?)`,
        [runId, workspaceId, campaignId, ruleVersionId, userId],
      );
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  async function insertCreatorObservation(
    observationId: string,
    runId: string,
    deviceId: string,
    followerCount: number,
  ): Promise<void> {
    await pool.execute(
      `INSERT INTO creator_observations
       (id, workspace_id, creator_id, run_id, device_id, nickname, biography,
        follower_count, follower_count_raw, profile_url, parser_confidence,
        collector_version, parser_version, observed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        observationId,
        workspaceId,
        creatorId,
        runId,
        deviceId,
        '小影同学',
        '日常记录',
        followerCount,
        String(followerCount),
        'https://www.douyin.com/user/creator-stable-id',
        0.99,
        '1.0.0',
        '1.0.0',
        followerCount === 1200 ? '2026-09-14 10:00:00.000' : '2026-09-15 10:00:00.000',
      ],
    );
    await pool.execute(
      `INSERT INTO run_creator_sources
       (workspace_id, run_id, creator_id, device_id, first_observation_id, first_observed_at, last_observed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        workspaceId,
        runId,
        creatorId,
        deviceId,
        observationId,
        followerCount === 1200 ? '2026-09-14 10:00:00.000' : '2026-09-15 10:00:00.000',
        followerCount === 1200 ? '2026-09-14 10:00:00.000' : '2026-09-15 10:00:00.000',
      ],
    );
  }

  it('相同平台账号在两个运行和设备间只保留一个主档案', async () => {
    const insertCreator = async (id: string, observedAt: string): Promise<ResultSetHeader> => {
      const [result] = await pool.execute<ResultSetHeader>(
        `INSERT INTO creators
         (id, workspace_id, platform, platform_creator_id, canonical_profile_url, first_observed_at, last_observed_at)
         VALUES (?, ?, 'douyin', ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           canonical_profile_url = VALUES(canonical_profile_url),
           last_observed_at = GREATEST(last_observed_at, VALUES(last_observed_at))`,
        [
          id,
          workspaceId,
          'creator-stable-id',
          'https://www.douyin.com/user/creator-stable-id',
          observedAt,
          observedAt,
        ],
      );
      return result;
    };

    await insertCreator(creatorId, '2026-09-14 10:00:00.000');
    const duplicateResult = await insertCreator(
      '52000000-0000-4000-8000-000000000099',
      '2026-09-15 10:00:00.000',
    );
    await insertCreatorObservation(firstObservationId, runOneId, deviceOneId, 1200);
    await insertCreatorObservation(secondObservationId, runTwoId, deviceTwoId, 1350);

    const [creators] = await pool.query<RowDataPacket[]>(
      `SELECT id FROM creators
       WHERE workspace_id = ? AND platform = 'douyin' AND platform_creator_id = ?`,
      [workspaceId, 'creator-stable-id'],
    );
    const [observations] = await pool.query<RowDataPacket[]>(
      'SELECT follower_count FROM creator_observations WHERE creator_id = ? ORDER BY observed_at',
      [creatorId],
    );
    const [sources] = await pool.query<RowDataPacket[]>(
      'SELECT run_id, device_id FROM run_creator_sources WHERE creator_id = ?',
      [creatorId],
    );

    expect(duplicateResult.affectedRows).toBe(2);
    expect(creators).toEqual([expect.objectContaining({ id: creatorId })]);
    expect(observations.map((row) => Number(row.follower_count))).toEqual([1200, 1350]);
    expect(sources).toHaveLength(2);
  });

  it('观察快照只允许追加并拒绝更新或删除', async () => {
    await expect(
      pool.execute('UPDATE creator_observations SET follower_count = 9999 WHERE id = ?', [
        firstObservationId,
      ]),
    ).rejects.toMatchObject({ code: 'ER_SIGNAL_EXCEPTION' });
    await expect(
      pool.execute('DELETE FROM creator_observations WHERE id = ?', [firstObservationId]),
    ).rejects.toMatchObject({ code: 'ER_SIGNAL_EXCEPTION' });
  });

  it('作品按平台对象去重并保留独立点赞观察', async () => {
    const postId = '72000000-0000-4000-8000-000000000001';
    const postUrl = 'https://www.douyin.com/video/post-stable-id';
    await pool.execute(
      `INSERT INTO posts
       (id, workspace_id, creator_id, platform, platform_post_id, canonical_post_url, first_observed_at, last_observed_at)
       VALUES (?, ?, ?, 'douyin', ?, ?, '2026-09-14 10:00:00.000', '2026-09-14 10:00:00.000')`,
      [postId, workspaceId, creatorId, 'post-stable-id', postUrl],
    );
    await expect(
      pool.execute(
        `INSERT INTO posts
         (id, workspace_id, creator_id, platform, platform_post_id, canonical_post_url, first_observed_at, last_observed_at)
         VALUES (?, ?, ?, 'douyin', ?, ?, '2026-09-15 10:00:00.000', '2026-09-15 10:00:00.000')`,
        ['72000000-0000-4000-8000-000000000099', workspaceId, creatorId, 'post-stable-id', postUrl],
      ),
    ).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });

    await pool.execute(
      `INSERT INTO post_observations
       (id, workspace_id, post_id, creator_observation_id, run_id, device_id, caption,
        like_count, like_count_raw, published_at, observed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        '82000000-0000-4000-8000-000000000001',
        workspaceId,
        postId,
        firstObservationId,
        runOneId,
        deviceOneId,
        '第一条观察',
        10200,
        '1.0万',
        '2026-09-10 10:00:00.000',
        '2026-09-14 10:00:00.000',
      ],
    );
    await pool.execute(
      `INSERT INTO post_observations
       (id, workspace_id, post_id, creator_observation_id, run_id, device_id, caption,
        like_count, like_count_raw, published_at, observed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        '82000000-0000-4000-8000-000000000002',
        workspaceId,
        postId,
        secondObservationId,
        runTwoId,
        deviceTwoId,
        '第二条观察',
        15600,
        '1.5万',
        '2026-09-10 10:00:00.000',
        '2026-09-15 10:00:00.000',
      ],
    );

    const [postObservations] = await pool.query<RowDataPacket[]>(
      'SELECT like_count FROM post_observations WHERE post_id = ? ORDER BY observed_at',
      [postId],
    );
    expect(postObservations.map((row) => Number(row.like_count))).toEqual([10200, 15600]);
    await expect(
      pool.execute('UPDATE post_observations SET like_count = 1 WHERE post_id = ?', [postId]),
    ).rejects.toMatchObject({ code: 'ER_SIGNAL_EXCEPTION' });
  });
});
