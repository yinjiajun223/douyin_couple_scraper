import { randomUUID } from 'node:crypto';

import type { Pool, RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { COLLECTOR_PROTOCOL_VERSION, createDefaultCampaignRuleSet } from '@douyin/contracts';

import { bootstrapFirstAdmin } from '../auth/bootstrap-admin.js';
import type { DevicePrincipal } from '../auth/devices.js';
import { acceptInvitation, createInvitation } from '../auth/invitations.js';
import { createCampaign } from '../campaigns/campaign-service.js';
import {
  claimCollectionRun,
  createCollectionRun,
  startClaimedCollectionRun,
} from '../campaigns/run-service.js';
import { createMysqlPool, runMigrations } from '../database/migrations.js';
import { seedInitialWorkspace } from '../database/seed.js';
import { ingestCollectorBatch } from '../ingestion/collector-ingestion.js';
import { listCandidatePage, listCandidates } from './candidate-library.js';

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

    // 入库闸门后 fail 达人不再由采集产生候选行；直接补一行存量数据，
    // 用于验证 hardFilterStatus 显式过滤对历史行仍然生效。
    await pool.execute(
      `INSERT INTO campaign_candidates
       (id, workspace_id, campaign_id, creator_id, latest_run_id,
        latest_creator_observation_id, hard_filter_status)
       SELECT ?, ?, ?, observations.creator_id, ?, observations.id, 'fail'
       FROM creator_observations observations
       WHERE observations.id = ?`,
      [randomUUID(), workspaceId, campaign.id, run.id, '28000000-0000-4000-8000-000000000003'],
    );

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

  it('存量 fail 与 unknown 行都不进默认列表，显式过滤仍受同一记录级可见范围约束', async () => {
    const campaign = await createCampaign(pool, {
      workspaceId,
      actorUserId,
      name: '存量分区隔离任务',
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
        observationId: '31000000-0000-4000-8000-000000000001',
        creatorId: 'legacy-fail',
        nickname: '存量失败',
        followerCount: 7_000,
      },
      {
        observationId: '31000000-0000-4000-8000-000000000002',
        creatorId: 'legacy-unknown',
        nickname: '存量未知',
        followerCount: null,
      },
      {
        observationId: '31000000-0000-4000-8000-000000000003',
        creatorId: 'fresh-pass',
        nickname: '新入库达人',
        followerCount: 1_200,
      },
    ] as const;
    await ingestCollectorBatch(pool, principal, {
      protocolVersion: COLLECTOR_PROTOCOL_VERSION,
      collectorVersion: '1.0.0',
      parserVersion: '1.0.0',
      deviceId,
      runId: run.id,
      idempotencyKey: 'candidate-partition-batch-0001',
      observations: fixtures.map((fixture) => ({
        observationId: fixture.observationId,
        platform: 'douyin',
        platformCreatorId: fixture.creatorId,
        profileUrl: `https://www.douyin.com/user/${fixture.creatorId}`,
        nickname: fixture.nickname,
        biography: '校园日常',
        followerCount: fixture.followerCount,
        followerCountRaw: fixture.followerCount === null ? null : String(fixture.followerCount),
        observedAt: '2026-09-15T08:00:00.000Z',
        parserConfidence: 0.98,
        posts: [
          {
            platformPostId: `${fixture.creatorId}-post`,
            postUrl: `https://www.douyin.com/video/${fixture.creatorId}-post`,
            caption: '校园爆款',
            likeCount: 12_000,
            likeCountRaw: '1.2万',
            publishedAt: '2026-09-10T08:00:00.000Z',
            observedAt: '2026-09-15T08:00:00.000Z',
            screenshotLocalId: null,
          },
        ],
      })),
    });

    // 闸门上线后 fail 与 unknown 观测都不再产生候选行，存量行只能手工补，
    // 用来验证旧数据既不进默认列表，也不因分区轴切到跟进阶段而串进任何分区。
    for (const [observationId, hardFilterStatus] of [
      ['31000000-0000-4000-8000-000000000001', 'fail'],
      ['31000000-0000-4000-8000-000000000002', 'unknown'],
    ] as const) {
      await pool.execute(
        `INSERT INTO campaign_candidates
         (id, workspace_id, campaign_id, creator_id, latest_run_id,
          latest_creator_observation_id, hard_filter_status)
         SELECT ?, ?, ?, observations.creator_id, ?, observations.id, ?
         FROM creator_observations observations
         WHERE observations.id = ?`,
        [randomUUID(), workspaceId, campaign.id, run.id, hardFilterStatus, observationId],
      );
    }

    const creatorIds = async (filters: { hardFilterStatus?: 'pass' | 'fail' | 'unknown' }) =>
      (
        await listCandidates(pool, {
          actorRole: 'admin',
          actorUserId,
          workspaceId,
          campaignId: campaign.id,
          ...filters,
        })
      )
        .map((candidate) => candidate.platformCreatorId)
        .sort();

    // 默认列表与工作台三个计数器同口径：只放行取得入库资格的行。
    expect(await creatorIds({})).toEqual(['fresh-pass']);
    expect(await creatorIds({ hardFilterStatus: 'fail' })).toEqual(['legacy-fail']);
    expect(await creatorIds({ hardFilterStatus: 'unknown' })).toEqual(['legacy-unknown']);
    expect(await creatorIds({ hardFilterStatus: 'pass' })).toEqual(['fresh-pass']);

    const invitation = await createInvitation(pool, {
      workspaceId,
      email: 'candidate-partition-operator@example.test',
      role: 'operator',
      invitedByUserId: actorUserId,
      expiresInSeconds: 3600,
    });
    const operator = await acceptInvitation(pool, {
      token: invitation.token,
      displayName: '分区隔离运营',
      password: 'StrongPartitionOperator2026',
    });
    const asOperator = {
      actorRole: 'operator' as const,
      actorUserId: operator.userId,
      workspaceId,
      campaignId: campaign.id,
    };
    // 设备属于管理员，该运营既没采集过也没被分配，显式 hardFilterStatus 不能绕过记录级可见范围。
    expect(await listCandidates(pool, { ...asOperator, hardFilterStatus: 'fail' })).toEqual([]);

    await pool.execute(
      `UPDATE campaign_candidates SET assignee_user_id = ?
       WHERE workspace_id = ? AND campaign_id = ? AND hard_filter_status = 'fail'`,
      [operator.userId, workspaceId, campaign.id],
    );
    const operatorVisible = await listCandidates(pool, {
      ...asOperator,
      hardFilterStatus: 'fail',
    });
    expect(operatorVisible.map((candidate) => candidate.platformCreatorId)).toEqual([
      'legacy-fail',
    ]);
    // 默认谓词与记录级可见范围取交集：即使已分配给该运营，存量 fail 行仍不进默认列表。
    expect(await listCandidates(pool, asOperator)).toEqual([]);
  });

  it('阶段分区用多值过滤在服务端生效，且游标翻页不重复不遗漏', async () => {
    const campaign = await createCampaign(pool, {
      workspaceId,
      actorUserId,
      name: '阶段分区任务',
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
    const stages = [
      'pending_review',
      'to_contact',
      'contacted',
      'communicating',
      'partnered',
      'unsuitable',
      'declined',
    ] as const;
    const fixtures = [
      ...stages.map((stage, index) => ({
        observationId: `32000000-0000-4000-8000-00000000000${index + 1}`,
        creatorId: `stage-${stage.replaceAll('_', '-')}`,
        followerCount: 1_200,
      })),
      // 第八位粉丝越界，闸门后不产生候选行，手工补一行存量 fail 用来验证默认谓词仍然叠加生效。
      {
        observationId: '32000000-0000-4000-8000-000000000008',
        creatorId: 'stage-legacy-fail',
        followerCount: 7_000,
      },
    ];
    await ingestCollectorBatch(pool, principal, {
      protocolVersion: COLLECTOR_PROTOCOL_VERSION,
      collectorVersion: '1.0.0',
      parserVersion: '1.0.0',
      deviceId,
      runId: run.id,
      idempotencyKey: 'candidate-stage-batch-0001',
      observations: fixtures.map((fixture) => ({
        observationId: fixture.observationId,
        platform: 'douyin',
        platformCreatorId: fixture.creatorId,
        profileUrl: `https://www.douyin.com/user/${fixture.creatorId}`,
        nickname: fixture.creatorId,
        biography: '校园日常',
        followerCount: fixture.followerCount,
        followerCountRaw: String(fixture.followerCount),
        observedAt: '2026-09-15T08:00:00.000Z',
        parserConfidence: 0.98,
        posts: [
          {
            platformPostId: `${fixture.creatorId}-post`,
            postUrl: `https://www.douyin.com/video/${fixture.creatorId}-post`,
            caption: '校园爆款',
            likeCount: 12_000,
            likeCountRaw: '1.2万',
            publishedAt: '2026-09-10T08:00:00.000Z',
            observedAt: '2026-09-15T08:00:00.000Z',
            screenshotLocalId: null,
          },
        ],
      })),
    });
    for (const stage of stages) {
      await pool.execute(
        `UPDATE campaign_candidates candidates
         JOIN creators ON creators.id = candidates.creator_id
         SET candidates.pipeline_status = ?
         WHERE candidates.campaign_id = ? AND creators.platform_creator_id = ?`,
        [stage, campaign.id, `stage-${stage.replaceAll('_', '-')}`],
      );
    }
    await pool.execute(
      `INSERT INTO campaign_candidates
       (id, workspace_id, campaign_id, creator_id, latest_run_id,
        latest_creator_observation_id, hard_filter_status, pipeline_status)
       SELECT ?, ?, ?, observations.creator_id, ?, observations.id, 'fail', 'pending_review'
       FROM creator_observations observations
       WHERE observations.id = ?`,
      [randomUUID(), workspaceId, campaign.id, run.id, '32000000-0000-4000-8000-000000000008'],
    );

    const access = {
      actorRole: 'admin' as const,
      actorUserId,
      workspaceId,
      campaignId: campaign.id,
    };
    const creatorIds = async (pipelineStatuses: readonly string[]) =>
      (await listCandidates(pool, { ...access, pipelineStatuses: [...pipelineStatuses] }))
        .map((candidate) => candidate.platformCreatorId)
        .sort();

    // 五个分区各自覆盖对应的阶段集合，互不重叠。
    expect(await creatorIds(['pending_review'])).toEqual(['stage-pending-review']);
    expect(await creatorIds(['to_contact'])).toEqual(['stage-to-contact']);
    expect(await creatorIds(['contacted', 'communicating'])).toEqual([
      'stage-communicating',
      'stage-contacted',
    ]);
    expect(await creatorIds(['partnered'])).toEqual(['stage-partnered']);
    expect(await creatorIds(['unsuitable', 'declined'])).toEqual([
      'stage-declined',
      'stage-unsuitable',
    ]);
    // 单值过滤保持原样可用，多值与默认「入库资格」谓词叠加：存量 fail 行不进任何分区。
    expect(await creatorIds(['pending_review', 'to_contact'])).toEqual([
      'stage-pending-review',
      'stage-to-contact',
    ]);
    expect(
      (
        await listCandidates(pool, {
          ...access,
          hardFilterStatus: 'fail',
          pipelineStatuses: ['pending_review'],
        })
      ).map((candidate) => candidate.platformCreatorId),
    ).toEqual(['stage-legacy-fail']);

    // 全部观测的 observed_at 相同，first_visible_at 因此完全并列，翻页只能靠 candidates.id 兜底，
    // 正好覆盖游标的并列分支。
    const walked: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listCandidatePage(pool, {
        ...access,
        limit: 2,
        ...(cursor ? { cursor } : {}),
      });
      walked.push(...page.candidates.map((candidate) => candidate.platformCreatorId));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(walked).toHaveLength(new Set(walked).size);
    expect([...walked].sort()).toEqual(
      stages.map((stage) => `stage-${stage.replaceAll('_', '-')}`).sort(),
    );
  });
});
