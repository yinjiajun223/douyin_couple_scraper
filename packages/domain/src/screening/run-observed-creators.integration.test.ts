import type { Pool, RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { COLLECTOR_PROTOCOL_VERSION, createDefaultCampaignRuleSet } from '@douyin/contracts';
import type { CreatorObservation, PostObservation } from '@douyin/contracts';

import { bootstrapFirstAdmin } from '../auth/bootstrap-admin.js';
import type { DevicePrincipal } from '../auth/devices.js';
import { createCampaign } from '../campaigns/campaign-service.js';
import {
  CollectionRunNotFoundError,
  claimCollectionRun,
  createCollectionRun,
  startClaimedCollectionRun,
} from '../campaigns/run-service.js';
import { createMysqlPool, runMigrations } from '../database/migrations.js';
import { seedInitialWorkspace } from '../database/seed.js';
import { ingestCollectorBatch } from '../ingestion/collector-ingestion.js';
import { listRunObservedCreators } from './run-observed-creators.js';

const databaseUrl = process.env.MYSQL_TEST_URL;
const describeWithMysql = databaseUrl ? describe : describe.skip;

const workspaceId = '2b000000-0000-4000-8000-000000000001';
const foreignWorkspaceId = '2b000000-0000-4000-8000-000000000002';
const deviceId = '2c000000-0000-4000-8000-000000000001';
const observationId = (suffix: string) => `2d000000-0000-4000-8000-0000000000${suffix}`;
const missingRunId = '2e000000-0000-4000-8000-0000000000ff';

describeWithMysql('未入库达人的硬筛结论重算', () => {
  let pool: Pool;
  let device: DevicePrincipal;
  let actorUserId: string;
  let runId: string;
  let emptyRunId: string;

  beforeAll(async () => {
    pool = createMysqlPool(databaseUrl!);
    await runMigrations(pool);
    await seedInitialWorkspace(pool, {
      workspaceId,
      workspaceSlug: 'run-recompute-test',
      workspaceName: '重算测试',
    });
    const admin = await bootstrapFirstAdmin(pool, {
      workspaceId,
      email: 'run-recompute@example.test',
      displayName: '重算管理员',
      password: 'StrongRunRecompute2026',
    });
    actorUserId = admin.userId;
    await pool.execute(
      `INSERT INTO devices
       (id, workspace_id, owner_user_id, name, token_hash, collector_version, parser_version)
       VALUES (?, ?, ?, '重算设备', ?, '1.0.0', '1.0.0')`,
      [deviceId, workspaceId, actorUserId, deviceId.replaceAll('-', '').padEnd(64, '0')],
    );
    device = {
      collectorVersion: '1.0.0',
      deviceId,
      name: '重算设备',
      ownerUserId: actorUserId,
      parserVersion: '1.0.0',
      workspaceId,
    };

    const campaign = await createCampaign(pool, {
      actorUserId,
      name: '重算任务',
      recommendationProfileDescription: '校园推荐流',
      rules: createDefaultCampaignRuleSet(),
      workspaceId,
    });
    runId = await startRun(campaign.id);
    emptyRunId = await startRun(campaign.id);

    await ingestBatch(runId, 'recompute-batch-main', [
      profile({
        // 粉丝数越界：明确不通过、不入库，但仍要能解释原因。
        observationId: observationId('11'),
        platformCreatorId: 'recompute-fail',
        nickname: '粉丝超上限',
        followerCount: 7_000,
        posts: [viralPost('recompute-fail-post')],
      }),
      profile({
        // 作品点赞数无法识别：作品规则按未知处理，不得当成 0 判负。
        observationId: observationId('12'),
        platformCreatorId: 'recompute-unknown',
        nickname: '点赞数缺失',
        followerCount: 1_200,
        posts: [
          {
            ...viralPost('recompute-unknown-post'),
            likeCount: null,
            likeCountRaw: null,
          },
        ],
      }),
      profile({
        // 全部达标：入库，重算结论应与已落库的 rule_evaluations 一致。
        observationId: observationId('13'),
        platformCreatorId: 'recompute-pass',
        nickname: '达标达人',
        followerCount: 1_200,
        posts: [viralPost('recompute-pass-post')],
      }),
      profile({
        // 粉丝数也无法识别且没有作品：两条规则都未知，字段保持 null。
        observationId: observationId('14'),
        platformCreatorId: 'recompute-missing',
        nickname: '主页未解析',
        followerCount: null,
        posts: [],
      }),
    ]);

    // 同一达人在同一次运行中被观察两次：首次达标入库，复采掉出区间。
    await ingestBatch(runId, 'recompute-batch-first-sighting', [
      profile({
        observationId: observationId('21'),
        platformCreatorId: 'recompute-repeat',
        nickname: '先达标',
        followerCount: 1_200,
        observedAt: '2026-09-14T08:00:00.000Z',
        posts: [viralPost('recompute-repeat-post')],
      }),
    ]);
    await ingestBatch(runId, 'recompute-batch-second-sighting', [
      profile({
        observationId: observationId('22'),
        platformCreatorId: 'recompute-repeat',
        nickname: '后掉出区间',
        followerCount: 7_000,
        observedAt: '2026-09-15T08:00:00.000Z',
        posts: [],
      }),
    ]);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('为未入库达人重算出结论与依据字段，为已入库达人标出候选与阶段', async () => {
    const verdicts = await listRunObservedCreators(pool, { runId, workspaceId });
    const byCreator = new Map(verdicts.map((verdict) => [verdict.platformCreatorId, verdict]));
    expect([...byCreator.keys()].sort()).toEqual([
      'recompute-fail',
      'recompute-missing',
      'recompute-pass',
      'recompute-repeat',
      'recompute-unknown',
    ]);

    const failed = byCreator.get('recompute-fail')!;
    expect(failed).toMatchObject({
      admitted: false,
      candidateId: null,
      creatorId: expect.any(String),
      followerCount: 7_000,
      followerCountRaw: '7000',
      nickname: '粉丝超上限',
      observationId: observationId('11'),
      observedAt: new Date('2026-09-14T08:00:00.000Z'),
      outcome: 'fail',
      pipelineStatus: null,
      profileUrl: 'https://www.douyin.com/user/recompute-fail',
    });
    expect(failed.evaluations).toEqual([
      {
        evidence: {
          maximum: 5_000,
          minimum: 0,
          observedRawValue: '7000',
          observedValue: 7_000,
        },
        outcome: 'fail',
        ruleId: 'followers',
        ruleType: 'follower-range',
      },
      expect.objectContaining({
        outcome: 'pass',
        ruleId: 'recent-viral-post',
        ruleType: 'recent-post-likes',
      }),
    ]);
    const matchedPosts = failed.evaluations[1]!.evidence.matchedPosts as Array<
      Record<string, unknown>
    >;
    expect(matchedPosts).toEqual([
      expect.objectContaining({
        likeCount: 15_000,
        likeCountRaw: '1.5万',
        postUrl: 'https://www.douyin.com/video/recompute-fail-post',
        publishedAt: '2026-09-10T08:00:00.000Z',
      }),
    ]);

    const admitted = byCreator.get('recompute-pass')!;
    expect(admitted).toMatchObject({
      admitted: true,
      candidateId: expect.any(String),
      followerCount: 1_200,
      outcome: 'pass',
      pipelineStatus: 'pending_review',
    });
  });

  it('缺失字段保持 null，未知结论不被当成不通过', async () => {
    const verdicts = await listRunObservedCreators(pool, { runId, workspaceId });
    const unknown = verdicts.find((verdict) => verdict.platformCreatorId === 'recompute-unknown')!;
    expect(unknown).toMatchObject({ admitted: false, candidateId: null, outcome: 'unknown' });
    const postRule = unknown.evaluations.find(
      (evaluation) => evaluation.ruleId === 'recent-viral-post',
    )!;
    expect(postRule.outcome).toBe('unknown');
    expect(postRule.evidence.matchedPosts).toEqual([]);
    expect(postRule.evidence.unknownPosts).toEqual([
      expect.objectContaining({
        likeCount: null,
        likeCountRaw: null,
        postUrl: 'https://www.douyin.com/video/recompute-unknown-post',
        publishedAt: '2026-09-10T08:00:00.000Z',
      }),
    ]);

    const missing = verdicts.find((verdict) => verdict.platformCreatorId === 'recompute-missing')!;
    expect(missing).toMatchObject({
      admitted: false,
      followerCount: null,
      followerCountRaw: null,
      outcome: 'unknown',
    });
    expect(missing.evaluations).toEqual([
      expect.objectContaining({
        evidence: expect.objectContaining({ reason: 'missing_follower_count' }),
        outcome: 'unknown',
        ruleId: 'followers',
      }),
      expect.objectContaining({ outcome: 'unknown', ruleId: 'recent-viral-post' }),
    ]);
  });

  it('重算结论与该候选已落库的规则评估逐条一致', async () => {
    const verdicts = await listRunObservedCreators(pool, { runId, workspaceId });
    const admitted = verdicts.find((verdict) => verdict.platformCreatorId === 'recompute-pass')!;
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT rule_key, outcome FROM rule_evaluations
       WHERE workspace_id = ? AND creator_observation_id = ?`,
      [workspaceId, admitted.observationId],
    );
    const persisted = rows
      .map((row) => `${row.rule_key as string}=${row.outcome as string}`)
      .sort();
    const recomputed = admitted.evaluations
      .map((evaluation) => `${evaluation.ruleId}=${evaluation.outcome}`)
      .sort();
    expect(persisted).toEqual(recomputed);
  });

  it('未入库达人没有任何规则评估行，判定依据只来自重算', async () => {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS total FROM rule_evaluations evaluations
       WHERE evaluations.workspace_id = ? AND evaluations.creator_observation_id IN (?, ?, ?)`,
      [workspaceId, observationId('11'), observationId('12'), observationId('14')],
    );
    expect(Number(rows[0]!.total)).toBe(0);
  });

  it('同一达人多次观测只给一条结论，以最新观测为准且不撤销已入库资格', async () => {
    const verdicts = await listRunObservedCreators(pool, { runId, workspaceId });
    const repeated = verdicts.filter((verdict) => verdict.platformCreatorId === 'recompute-repeat');
    expect(repeated).toHaveLength(1);
    expect(repeated[0]).toMatchObject({
      admitted: true,
      candidateId: expect.any(String),
      followerCount: 7_000,
      nickname: '后掉出区间',
      observationId: observationId('22'),
      outcome: 'fail',
      pipelineStatus: 'pending_review',
    });
  });

  it('没有观测的运行返回空列表，找不到或跨工作区的运行报同一个错误', async () => {
    await expect(
      listRunObservedCreators(pool, { runId: emptyRunId, workspaceId }),
    ).resolves.toEqual([]);
    await expect(
      listRunObservedCreators(pool, { runId, workspaceId: foreignWorkspaceId }),
    ).rejects.toBeInstanceOf(CollectionRunNotFoundError);
    await expect(
      listRunObservedCreators(pool, { runId: missingRunId, workspaceId }),
    ).rejects.toBeInstanceOf(CollectionRunNotFoundError);
  });

  async function startRun(campaignId: string) {
    const run = await createCollectionRun(pool, { actorUserId, campaignId, workspaceId });
    await claimCollectionRun(pool, { deviceId, runId: run.id, workspaceId });
    await startClaimedCollectionRun(pool, { deviceId, runId: run.id, workspaceId });
    return run.id;
  }

  async function ingestBatch(
    targetRunId: string,
    idempotencyKey: string,
    observations: CreatorObservation[],
  ) {
    await ingestCollectorBatch(pool, device, {
      collectorVersion: '1.0.0',
      deviceId,
      idempotencyKey,
      observations,
      parserVersion: '1.0.0',
      protocolVersion: COLLECTOR_PROTOCOL_VERSION,
      runId: targetRunId,
    });
  }
});

function viralPost(platformPostId: string): PostObservation {
  return {
    caption: '校园日常',
    likeCount: 15_000,
    likeCountRaw: '1.5万',
    observedAt: '2026-09-14T08:00:00.000Z',
    platformPostId,
    postUrl: `https://www.douyin.com/video/${platformPostId}`,
    publishedAt: '2026-09-10T08:00:00.000Z',
    screenshotLocalId: null,
  };
}

function profile(input: {
  followerCount: number | null;
  nickname: string;
  observationId: string;
  observedAt?: string;
  platformCreatorId: string;
  posts: PostObservation[];
}): CreatorObservation {
  return {
    biography: null,
    followerCount: input.followerCount,
    followerCountRaw: input.followerCount === null ? null : String(input.followerCount),
    nickname: input.nickname,
    observationId: input.observationId,
    observedAt: input.observedAt ?? '2026-09-14T08:00:00.000Z',
    parserConfidence: 0.98,
    platform: 'douyin',
    platformCreatorId: input.platformCreatorId,
    posts: input.posts,
    profileUrl: `https://www.douyin.com/user/${input.platformCreatorId}`,
  };
}
