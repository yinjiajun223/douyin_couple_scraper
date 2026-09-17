import type { Pool, RowDataPacket } from 'mysql2/promise';
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

describeWithMysql('采集运行状态 API', () => {
  const workspaceId = '1f000000-0000-4000-8000-000000000001';
  const credentials = {
    workspaceId,
    email: 'run-api-admin@example.test',
    displayName: '运行 API 管理员',
    password: 'StrongRunApiAdmin2026',
  };
  let pool: Pool;

  beforeAll(async () => {
    pool = createMysqlPool(databaseUrl!);
    await runMigrations(pool);
    await seedInitialWorkspace(pool, {
      workspaceId,
      workspaceSlug: 'run-api-test',
      workspaceName: '运行 API 测试',
    });
    await bootstrapFirstAdmin(pool, credentials);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('要求本地显式开始，支持暂停继续并按停止条件完成', async () => {
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
        name: '运行测试电脑',
        collectorVersion: '1.0.0',
        parserVersion: '1.0.0',
      },
    });
    const collectorHeaders = { authorization: `Bearer ${paired.json().token as string}` };

    const rules = createDefaultCampaignRuleSet();
    rules.stopConditions = { maxFeedItems: 100, maxDurationMinutes: 60, targetCandidates: 2 };
    const campaign = await server.inject({
      method: 'POST',
      url: '/campaigns',
      headers: browserHeaders,
      payload: {
        name: '运行状态 API 任务',
        recommendationProfileDescription: '校园推荐流',
        rules,
      },
    });
    const createdRun = await server.inject({
      method: 'POST',
      url: `/campaigns/${campaign.json().id}/runs`,
      headers: browserHeaders,
    });
    const runId = createdRun.json().id as string;

    const readyRuns = await server.inject({
      method: 'GET',
      url: '/collector/runs/ready',
      headers: collectorHeaders,
    });
    expect(readyRuns.statusCode).toBe(200);
    expect(readyRuns.json().runs).toContainEqual(
      expect.objectContaining({ id: runId, status: 'ready', ruleVersion: 1 }),
    );

    const remoteStartAttempt = await server.inject({
      method: 'POST',
      url: `/collector/runs/${runId}/start`,
      headers: browserHeaders,
    });
    expect(remoteStartAttempt.statusCode).toBe(401);

    const claimed = await server.inject({
      method: 'POST',
      url: `/collector/runs/${runId}/claim`,
      headers: collectorHeaders,
    });
    expect(claimed.json()).toMatchObject({ status: 'claimed' });

    const ownRuns = await server.inject({
      method: 'GET',
      url: '/collector/runs',
      headers: collectorHeaders,
    });
    expect(ownRuns.statusCode).toBe(200);
    expect(ownRuns.json().runs).toContainEqual(
      expect.objectContaining({ id: runId, status: 'claimed', rules }),
    );
    const secondCode = await server.inject({
      method: 'POST',
      url: '/devices/pairing-codes',
      headers: browserHeaders,
      payload: { expiresInMinutes: 10 },
    });
    const otherDevice = await server.inject({
      method: 'POST',
      url: '/collector/pair',
      payload: {
        code: secondCode.json().code,
        name: '另一台电脑',
        collectorVersion: '1.0.0',
        parserVersion: '1.0.0',
      },
    });
    const otherRuns = await server.inject({
      method: 'GET',
      url: '/collector/runs',
      headers: { authorization: `Bearer ${otherDevice.json().token as string}` },
    });
    expect(otherRuns.statusCode).toBe(200);
    expect(otherRuns.json().runs).not.toContainEqual(expect.objectContaining({ id: runId }));

    const illegalPause = await server.inject({
      method: 'POST',
      url: `/runs/${runId}/pause`,
      headers: browserHeaders,
    });
    expect(illegalPause.statusCode).toBe(409);
    expect(illegalPause.json()).toMatchObject({
      code: 'INVALID_RUN_STATUS_TRANSITION',
      from: 'claimed',
      to: 'paused',
    });

    const started = await server.inject({
      method: 'POST',
      url: `/collector/runs/${runId}/start`,
      headers: collectorHeaders,
    });
    expect(started.json()).toMatchObject({ status: 'running' });
    const duplicateStart = await server.inject({
      method: 'POST',
      url: `/collector/runs/${runId}/start`,
      headers: collectorHeaders,
    });
    expect(duplicateStart.statusCode).toBe(409);

    const locallyPaused = await server.inject({
      method: 'POST',
      url: `/collector/runs/${runId}/pause`,
      headers: collectorHeaders,
    });
    expect(locallyPaused.json()).toMatchObject({ status: 'paused' });
    const locallyResumed = await server.inject({
      method: 'POST',
      url: `/collector/runs/${runId}/resume`,
      headers: collectorHeaders,
    });
    expect(locallyResumed.json()).toMatchObject({ status: 'running' });

    const paused = await server.inject({
      method: 'POST',
      url: `/runs/${runId}/pause`,
      headers: browserHeaders,
    });
    expect(paused.json()).toMatchObject({ status: 'paused' });
    const progressWhilePaused = await server.inject({
      method: 'POST',
      url: `/collector/runs/${runId}/progress`,
      headers: collectorHeaders,
      payload: {
        feedItemsSeen: 10,
        creatorProfilesSeen: 3,
        candidatesFound: 1,
        elapsedSeconds: 120,
      },
    });
    expect(progressWhilePaused.statusCode).toBe(409);
    expect(progressWhilePaused.json()).toMatchObject({ code: 'COLLECTION_RUN_NOT_RUNNING' });

    const resumed = await server.inject({
      method: 'POST',
      url: `/runs/${runId}/resume`,
      headers: browserHeaders,
    });
    expect(resumed.json()).toMatchObject({ status: 'running' });
    const progress = await server.inject({
      method: 'POST',
      url: `/collector/runs/${runId}/progress`,
      headers: collectorHeaders,
      payload: {
        feedItemsSeen: 10,
        creatorProfilesSeen: 3,
        candidatesFound: 1,
        elapsedSeconds: 120,
      },
    });
    expect(progress.json()).toMatchObject({ status: 'running', stopReason: null });
    const stopped = await server.inject({
      method: 'POST',
      url: `/collector/runs/${runId}/progress`,
      headers: collectorHeaders,
      payload: {
        feedItemsSeen: 15,
        creatorProfilesSeen: 4,
        candidatesFound: 2,
        elapsedSeconds: 180,
      },
    });
    expect(stopped.json()).toMatchObject({
      status: 'completed',
      stopReason: 'target_candidates',
    });
    const history = await server.inject({
      method: 'GET',
      url: '/collector/runs',
      headers: collectorHeaders,
    });
    expect(history.json().runs).toContainEqual(
      expect.objectContaining({ id: runId, status: 'completed' }),
    );

    const illegalResume = await server.inject({
      method: 'POST',
      url: `/runs/${runId}/resume`,
      headers: browserHeaders,
    });
    expect(illegalResume.statusCode).toBe(409);
    expect(illegalResume.json()).toMatchObject({
      code: 'INVALID_RUN_STATUS_TRANSITION',
      from: 'completed',
      to: 'running',
    });

    const secondRun = await server.inject({
      method: 'POST',
      url: `/campaigns/${campaign.json().id}/runs`,
      headers: browserHeaders,
    });
    const terminated = await server.inject({
      method: 'POST',
      url: `/runs/${secondRun.json().id}/terminate`,
      headers: browserHeaders,
    });
    expect(terminated.json()).toMatchObject({ status: 'terminated' });

    const [storedRuns] = await pool.query<RowDataPacket[]>(
      `SELECT status, stop_reason, progress_json
       FROM collection_runs WHERE id = ?`,
      [runId],
    );
    expect(storedRuns[0]).toMatchObject({
      status: 'completed',
      stop_reason: 'target_candidates',
      progress_json: expect.objectContaining({ candidatesFound: 2 }),
    });
    const listedRuns = await server.inject({
      method: 'GET',
      url: `/runs?campaignId=${campaign.json().id}`,
      headers: browserHeaders,
    });
    expect(listedRuns.statusCode).toBe(200);
    expect(listedRuns.json().runs).toContainEqual(
      expect.objectContaining({
        id: runId,
        campaignName: '运行状态 API 任务',
        status: 'completed',
        stopReason: 'target_candidates',
        progress: expect.objectContaining({ candidatesFound: 2 }),
        device: expect.objectContaining({ name: '运行测试电脑' }),
      }),
    );
    await server.close();
  });
});
