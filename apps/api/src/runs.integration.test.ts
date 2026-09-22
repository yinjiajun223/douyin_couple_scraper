import type { Pool, RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { COLLECTOR_PROTOCOL_VERSION, createDefaultCampaignRuleSet } from '@douyin/contracts';
import {
  acceptInvitation,
  bootstrapFirstAdmin,
  createInvitation,
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
  const foreignWorkspaceId = '1f000000-0000-4000-8000-000000000009';
  const credentials = {
    workspaceId,
    email: 'run-api-admin@example.test',
    displayName: '运行 API 管理员',
    password: 'StrongRunApiAdmin2026',
  };
  const foreignCredentials = {
    workspaceId: foreignWorkspaceId,
    email: 'run-api-foreign@example.test',
    displayName: '外部工作区管理员',
    password: 'StrongRunApiForeign2026',
  };
  let pool: Pool;
  let adminUserId: string;

  beforeAll(async () => {
    pool = createMysqlPool(databaseUrl!);
    await runMigrations(pool);
    await seedInitialWorkspace(pool, {
      workspaceId,
      workspaceSlug: 'run-api-test',
      workspaceName: '运行 API 测试',
    });
    await seedInitialWorkspace(pool, {
      workspaceId: foreignWorkspaceId,
      workspaceSlug: 'run-api-foreign-test',
      workspaceName: '外部运行 API 测试',
    });
    adminUserId = (await bootstrapFirstAdmin(pool, credentials)).userId;
    await bootstrapFirstAdmin(pool, foreignCredentials);
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

  it('运行详情可重算未入库达人的判定依据，只读成员同样可读，越权与不存在同为 404', async () => {
    const server = buildServer({ pool, logger: false, secureCookies: true });
    const browserHeaders = await sessionHeaders(server, credentials);
    const readonlyEmail = 'run-api-readonly@example.test';
    const readonlyPassword = 'StrongRunApiReadonly2026';
    const invitation = await createInvitation(pool, {
      workspaceId,
      email: readonlyEmail,
      role: 'readonly',
      invitedByUserId: adminUserId,
      expiresInSeconds: 3600,
    });
    await acceptInvitation(pool, {
      token: invitation.token,
      displayName: '运行只读成员',
      password: readonlyPassword,
    });
    const readonlyHeaders = await sessionHeaders(server, {
      workspaceId,
      email: readonlyEmail,
      password: readonlyPassword,
    });
    const foreignHeaders = await sessionHeaders(server, foreignCredentials);

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
        name: '重算测试电脑',
        collectorVersion: '1.0.0',
        parserVersion: '1.0.0',
      },
    });
    const collectorHeaders = { authorization: `Bearer ${paired.json().token as string}` };
    const deviceId = paired.json().deviceId as string;

    const campaign = await server.inject({
      method: 'POST',
      url: '/campaigns',
      headers: browserHeaders,
      payload: {
        name: '重算依据任务',
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
      headers: collectorHeaders,
    });
    await server.inject({
      method: 'POST',
      url: `/collector/runs/${runId}/start`,
      headers: collectorHeaders,
    });

    const batch = await server.inject({
      method: 'POST',
      url: '/collector/ingestion/batches',
      headers: collectorHeaders,
      payload: {
        protocolVersion: COLLECTOR_PROTOCOL_VERSION,
        collectorVersion: '1.0.0',
        parserVersion: '1.0.0',
        deviceId,
        runId,
        idempotencyKey: 'runs-observed-creators-batch-1',
        observations: [
          {
            observationId: '2f000000-0000-4000-8000-000000000001',
            platform: 'douyin',
            platformCreatorId: 'runs-api-admitted',
            profileUrl: 'https://www.douyin.com/user/runs-api-admitted',
            nickname: '达标达人',
            biography: null,
            followerCount: 1_200,
            followerCountRaw: '1200',
            observedAt: '2026-09-14T08:00:00.000Z',
            parserConfidence: 0.98,
            postsWindowComplete: false,
            posts: [
              {
                platformPostId: 'runs-api-admitted-post',
                postUrl: 'https://www.douyin.com/video/runs-api-admitted-post',
                caption: '校园爆款',
                likeCount: 15_000,
                likeCountRaw: '1.5万',
                publishedAt: '2026-09-10T08:00:00.000Z',
                observedAt: '2026-09-14T08:00:00.000Z',
                screenshotLocalId: null,
              },
            ],
          },
          {
            observationId: '2f000000-0000-4000-8000-000000000002',
            platform: 'douyin',
            platformCreatorId: 'runs-api-rejected',
            profileUrl: 'https://www.douyin.com/user/runs-api-rejected',
            nickname: '粉丝超上限',
            biography: null,
            followerCount: 7_000,
            followerCountRaw: '7000',
            observedAt: '2026-09-14T08:00:00.000Z',
            parserConfidence: 0.98,
            // 采集器对每条观测都上报该值（runtime.ts），重算侧按同一前提处理。
            postsWindowComplete: false,
            posts: [],
          },
        ],
      },
    });
    expect(batch.statusCode).toBe(200);

    const observed = await server.inject({
      method: 'GET',
      url: `/runs/${runId}/observed-creators`,
      headers: browserHeaders,
    });
    expect(observed.statusCode).toBe(200);
    expect(observed.json().creators).toEqual([
      expect.objectContaining({
        admitted: true,
        candidateId: expect.any(String),
        followerCount: 1_200,
        nickname: '达标达人',
        observationId: '2f000000-0000-4000-8000-000000000001',
        outcome: 'pass',
        pipelineStatus: 'pending_review',
        platformCreatorId: 'runs-api-admitted',
      }),
      expect.objectContaining({
        admitted: false,
        candidateId: null,
        evaluations: [
          expect.objectContaining({ outcome: 'fail', ruleId: 'followers' }),
          expect.objectContaining({ outcome: 'unknown', ruleId: 'recent-viral-post' }),
        ],
        followerCount: 7_000,
        followerCountRaw: '7000',
        nickname: '粉丝超上限',
        observationId: '2f000000-0000-4000-8000-000000000002',
        outcome: 'fail',
        pipelineStatus: null,
        platformCreatorId: 'runs-api-rejected',
      }),
    ]);

    // 可见范围是工作区级 campaign:read：只读成员没有设备归属关系，仍能读到同一份依据。
    const readonlyObserved = await server.inject({
      method: 'GET',
      url: `/runs/${runId}/observed-creators`,
      headers: readonlyHeaders,
    });
    expect(readonlyObserved.statusCode).toBe(200);
    expect(readonlyObserved.json()).toEqual(observed.json());

    const foreignObserved = await server.inject({
      method: 'GET',
      url: `/runs/${runId}/observed-creators`,
      headers: foreignHeaders,
    });
    expect(foreignObserved.statusCode).toBe(404);
    expect(foreignObserved.json()).toMatchObject({ code: 'COLLECTION_RUN_NOT_FOUND' });

    const missingObserved = await server.inject({
      method: 'GET',
      url: '/runs/2f000000-0000-4000-8000-0000000000ff/observed-creators',
      headers: browserHeaders,
    });
    expect(missingObserved.statusCode).toBe(404);
    expect(missingObserved.json()).toEqual(foreignObserved.json());

    const anonymous = await server.inject({
      method: 'GET',
      url: `/runs/${runId}/observed-creators`,
    });
    expect(anonymous.statusCode).toBe(401);

    await server.close();
  });

  async function sessionHeaders(
    server: ReturnType<typeof buildServer>,
    account: { email: string; password: string; workspaceId: string },
  ) {
    const login = await server.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {
        workspaceId: account.workspaceId,
        email: account.email,
        password: account.password,
      },
    });
    return {
      cookie: firstHeader(login.headers['set-cookie'])!.split(';')[0]!,
      'x-csrf-token': login.json().csrfToken as string,
    };
  }
});
