import type { Pool, RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { COLLECTOR_PROTOCOL_VERSION, createDefaultCampaignRuleSet } from '@douyin/contracts';
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

describeWithMysql('Collector 批量观察 ingestion API', () => {
  const workspaceId = '20000000-0000-4000-8000-000000000001';
  const credentials = {
    workspaceId,
    email: 'ingestion-admin@example.test',
    displayName: '同步 API 管理员',
    password: 'StrongIngestionAdmin2026',
  };
  let pool: Pool;

  beforeAll(async () => {
    pool = createMysqlPool(databaseUrl!);
    await runMigrations(pool);
    await seedInitialWorkspace(pool, {
      workspaceId,
      workspaceSlug: 'ingestion-api-test',
      workspaceName: '同步 API 测试',
    });
    await bootstrapFirstAdmin(pool, credentials);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('拒绝安全边界违规，并确保同一批次只持久化一次', async () => {
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
    const browserHeaders = {
      cookie: firstHeader(login.headers['set-cookie'])!.split(';')[0]!,
      'x-csrf-token': login.json().csrfToken as string,
    };

    async function pairDevice(name: string) {
      const pairingCode = await server.inject({
        method: 'POST',
        url: '/devices/pairing-codes',
        headers: browserHeaders,
        payload: { expiresInMinutes: 10 },
      });
      const paired = await server.inject({
        method: 'POST',
        url: '/collector/pair',
        payload: {
          code: pairingCode.json().code,
          name,
          collectorVersion: '1.0.0',
          parserVersion: '1.0.0',
        },
      });
      return { deviceId: paired.json().deviceId as string, token: paired.json().token as string };
    }

    const deviceOne = await pairDevice('同步设备一');
    const deviceTwo = await pairDevice('同步设备二');
    const campaign = await server.inject({
      method: 'POST',
      url: '/campaigns',
      headers: browserHeaders,
      payload: {
        name: '同步安全测试任务',
        recommendationProfileDescription: '校园推荐流',
        rules: createDefaultCampaignRuleSet(),
      },
    });
    const createdRun = await server.inject({
      method: 'POST',
      url: `/campaigns/${campaign.json().id}/runs`,
      headers: browserHeaders,
    });
    const runId = createdRun.json().id as string;
    const deviceOneHeaders = { authorization: `Bearer ${deviceOne.token}` };
    await server.inject({
      method: 'POST',
      url: `/collector/runs/${runId}/claim`,
      headers: deviceOneHeaders,
    });
    await server.inject({
      method: 'POST',
      url: `/collector/runs/${runId}/start`,
      headers: deviceOneHeaders,
    });

    const batch = {
      protocolVersion: COLLECTOR_PROTOCOL_VERSION,
      collectorVersion: '1.0.0',
      parserVersion: '1.0.0',
      deviceId: deviceOne.deviceId,
      runId,
      idempotencyKey: 'ingestion-security-0001',
      observations: [
        {
          observationId: '21000000-0000-4000-8000-000000000001',
          platform: 'douyin',
          platformCreatorId: 'security-creator-1',
          profileUrl: 'https://www.douyin.com/user/security-creator-1',
          nickname: '安全测试博主',
          biography: null,
          followerCount: 2_300,
          followerCountRaw: '2300',
          observedAt: '2026-09-15T08:00:00.000Z',
          posts: [
            {
              platformPostId: 'security-post-1',
              postUrl: 'https://www.douyin.com/video/security-post-1',
              caption: '校园生活记录',
              likeCount: 12_000,
              likeCountRaw: '1.2万',
              publishedAt: '2026-09-10T08:00:00.000Z',
              observedAt: '2026-09-15T08:00:00.000Z',
              screenshotLocalId: null,
            },
          ],
          parserConfidence: 0.98,
        },
      ],
    };

    const cookieLeak = await server.inject({
      method: 'POST',
      url: '/collector/ingestion/batches',
      headers: deviceOneHeaders,
      payload: { ...batch, cookie: 'sessionid=must-not-upload' },
    });
    expect(cookieLeak.statusCode).toBe(400);
    const passwordLeak = await server.inject({
      method: 'POST',
      url: '/collector/ingestion/batches',
      headers: deviceOneHeaders,
      payload: {
        ...batch,
        observations: [{ ...batch.observations[0], password: 'must-not-upload' }],
      },
    });
    expect(passwordLeak.statusCode).toBe(400);

    const incompatible = await server.inject({
      method: 'POST',
      url: '/collector/ingestion/batches',
      headers: deviceOneHeaders,
      payload: { ...batch, protocolVersion: '2.0.0' },
    });
    expect(incompatible.statusCode).toBe(426);
    expect(incompatible.json()).toMatchObject({ code: 'COLLECTOR_UPGRADE_REQUIRED' });

    const spoofedDevice = await server.inject({
      method: 'POST',
      url: '/collector/ingestion/batches',
      headers: deviceOneHeaders,
      payload: { ...batch, deviceId: deviceTwo.deviceId },
    });
    expect(spoofedDevice.statusCode).toBe(403);
    expect(spoofedDevice.json()).toMatchObject({ code: 'COLLECTOR_DEVICE_IDENTITY_MISMATCH' });

    const unauthorizedRun = await server.inject({
      method: 'POST',
      url: '/collector/ingestion/batches',
      headers: { authorization: `Bearer ${deviceTwo.token}` },
      payload: { ...batch, deviceId: deviceTwo.deviceId },
    });
    expect(unauthorizedRun.statusCode).toBe(403);
    expect(unauthorizedRun.json()).toMatchObject({ code: 'COLLECTOR_RUN_ACCESS_DENIED' });

    const accepted = await server.inject({
      method: 'POST',
      url: '/collector/ingestion/batches',
      headers: deviceOneHeaders,
      payload: batch,
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({
      duplicateBatch: false,
      results: [{ observationId: batch.observations[0]!.observationId, status: 'accepted' }],
    });
    const duplicate = await server.inject({
      method: 'POST',
      url: '/collector/ingestion/batches',
      headers: deviceOneHeaders,
      payload: batch,
    });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toMatchObject({
      duplicateBatch: true,
      results: [{ observationId: batch.observations[0]!.observationId, status: 'accepted' }],
    });
    const conflictingReuse = await server.inject({
      method: 'POST',
      url: '/collector/ingestion/batches',
      headers: deviceOneHeaders,
      payload: { ...batch, collectorVersion: '1.0.1' },
    });
    expect(conflictingReuse.statusCode).toBe(409);
    expect(conflictingReuse.json()).toMatchObject({ code: 'INGESTION_IDEMPOTENCY_CONFLICT' });

    const tables = [
      ['creators', 'platform_creator_id = ?', 'security-creator-1'],
      ['posts', 'platform_post_id = ?', 'security-post-1'],
      ['creator_observations', 'run_id = ?', runId],
      ['post_observations', 'run_id = ?', runId],
      ['campaign_candidates', 'latest_run_id = ?', runId],
      ['ingestion_keys', 'run_id = ?', runId],
    ] as const;
    for (const [table, predicate, value] of tables) {
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS count FROM ${table} WHERE ${predicate}`,
        [value],
      );
      expect(Number(rows[0]?.count), table).toBe(1);
    }
    await server.close();
  });

  it('硬筛未通过与数据未知的观察仍返回 accepted，只是不建立候选', async () => {
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
    const browserHeaders = {
      cookie: firstHeader(login.headers['set-cookie'])!.split(';')[0]!,
      'x-csrf-token': login.json().csrfToken as string,
    };
    const pairingCode = await server.inject({
      method: 'POST',
      url: '/devices/pairing-codes',
      headers: browserHeaders,
      payload: { expiresInMinutes: 10 },
    });
    const paired = await server.inject({
      method: 'POST',
      url: '/collector/pair',
      payload: {
        code: pairingCode.json().code,
        name: '闸门 ack 设备',
        collectorVersion: '1.0.0',
        parserVersion: '1.0.0',
      },
    });
    const deviceId = paired.json().deviceId as string;
    const deviceHeaders = { authorization: `Bearer ${paired.json().token as string}` };
    const campaign = await server.inject({
      method: 'POST',
      url: '/campaigns',
      headers: browserHeaders,
      payload: {
        name: '闸门 ack 测试任务',
        recommendationProfileDescription: '校园推荐流',
        rules: createDefaultCampaignRuleSet(),
      },
    });
    const createdRun = await server.inject({
      method: 'POST',
      url: `/campaigns/${campaign.json().id}/runs`,
      headers: browserHeaders,
    });
    const runId = createdRun.json().id as string;
    await server.inject({
      method: 'POST',
      url: `/collector/runs/${runId}/claim`,
      headers: deviceHeaders,
    });
    await server.inject({
      method: 'POST',
      url: `/collector/runs/${runId}/start`,
      headers: deviceHeaders,
    });

    const cases = [
      { suffix: 'pass', followerCount: 1_200, followerCountRaw: '1200' },
      { suffix: 'fail', followerCount: 6_200, followerCountRaw: '6200' },
      { suffix: 'unknown', followerCount: null, followerCountRaw: '--' },
    ] as const;
    const response = await server.inject({
      method: 'POST',
      url: '/collector/ingestion/batches',
      headers: deviceHeaders,
      payload: {
        protocolVersion: COLLECTOR_PROTOCOL_VERSION,
        collectorVersion: '1.0.0',
        parserVersion: '1.0.0',
        deviceId,
        runId,
        idempotencyKey: 'ingestion-gate-ack-0001',
        observations: cases.map((item, index) => ({
          observationId: `2a000000-0000-4000-8000-00000000000${index + 1}`,
          platform: 'douyin',
          platformCreatorId: `gate-creator-${item.suffix}`,
          profileUrl: `https://www.douyin.com/user/gate-creator-${item.suffix}`,
          nickname: `闸门测试 ${item.suffix}`,
          biography: null,
          followerCount: item.followerCount,
          followerCountRaw: item.followerCountRaw,
          observedAt: '2026-09-15T08:00:00.000Z',
          parserConfidence: 0.98,
          posts: [
            {
              platformPostId: `gate-post-${item.suffix}`,
              postUrl: `https://www.douyin.com/video/gate-post-${item.suffix}`,
              caption: '校园生活记录',
              likeCount: 12_000,
              likeCountRaw: '1.2万',
              publishedAt: '2026-09-10T08:00:00.000Z',
              observedAt: '2026-09-15T08:00:00.000Z',
              screenshotLocalId: null,
            },
          ],
        })),
      },
    });

    // 采集器只在 status === 'rejected' 时中止整轮运行，因此闸门绝不能借用 rejected。
    const observationIds = [1, 2, 3].map((index) => `2a000000-0000-4000-8000-00000000000${index}`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      duplicateBatch: false,
      results: observationIds.map((observationId) => ({ observationId, status: 'accepted' })),
    });

    const [counts] = await pool.query<RowDataPacket[]>(
      `SELECT
         (SELECT COUNT(*) FROM creators WHERE workspace_id = ?
           AND platform_creator_id LIKE 'gate-creator-%') AS creator_count,
         (SELECT COUNT(*) FROM campaign_candidates WHERE latest_run_id = ?) AS candidate_count,
         (SELECT COUNT(*) FROM rule_evaluations WHERE run_id = ?) AS evaluation_count`,
      [workspaceId, runId, runId],
    );
    expect(counts[0]).toMatchObject({
      creator_count: 3,
      candidate_count: 1,
      evaluation_count: 2,
    });
    const [admitted] = await pool.query<RowDataPacket[]>(
      `SELECT creators.platform_creator_id, candidates.hard_filter_status
       FROM campaign_candidates candidates
       JOIN creators ON creators.id = candidates.creator_id
       WHERE candidates.latest_run_id = ?`,
      [runId],
    );
    expect(admitted).toEqual([
      expect.objectContaining({
        platform_creator_id: 'gate-creator-pass',
        hard_filter_status: 'pass',
      }),
    ]);

    await server.close();
  });
});
