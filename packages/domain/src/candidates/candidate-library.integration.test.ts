import { randomUUID } from 'node:crypto';

import type { Pool, RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { COLLECTOR_PROTOCOL_VERSION, createDefaultCampaignRuleSet } from '@douyin/contracts';

import { bootstrapFirstAdmin } from '../auth/bootstrap-admin.js';
import type { DevicePrincipal } from '../auth/devices.js';
import { createCampaign } from '../campaigns/campaign-service.js';
import {
  claimCollectionRun,
  createCollectionRun,
  startClaimedCollectionRun,
} from '../campaigns/run-service.js';
import { createMysqlPool, runMigrations } from '../database/migrations.js';
import { seedInitialWorkspace } from '../database/seed.js';
import { ingestCollectorBatch } from '../ingestion/collector-ingestion.js';
import { listCandidates } from './candidate-library.js';

const databaseUrl = process.env.MYSQL_TEST_URL;
const describeWithMysql = databaseUrl ? describe : describe.skip;

describeWithMysql('共享达人组合过滤', () => {
  const workspaceId = '26000000-0000-4000-8000-000000000001';
  const deviceId = '27000000-0000-4000-8000-000000000001';
  let pool: Pool;
  let actorUserId: string;

  beforeAll(async () => {
    pool = createMysqlPool(databaseUrl!);
    await runMigrations(pool);
    await seedInitialWorkspace(pool, {
      workspaceId,
      workspaceSlug: 'candidate-filter-test',
      workspaceName: '候选过滤测试',
    });
    const admin = await bootstrapFirstAdmin(pool, {
      workspaceId,
      email: 'candidate-filter@example.test',
      displayName: '候选过滤管理员',
      password: 'StrongCandidateFilter2026',
    });
    actorUserId = admin.userId;
    await pool.execute(
      `INSERT INTO devices
       (id, workspace_id, owner_user_id, name, token_hash, collector_version, parser_version)
       VALUES (?, ?, ?, '过滤测试设备', ?, '1.0.0', '1.0.0')`,
      [deviceId, workspaceId, actorUserId, deviceId.replaceAll('-', '').padEnd(64, '0')],
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  it('任务、时间、粉丝、结论、状态、负责人和多个标签按交集生效', async () => {
    const campaign = await createCampaign(pool, {
      workspaceId,
      actorUserId,
      name: '组合过滤任务',
      recommendationProfileDescription: '校园情侣推荐流',
      rules: createDefaultCampaignRuleSet(),
    });
    const run = await createCollectionRun(pool, {
      workspaceId,
      actorUserId,
      campaignId: campaign.id,
    });
    await claimCollectionRun(pool, { workspaceId, runId: run.id, deviceId });
    await startClaimedCollectionRun(pool, { workspaceId, runId: run.id, deviceId });
    const principal: DevicePrincipal = {
      deviceId,
      workspaceId,
      ownerUserId: actorUserId,
      name: '过滤测试设备',
      collectorVersion: '1.0.0',
      parserVersion: '1.0.0',
    };
    const fixtures = [
      {
        observationId: '28000000-0000-4000-8000-000000000001',
        creatorId: 'filter-target',
        nickname: '目标达人',
        followerCount: 1_200,
        observedAt: '2026-09-15T08:00:00.000Z',
      },
      {
        observationId: '28000000-0000-4000-8000-000000000002',
        creatorId: 'filter-one-tag',
        nickname: '只有一个标签',
        followerCount: 2_500,
        observedAt: '2026-09-14T08:00:00.000Z',
      },
      {
        observationId: '28000000-0000-4000-8000-000000000003',
        creatorId: 'filter-old-fail',
        nickname: '过期且失败',
        followerCount: 7_000,
        observedAt: '2026-09-13T08:00:00.000Z',
      },
    ] as const;
    await ingestCollectorBatch(pool, principal, {
      protocolVersion: COLLECTOR_PROTOCOL_VERSION,
      collectorVersion: '1.0.0',
      parserVersion: '1.0.0',
      deviceId,
      runId: run.id,
      idempotencyKey: 'candidate-filter-batch-0001',
      observations: fixtures.map((fixture) => ({
        observationId: fixture.observationId,
        platform: 'douyin',
        platformCreatorId: fixture.creatorId,
        profileUrl: `https://www.douyin.com/user/${fixture.creatorId}`,
        nickname: fixture.nickname,
        biography: '校园日常',
        followerCount: fixture.followerCount,
        followerCountRaw: String(fixture.followerCount),
        observedAt: fixture.observedAt,
        parserConfidence: 0.98,
        posts: [
          {
            platformPostId: `${fixture.creatorId}-post`,
            postUrl: `https://www.douyin.com/video/${fixture.creatorId}-post`,
            caption: '校园爆款',
            likeCount: 12_000,
            likeCountRaw: '1.2万',
            publishedAt: '2026-09-10T08:00:00.000Z',
            observedAt: fixture.observedAt,
            screenshotLocalId: null,
          },
        ],
      })),
    });

    const [candidateRows] = await pool.query<RowDataPacket[]>(
      `SELECT candidates.id, candidates.version, creators.platform_creator_id
       FROM campaign_candidates candidates
       JOIN creators ON creators.id = candidates.creator_id
       WHERE candidates.campaign_id = ?`,
      [campaign.id],
    );
    const candidatesByCreator = new Map(
      candidateRows.map((row) => [row.platform_creator_id as string, row]),
    );
    for (const creatorId of ['filter-target', 'filter-one-tag']) {
      const candidate = candidatesByCreator.get(creatorId)!;
      await pool.execute(
        `UPDATE campaign_candidates
         SET pipeline_status = 'to_contact', assignee_user_id = ?, version = version + 1
         WHERE id = ?`,
        [actorUserId, candidate.id],
      );
      await pool.execute(
        `INSERT INTO manual_reviews
         (id, workspace_id, candidate_id, reviewer_user_id, decision, based_on_candidate_version)
         VALUES (?, ?, ?, ?, 'approved', ?)`,
        [randomUUID(), workspaceId, candidate.id, actorUserId, candidate.version],
      );
    }
    const rejected = candidatesByCreator.get('filter-old-fail')!;
    await pool.execute(
      `UPDATE campaign_candidates SET pipeline_status = 'unsuitable' WHERE id = ?`,
      [rejected.id],
    );
    await pool.execute(
      `INSERT INTO manual_reviews
       (id, workspace_id, candidate_id, reviewer_user_id, decision, based_on_candidate_version)
       VALUES (?, ?, ?, ?, 'rejected', ?)`,
      [randomUUID(), workspaceId, rejected.id, actorUserId, rejected.version],
    );

    const tagIds = new Map<string, string>();
    for (const name of ['校园', '情侣']) {
      const id = randomUUID();
      tagIds.set(name, id);
      await pool.execute('INSERT INTO tags (id, workspace_id, name) VALUES (?, ?, ?)', [
        id,
        workspaceId,
        name,
      ]);
    }
    for (const creatorId of ['filter-target', 'filter-old-fail']) {
      const candidate = candidatesByCreator.get(creatorId)!;
      for (const tagId of tagIds.values()) {
        await pool.execute(
          `INSERT INTO candidate_tags
           (workspace_id, candidate_id, tag_id, created_by_user_id)
           VALUES (?, ?, ?, ?)`,
          [workspaceId, candidate.id, tagId, actorUserId],
        );
      }
    }
    await pool.execute(
      `INSERT INTO candidate_tags
       (workspace_id, candidate_id, tag_id, created_by_user_id)
       VALUES (?, ?, ?, ?)`,
      [workspaceId, candidatesByCreator.get('filter-one-tag')!.id, tagIds.get('校园'), actorUserId],
    );

    const taggedWithBoth = await listCandidates(pool, {
      actorRole: 'admin',
      actorUserId,
      workspaceId,
      campaignId: campaign.id,
      tagNames: ['校园', '情侣'],
    });
    expect(taggedWithBoth.map((candidate) => candidate.platformCreatorId)).toEqual([
      'filter-target',
    ]);

    const failedOnly = await listCandidates(pool, {
      actorRole: 'admin',
      actorUserId,
      workspaceId,
      campaignId: campaign.id,
      hardFilterStatus: 'fail',
      tagNames: ['校园', '情侣'],
    });
    expect(failedOnly.map((candidate) => candidate.platformCreatorId)).toEqual(['filter-old-fail']);

    const intersection = await listCandidates(pool, {
      actorRole: 'admin',
      actorUserId,
      workspaceId,
      campaignId: campaign.id,
      observedFrom: '2026-09-14T00:00:00.000Z',
      followerMin: 1_000,
      followerMax: 5_000,
      hardFilterStatus: 'pass',
      manualDecision: 'approved',
      pipelineStatus: 'to_contact',
      ownerUserId: actorUserId,
      tagNames: ['校园', '情侣'],
    });
    expect(intersection).toEqual([
      expect.objectContaining({
        platformCreatorId: 'filter-target',
        nickname: '目标达人',
        followerCount: 1_200,
        hardFilterStatus: 'pass',
        manualDecision: 'approved',
        pipelineStatus: 'to_contact',
        ownerUserId: null,
        assigneeUserId: actorUserId,
        tags: ['情侣', '校园'],
      }),
    ]);
  });
});
