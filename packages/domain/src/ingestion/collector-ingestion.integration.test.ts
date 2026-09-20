import type { Pool, RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { COLLECTOR_PROTOCOL_VERSION, createDefaultCampaignRuleSet } from '@douyin/contracts';

import { bootstrapFirstAdmin } from '../auth/bootstrap-admin.js';
import type { DevicePrincipal } from '../auth/devices.js';
import { archiveCampaign, createCampaign } from '../campaigns/campaign-service.js';
import { getCandidateDetail } from '../candidates/candidate-library.js';
import {
  getCandidateWorkflow,
  submitManualReview,
  transitionCandidatePipeline,
} from '../candidates/candidate-workflow.js';
import {
  claimCollectionRun,
  createCollectionRun,
  startClaimedCollectionRun,
} from '../campaigns/run-service.js';
import { createMysqlPool, runMigrations } from '../database/migrations.js';
import { seedInitialWorkspace } from '../database/seed.js';
import {
  confirmMediaUpload,
  issueMediaAccessUrl,
  issueMediaUpload,
} from '../media/media-service.js';
import type { ObjectStorageClient } from '../media/object-storage.js';
import { ingestCollectorBatch } from './collector-ingestion.js';

const databaseUrl = process.env.MYSQL_TEST_URL;
const describeWithMysql = databaseUrl ? describe : describe.skip;

describeWithMysql('Collector 规范化与跨来源去重', () => {
  const workspaceId = '22000000-0000-4000-8000-000000000001';
  const deviceOneId = '23000000-0000-4000-8000-000000000001';
  const deviceTwoId = '23000000-0000-4000-8000-000000000002';
  let pool: Pool;
  let actorUserId: string;
  const adminAccess = () => ({ actorRole: 'admin' as const, actorUserId, workspaceId });

  beforeAll(async () => {
    pool = createMysqlPool(databaseUrl!);
    await runMigrations(pool);
    await seedInitialWorkspace(pool, {
      workspaceId,
      workspaceSlug: 'ingestion-dedup-test',
      workspaceName: '同步去重测试',
    });
    const admin = await bootstrapFirstAdmin(pool, {
      workspaceId,
      email: 'ingestion-dedup@example.test',
      displayName: '同步去重管理员',
      password: 'StrongIngestionDedup2026',
    });
    actorUserId = admin.userId;
    for (const [id, name] of [
      [deviceOneId, '采集设备一'],
      [deviceTwoId, '采集设备二'],
    ] as const) {
      await pool.execute(
        `INSERT INTO devices
         (id, workspace_id, owner_user_id, name, token_hash, collector_version, parser_version)
         VALUES (?, ?, ?, ?, ?, '1.0.0', '1.0.0')`,
        [id, workspaceId, actorUserId, name, id.replaceAll('-', '').padEnd(64, '0')],
      );
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  it('两个设备在不同任务发现同一账号时共享主档案并保留两条来源', async () => {
    const principals: DevicePrincipal[] = [
      {
        deviceId: deviceOneId,
        workspaceId,
        ownerUserId: actorUserId,
        name: '采集设备一',
        collectorVersion: '1.0.0',
        parserVersion: '1.0.0',
      },
      {
        deviceId: deviceTwoId,
        workspaceId,
        ownerUserId: actorUserId,
        name: '采集设备二',
        collectorVersion: '1.0.0',
        parserVersion: '1.0.0',
      },
    ];
    const campaignIds: string[] = [];
    const runIds: string[] = [];
    for (let index = 0; index < principals.length; index += 1) {
      const campaign = await createCampaign(pool, {
        workspaceId,
        actorUserId,
        name: `跨来源任务 ${index + 1}`,
        recommendationProfileDescription: '校园推荐流',
        rules: createDefaultCampaignRuleSet(),
      });
      const run = await createCollectionRun(pool, {
        workspaceId,
        actorUserId,
        campaignId: campaign.id,
      });
      await claimCollectionRun(pool, {
        workspaceId,
        runId: run.id,
        deviceId: principals[index]!.deviceId,
      });
      await startClaimedCollectionRun(pool, {
        workspaceId,
        runId: run.id,
        deviceId: principals[index]!.deviceId,
      });
      campaignIds.push(campaign.id);
      runIds.push(run.id);
    }

    for (let index = 0; index < principals.length; index += 1) {
      await ingestCollectorBatch(pool, principals[index]!, {
        protocolVersion: COLLECTOR_PROTOCOL_VERSION,
        collectorVersion: '1.0.0',
        parserVersion: '1.0.0',
        deviceId: principals[index]!.deviceId,
        runId: runIds[index],
        idempotencyKey: `shared-creator-batch-${index + 1}`,
        observations: [
          {
            observationId:
              index === 0
                ? '24000000-0000-4000-8000-000000000001'
                : '24000000-0000-4000-8000-000000000002',
            platform: 'douyin',
            platformCreatorId: 'shared-creator-stable-id',
            profileUrl: `https://douyin.com/user/shared-creator-stable-id?from=device-${index + 1}`,
            nickname: index === 0 ? '小影同学' : '小影同学的新昵称',
            biography: '校园生活',
            followerCount: index === 0 ? 1_100 : 1_350,
            followerCountRaw: index === 0 ? '1100' : '1350',
            observedAt: index === 0 ? '2026-09-14T08:00:00.000Z' : '2026-09-15T08:00:00.000Z',
            parserConfidence: 0.98,
            posts: [
              {
                platformPostId: 'shared-post-stable-id',
                postUrl: `https://www.douyin.com/video/shared-post-stable-id?from=device-${index + 1}`,
                caption: '校园日常',
                likeCount: index === 0 ? 11_000 : 15_000,
                likeCountRaw: index === 0 ? '1.1万' : '1.5万',
                publishedAt: '2026-09-10T08:00:00.000Z',
                observedAt: index === 0 ? '2026-09-14T08:00:00.000Z' : '2026-09-15T08:00:00.000Z',
                screenshotLocalId: null,
              },
            ],
          },
        ],
      });
    }

    const [creators] = await pool.query<RowDataPacket[]>(
      `SELECT id, canonical_profile_url FROM creators
       WHERE workspace_id = ? AND platform_creator_id = 'shared-creator-stable-id'`,
      [workspaceId],
    );
    const creatorId = creators[0]!.id as string;
    const [posts] = await pool.query<RowDataPacket[]>(
      `SELECT canonical_post_url FROM posts
       WHERE workspace_id = ? AND platform_post_id = 'shared-post-stable-id'`,
      [workspaceId],
    );
    const [observations] = await pool.query<RowDataPacket[]>(
      'SELECT follower_count FROM creator_observations WHERE creator_id = ? ORDER BY observed_at',
      [creatorId],
    );
    const [postObservations] = await pool.query<RowDataPacket[]>(
      `SELECT post_observations.id FROM post_observations
       JOIN posts ON posts.id = post_observations.post_id
       WHERE posts.workspace_id = ? AND posts.platform_post_id = 'shared-post-stable-id'`,
      [workspaceId],
    );
    const [sources] = await pool.query<RowDataPacket[]>(
      'SELECT run_id, device_id FROM run_creator_sources WHERE creator_id = ?',
      [creatorId],
    );
    const [candidates] = await pool.query<RowDataPacket[]>(
      'SELECT id, campaign_id FROM campaign_candidates WHERE creator_id = ?',
      [creatorId],
    );

    expect(creators).toEqual([
      expect.objectContaining({
        canonical_profile_url: 'https://www.douyin.com/user/shared-creator-stable-id',
      }),
    ]);
    expect(posts).toEqual([
      expect.objectContaining({
        canonical_post_url: 'https://www.douyin.com/video/shared-post-stable-id',
      }),
    ]);
    expect(observations.map((row) => Number(row.follower_count))).toEqual([1_100, 1_350]);
    expect(postObservations).toHaveLength(2);
    expect(new Set(sources.map((row) => row.run_id))).toEqual(new Set(runIds));
    expect(new Set(sources.map((row) => row.device_id))).toEqual(
      new Set([deviceOneId, deviceTwoId]),
    );
    expect(new Set(candidates.map((row) => row.campaign_id))).toEqual(new Set(campaignIds));

    const firstCampaignCandidate = candidates.find((row) => row.campaign_id === campaignIds[0])!;
    const detail = await getCandidateDetail(
      pool,
      adminAccess(),
      firstCampaignCandidate.id as string,
    );
    expect(detail.observations.map((observation) => observation.followerCount)).toEqual([
      1_350, 1_100,
    ]);
    expect(detail.sources).toHaveLength(2);
    expect(new Set(detail.sources.map((source) => source.campaignId))).toEqual(
      new Set(campaignIds),
    );
    expect(detail.evaluations).toContainEqual(
      expect.objectContaining({
        ruleKey: 'recent-viral-post',
        ruleVersion: 1,
        ruleSnapshot: expect.objectContaining({ schemaVersion: 2 }),
        matchedPost: expect.objectContaining({
          likeCount: 11_000,
          likeCountRaw: '1.1万',
          url: 'https://www.douyin.com/video/shared-post-stable-id',
        }),
      }),
    );

    const oldObservationId = '24000000-0000-4000-8000-000000000001';
    await pool.execute(
      `INSERT INTO media_objects
       (id, workspace_id, creator_observation_id, object_key, purpose, mime_type,
        byte_size, checksum_sha256, status, confirmed_at)
       VALUES (?, ?, ?, ?, 'profile_screenshot', 'image/webp', 2048, ?, 'confirmed', CURRENT_TIMESTAMP(3))`,
      [
        '29000000-0000-4000-8000-000000000001',
        workspaceId,
        oldObservationId,
        `${workspaceId}/${runIds[0]!}/29000000-0000-4000-8000-000000000001.webp`,
        'a'.repeat(64),
      ],
    );
    await archiveCampaign(pool, workspaceId, campaignIds[0]!, actorUserId);
    await expect(
      pool.execute('DELETE FROM campaigns WHERE id = ?', [campaignIds[0]!]),
    ).rejects.toMatchObject({ code: 'ER_ROW_IS_REFERENCED_2' });

    const [campaignStates] = await pool.query<RowDataPacket[]>(
      'SELECT id, status FROM campaigns WHERE id IN (?, ?) ORDER BY id',
      campaignIds,
    );
    const [preservedFacts] = await pool.query<RowDataPacket[]>(
      `SELECT
         (SELECT COUNT(*) FROM creators WHERE id = ?) AS creator_count,
         (SELECT COUNT(*) FROM creator_observations WHERE creator_id = ?) AS observation_count,
         (SELECT COUNT(*) FROM campaign_candidates WHERE creator_id = ?) AS candidate_count,
         (SELECT COUNT(*) FROM media_objects WHERE creator_observation_id = ?) AS media_count,
         (SELECT COUNT(*) FROM audit_events WHERE subject_id = ? AND action = 'campaign.rules_updated') AS audit_count`,
      [creatorId, creatorId, creatorId, oldObservationId, campaignIds[0]],
    );
    expect(new Map(campaignStates.map((row) => [row.id, row.status]))).toEqual(
      new Map([
        [campaignIds[0], 'archived'],
        [campaignIds[1], 'active'],
      ]),
    );
    expect(preservedFacts[0]).toMatchObject({
      creator_count: 1,
      observation_count: 2,
      candidate_count: 2,
      media_count: 1,
    });
    expect(Number(preservedFacts[0]?.audit_count)).toBeGreaterThanOrEqual(2);
  });

  it('串联默认规则、OSS 证据与人工复核，并保留通过/失败/未知结论', async () => {
    const configuredRules = createDefaultCampaignRuleSet();
    const campaign = await createCampaign(pool, {
      workspaceId,
      actorUserId,
      name: '三态候选测试任务',
      recommendationProfileDescription: '校园推荐流',
      rules: configuredRules,
    });
    const run = await createCollectionRun(pool, {
      workspaceId,
      actorUserId,
      campaignId: campaign.id,
    });
    await claimCollectionRun(pool, { workspaceId, runId: run.id, deviceId: deviceOneId });
    await startClaimedCollectionRun(pool, {
      workspaceId,
      runId: run.id,
      deviceId: deviceOneId,
    });
    const principal: DevicePrincipal = {
      deviceId: deviceOneId,
      workspaceId,
      ownerUserId: actorUserId,
      name: '采集设备一',
      collectorVersion: '1.0.0',
      parserVersion: '1.0.0',
    };
    const candidateCases = [
      {
        observationId: '25000000-0000-4000-8000-000000000001',
        creatorId: 'candidate-pass',
        followerCount: 1_200,
        followerCountRaw: '1200',
      },
      {
        observationId: '25000000-0000-4000-8000-000000000002',
        creatorId: 'candidate-fail',
        followerCount: 6_200,
        followerCountRaw: '6200',
      },
      {
        observationId: '25000000-0000-4000-8000-000000000003',
        creatorId: 'candidate-unknown',
        followerCount: null,
        followerCountRaw: '--',
      },
      {
        observationId: '25000000-0000-4000-8000-000000000004',
        creatorId: 'candidate-pass-2',
        followerCount: 900,
        followerCountRaw: '900',
      },
    ] as const;
    await ingestCollectorBatch(pool, principal, {
      protocolVersion: COLLECTOR_PROTOCOL_VERSION,
      collectorVersion: '1.0.0',
      parserVersion: '1.0.0',
      deviceId: deviceOneId,
      runId: run.id,
      idempotencyKey: 'tri-state-candidate-batch-0001',
      observations: candidateCases.map((candidate, index) => ({
        observationId: candidate.observationId,
        platform: 'douyin',
        platformCreatorId: candidate.creatorId,
        profileUrl: `https://www.douyin.com/user/${candidate.creatorId}`,
        nickname: `三态候选 ${index + 1}`,
        biography: '校园生活',
        followerCount: candidate.followerCount,
        followerCountRaw: candidate.followerCountRaw,
        observedAt: '2026-09-15T08:00:00.000Z',
        parserConfidence: 0.98,
        posts: [
          {
            platformPostId: `${candidate.creatorId}-viral-post`,
            postUrl: `https://www.douyin.com/video/${candidate.creatorId}-viral-post`,
            caption: '校园爆款记录',
            likeCount: 12_000,
            likeCountRaw: '1.2万',
            publishedAt: '2026-09-10T08:00:00.000Z',
            observedAt: '2026-09-15T08:00:00.000Z',
            screenshotLocalId: null,
          },
        ],
      })),
    });

    const [candidates] = await pool.query<RowDataPacket[]>(
      `SELECT creators.platform_creator_id, candidates.hard_filter_status,
              candidates.pipeline_status
       FROM campaign_candidates candidates
       JOIN creators ON creators.id = candidates.creator_id
       WHERE candidates.campaign_id = ?
       ORDER BY creators.platform_creator_id`,
      [campaign.id],
    );
    expect(candidates).toEqual([
      expect.objectContaining({
        platform_creator_id: 'candidate-fail',
        hard_filter_status: 'fail',
        pipeline_status: 'pending_review',
      }),
      expect.objectContaining({
        platform_creator_id: 'candidate-pass',
        hard_filter_status: 'pass',
        pipeline_status: 'pending_review',
      }),
      expect.objectContaining({
        platform_creator_id: 'candidate-pass-2',
        hard_filter_status: 'pass',
        pipeline_status: 'pending_review',
      }),
      expect.objectContaining({
        platform_creator_id: 'candidate-unknown',
        hard_filter_status: 'unknown',
        pipeline_status: 'pending_review',
      }),
    ]);

    const [passCandidateRows] = await pool.query<RowDataPacket[]>(
      `SELECT candidates.id FROM campaign_candidates candidates
       JOIN creators ON creators.id = candidates.creator_id
       WHERE candidates.campaign_id = ? AND creators.platform_creator_id = 'candidate-pass'`,
      [campaign.id],
    );
    const candidateId = passCandidateRows[0]!.id as string;
    const checksumSha256 = 'c'.repeat(64);
    let uploadedObjectKey = '';
    const storage: ObjectStorageClient = {
      createSignedGetUrl: async ({ objectKey }) =>
        `https://private-oss.example/${objectKey}?signature=short-lived`,
      createSignedPutUrl: async ({ objectKey }) => {
        uploadedObjectKey = objectKey;
        return `https://private-oss.example/${objectKey}?signature=short-lived-put`;
      },
      deleteObject: async () => undefined,
      headObject: async (objectKey) => ({
        byteSize: 4_096,
        checksumSha256,
        contentType: 'image/webp',
        etag: objectKey === uploadedObjectKey ? 'confirmed-etag' : null,
      }),
    };
    const mediaUpload = await issueMediaUpload(pool, storage, principal, run.id, {
      byteSize: 4_096,
      checksumSha256,
      creatorObservationId: '25000000-0000-4000-8000-000000000001',
      mimeType: 'image/webp',
      purpose: 'profile_screenshot',
    });
    expect(new URL(mediaUpload.uploadUrl).host).toBe('private-oss.example');
    await confirmMediaUpload(pool, storage, principal, run.id, mediaUpload.id, {
      byteSize: 4_096,
      checksumSha256,
      creatorObservationId: '25000000-0000-4000-8000-000000000001',
    });
    const mediaAccess = await issueMediaAccessUrl(pool, storage, adminAccess(), mediaUpload.id);
    expect(new URL(mediaAccess.downloadUrl).host).toBe('private-oss.example');

    const [evaluations] = await pool.query<RowDataPacket[]>(
      `SELECT creators.platform_creator_id, evaluations.rule_key, evaluations.outcome,
              evaluations.matched_post_observation_id, evaluations.evidence_json
       FROM rule_evaluations evaluations
       JOIN campaign_candidates candidates ON candidates.id = evaluations.candidate_id
       JOIN creators ON creators.id = candidates.creator_id
       WHERE evaluations.run_id = ?
       ORDER BY creators.platform_creator_id, evaluations.rule_key`,
      [run.id],
    );
    expect(evaluations).toHaveLength(8);
    expect(evaluations).toContainEqual(
      expect.objectContaining({
        platform_creator_id: 'candidate-unknown',
        rule_key: 'followers',
        outcome: 'unknown',
      }),
    );
    const passViralEvidence = evaluations.find(
      (row) => row.platform_creator_id === 'candidate-pass' && row.rule_key === 'recent-viral-post',
    );
    expect(passViralEvidence).toMatchObject({
      outcome: 'pass',
      matched_post_observation_id: expect.any(String),
      evidence_json: expect.objectContaining({
        minimumLikes: 10_000,
        matchedPosts: [
          expect.objectContaining({
            likeCount: 12_000,
            postUrl: 'https://www.douyin.com/video/candidate-pass-viral-post',
          }),
        ],
      }),
    });

    const review = await submitManualReview(pool, {
      actorRole: 'admin',
      actorUserId,
      candidateId,
      decision: 'approved',
      expectedVersion: 1,
      reason: '人工核对公开主页与爆款证据后通过',
      workspaceId,
    });
    const pipeline = await transitionCandidatePipeline(pool, {
      actorRole: 'admin',
      actorUserId,
      candidateId,
      expectedVersion: review.version,
      nextStatus: 'to_contact',
      note: '进入待联系池',
      workspaceId,
    });
    const detail = await getCandidateDetail(pool, adminAccess(), candidateId);
    const workflow = await getCandidateWorkflow(pool, adminAccess(), candidateId);
    expect(pipeline).toMatchObject({ status: 'to_contact', version: 3 });
    expect(detail.media).toContainEqual(
      expect.objectContaining({ id: mediaUpload.id, purpose: 'profile_screenshot' }),
    );
    expect(workflow).toMatchObject({
      candidateVersion: 3,
      pipelineStatus: 'to_contact',
      reviews: [expect.objectContaining({ decision: 'approved' })],
    });
  });
});
