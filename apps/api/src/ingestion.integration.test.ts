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
});
