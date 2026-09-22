import { randomUUID } from 'node:crypto';

import type { Pool, RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { COLLECTOR_PROTOCOL_VERSION, createDefaultCampaignRuleSet } from '@douyin/contracts';

import { bootstrapFirstAdmin } from '../auth/bootstrap-admin.js';
import type { DevicePrincipal } from '../auth/devices.js';
import { createCampaign } from '../campaigns/campaign-service.js';
import { archiveCandidate } from '../candidates/candidate-workflow.js';
import {
  claimCollectionRun,
  createCollectionRun,
  startClaimedCollectionRun,
} from '../campaigns/run-service.js';
import { createMysqlPool, runMigrations } from '../database/migrations.js';
import { seedInitialWorkspace } from '../database/seed.js';
import { ingestCollectorBatch } from '../ingestion/collector-ingestion.js';
import { cleanupMediaObjects } from './media-cleanup.js';
import type { ObjectStorageClient } from './object-storage.js';

const databaseUrl = process.env.MYSQL_TEST_URL;
const describeWithMysql = databaseUrl ? describe : describe.skip;

// 用例按声明顺序执行，且每条用例只创建自己需要的素材行：
// 回收是工作区级的，前一条用例留下的行会被后一条的查询扫到，
// 因此「被保留」的行一律用小于宽限期的确认时间，「已删除」的行状态不再是 confirmed，
// 两者都不会被后续用例二次消费。两个例外：归档留存用例把宽限期调到 365 天，
// 使自己成为该次调用里唯一符合孤儿判据的行；批大小用例声明在最后，
// 它留下的超宽限期 confirmed 行没有后续调用会扫到，且自己的三行比其他遗留行都老，
// 保证 ORDER BY confirmed_at 先取到它们。
describeWithMysql('孤儿证据回收', () => {
  const workspaceId = '34000000-0000-4000-8000-000000000001';
  const deviceId = '35000000-0000-4000-8000-000000000001';
  const observationIds = {
    orphanOverdue: '33000000-0000-4000-8000-000000000001',
    orphanWithinGrace: '33000000-0000-4000-8000-000000000002',
    admitted: '33000000-0000-4000-8000-000000000003',
    orphanInterrupted: '33000000-0000-4000-8000-000000000004',
    retentionArchived: '33000000-0000-4000-8000-000000000005',
    orphanArchived: '33000000-0000-4000-8000-000000000006',
    orphanSwitchOff: '33000000-0000-4000-8000-000000000007',
    batchOldest: '33000000-0000-4000-8000-000000000008',
    batchMiddle: '33000000-0000-4000-8000-000000000009',
    batchYoungest: '33000000-0000-4000-8000-000000000010',
    archivedCandidate: '33000000-0000-4000-8000-000000000011',
  } as const;
  const observedAt = new Date().toISOString();
  const publishedAt = new Date(Date.now() - 86_400_000).toISOString();
  let pool: Pool;
  let actorUserId: string;
  let activeRunId: string;
  let principal: DevicePrincipal;

  const deletedKeys: string[] = [];
  let deleteFailures = 0;
  let failDeleteObject = false;
  const storage: ObjectStorageClient = {
    createSignedGetUrl: async () => {
      throw new Error('回收用例不申请签名读取地址');
    },
    createSignedPutUrl: async () => {
      throw new Error('回收用例不申请签名写入地址');
    },
    deleteObject: async (objectKey) => {
      if (failDeleteObject) {
        deleteFailures += 1;
        throw new Error('对象存储暂时不可用');
      }
      deletedKeys.push(objectKey);
    },
    headObject: async () => {
      throw new Error('回收用例不读取对象元数据');
    },
  };

  const deleteCount = (objectKey: string) => deletedKeys.filter((key) => key === objectKey).length;

  async function seedCreator(input: {
    creatorId: string;
    followerCount: number;
    observationId: string;
    runId: string;
  }): Promise<void> {
    await ingestCollectorBatch(pool, principal, {
      protocolVersion: COLLECTOR_PROTOCOL_VERSION,
      collectorVersion: '1.0.0',
      parserVersion: '1.0.0',
      deviceId,
      runId: input.runId,
      idempotencyKey: `media-cleanup-${input.observationId}`,
      observations: [
        {
          observationId: input.observationId,
          platform: 'douyin',
          platformCreatorId: input.creatorId,
          profileUrl: `https://www.douyin.com/user/${input.creatorId}`,
          nickname: input.creatorId,
          biography: '校园日常',
          followerCount: input.followerCount,
          followerCountRaw: String(input.followerCount),
          observedAt,
          parserConfidence: 0.98,
          posts: [
            {
              platformPostId: `${input.creatorId}-post`,
              postUrl: `https://www.douyin.com/video/${input.creatorId}-post`,
              caption: '校园爆款',
              likeCount: 12_000,
              likeCountRaw: '1.2万',
              publishedAt,
              observedAt,
              screenshotLocalId: null,
            },
          ],
        },
      ],
    });
  }

  async function insertConfirmedMedia(
    observationId: string,
    objectKey: string,
    confirmedDaysAgo: number,
  ): Promise<void> {
    await pool.execute(
      `INSERT INTO media_objects
       (id, workspace_id, creator_observation_id, object_key, purpose, mime_type,
        byte_size, checksum_sha256, status, confirmed_at)
       VALUES (?, ?, ?, ?, 'profile_screenshot', 'image/webp', 2048, ?, 'confirmed',
               TIMESTAMPADD(DAY, ?, CURRENT_TIMESTAMP(3)))`,
      [randomUUID(), workspaceId, observationId, objectKey, 'd'.repeat(64), -confirmedDaysAgo],
    );
  }

  async function insertExpiredPendingMedia(
    observationId: string,
    objectKey: string,
  ): Promise<void> {
    await pool.execute(
      `INSERT INTO media_objects
       (id, workspace_id, creator_observation_id, object_key, purpose, mime_type,
        byte_size, checksum_sha256, status, expires_at, created_at)
       VALUES (?, ?, ?, ?, 'profile_screenshot', 'image/webp', 2048, ?, 'pending',
               DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 1 HOUR),
               DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 1 HOUR))`,
      [randomUUID(), workspaceId, observationId, objectKey, 'e'.repeat(64)],
    );
  }

  async function readMedia(objectKey: string): Promise<RowDataPacket | undefined> {
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT id, status FROM media_objects WHERE object_key = ?',
      [objectKey],
    );
    return rows[0];
  }

  beforeAll(async () => {
    pool = createMysqlPool(databaseUrl!);
    await runMigrations(pool);
    await seedInitialWorkspace(pool, {
      workspaceId,
      workspaceSlug: 'media-cleanup-test',
      workspaceName: '素材回收测试',
    });
    const admin = await bootstrapFirstAdmin(pool, {
      workspaceId,
      email: 'media-cleanup@example.test',
      displayName: '素材回收管理员',
      password: 'StrongMediaCleanup2026',
    });
    actorUserId = admin.userId;
    await pool.execute(
      `INSERT INTO devices
       (id, workspace_id, owner_user_id, name, token_hash, collector_version, parser_version)
       VALUES (?, ?, ?, '素材回收设备', ?, '1.0.0', '1.0.0')`,
      [deviceId, workspaceId, actorUserId, deviceId.replaceAll('-', '').padEnd(64, '0')],
    );
    principal = {
      deviceId,
      workspaceId,
      ownerUserId: actorUserId,
      name: '素材回收设备',
      collectorVersion: '1.0.0',
      parserVersion: '1.0.0',
    };

    const activeCampaign = await createCampaign(pool, {
      workspaceId,
      actorUserId,
      name: '素材回收任务',
      recommendationProfileDescription: '校园情侣推荐流',
      rules: createDefaultCampaignRuleSet(),
    });
    const activeRun = await createCollectionRun(pool, {
      workspaceId,
      actorUserId,
      campaignId: activeCampaign.id,
    });
    activeRunId = activeRun.id;
    await claimCollectionRun(pool, { workspaceId, runId: activeRunId, deviceId });
    await startClaimedCollectionRun(pool, { workspaceId, runId: activeRunId, deviceId });

    // 归档任务的两位达人用于「已归档 + 超保留期」这条既有回收路径；
    // 两者粉丝都越界，闸门后都没有候选行，因此同时也是孤儿判据的候选对象。
    const archivedCampaign = await createCampaign(pool, {
      workspaceId,
      actorUserId,
      name: '素材回收归档任务',
      recommendationProfileDescription: '校园情侣推荐流',
      rules: createDefaultCampaignRuleSet(),
    });
    const archivedRun = await createCollectionRun(pool, {
      workspaceId,
      actorUserId,
      campaignId: archivedCampaign.id,
    });
    await claimCollectionRun(pool, { workspaceId, runId: archivedRun.id, deviceId });
    await startClaimedCollectionRun(pool, { workspaceId, runId: archivedRun.id, deviceId });
    await seedCreator({
      creatorId: 'cleanup-retention-archived',
      followerCount: 7_600,
      observationId: observationIds.retentionArchived,
      runId: archivedRun.id,
    });
    await seedCreator({
      creatorId: 'cleanup-orphan-archived',
      followerCount: 7_700,
      observationId: observationIds.orphanArchived,
      runId: archivedRun.id,
    });
    await pool.execute(
      `UPDATE campaigns SET status = 'archived', archived_at = CURRENT_TIMESTAMP(3) WHERE id = ?`,
      [archivedCampaign.id],
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  it('超过宽限期的孤儿截图被删除，素材行保留为 deleted 而不被物理删除', async () => {
    await seedCreator({
      creatorId: 'cleanup-orphan-overdue',
      followerCount: 7_000,
      observationId: observationIds.orphanOverdue,
      runId: activeRunId,
    });
    const objectKey = 'evidence/cleanup/orphan-overdue.webp';
    await insertConfirmedMedia(observationIds.orphanOverdue, objectKey, 8);

    const summary = await cleanupMediaObjects(pool, storage, {
      batchSize: 20,
      orphanCleanupEnabled: true,
      orphanGraceDays: 7,
      retentionDays: 3_650,
      workspaceId,
    });

    expect(summary.deletedOrphans).toBe(1);
    expect(deleteCount(objectKey)).toBe(1);
    // 行必须留下：object_key 与删除状态是「曾存在何种证据」的唯一审计线索。
    expect(await readMedia(objectKey)).toMatchObject({ status: 'deleted' });
    const [remaining] = await pool.query<RowDataPacket[]>(
      'SELECT COUNT(*) AS total FROM media_objects WHERE workspace_id = ? AND object_key = ?',
      [workspaceId, objectKey],
    );
    expect(remaining[0]).toMatchObject({ total: 1 });
  });

  it('宽限期内的孤儿截图保留，等待入库流程完成', async () => {
    await seedCreator({
      creatorId: 'cleanup-orphan-fresh',
      followerCount: 8_000,
      observationId: observationIds.orphanWithinGrace,
      runId: activeRunId,
    });
    const objectKey = 'evidence/cleanup/orphan-fresh.webp';
    await insertConfirmedMedia(observationIds.orphanWithinGrace, objectKey, 1);

    const summary = await cleanupMediaObjects(pool, storage, {
      batchSize: 20,
      orphanCleanupEnabled: true,
      orphanGraceDays: 7,
      retentionDays: 3_650,
      workspaceId,
    });

    expect(summary.deletedOrphans).toBe(0);
    expect(deleteCount(objectKey)).toBe(0);
    expect(await readMedia(objectKey)).toMatchObject({ status: 'confirmed' });
  });

  it('已有入库候选行的素材即使远超过宽限期也不回收', async () => {
    await seedCreator({
      creatorId: 'cleanup-admitted',
      followerCount: 1_200,
      observationId: observationIds.admitted,
      runId: activeRunId,
    });
    const [candidates] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS total FROM campaign_candidates
       WHERE workspace_id = ? AND creator_id IN (
         SELECT id FROM creators WHERE workspace_id = ? AND platform_creator_id = ?
       )`,
      [workspaceId, workspaceId, 'cleanup-admitted'],
    );
    expect(candidates[0]).toMatchObject({ total: 1 });
    const objectKey = 'evidence/cleanup/admitted.webp';
    await insertConfirmedMedia(observationIds.admitted, objectKey, 400);

    const summary = await cleanupMediaObjects(pool, storage, {
      batchSize: 20,
      orphanCleanupEnabled: true,
      orphanGraceDays: 7,
      retentionDays: 3_650,
      workspaceId,
    });

    expect(summary.deletedOrphans).toBe(0);
    expect(deleteCount(objectKey)).toBe(0);
    expect(await readMedia(objectKey)).toMatchObject({ status: 'confirmed' });
  });

  it('已归档候选的确认素材不被孤儿回收误删', async () => {
    await seedCreator({
      creatorId: 'cleanup-archived-candidate',
      followerCount: 1_300,
      observationId: observationIds.archivedCandidate,
      runId: activeRunId,
    });
    const [candidates] = await pool.query<RowDataPacket[]>(
      `SELECT candidates.id, candidates.version FROM campaign_candidates candidates
       WHERE candidates.workspace_id = ? AND candidates.creator_id IN (
         SELECT id FROM creators WHERE workspace_id = ? AND platform_creator_id = ?
       )`,
      [workspaceId, workspaceId, 'cleanup-archived-candidate'],
    );
    expect(candidates).toHaveLength(1);
    await archiveCandidate(pool, {
      actorRole: 'admin',
      actorUserId,
      candidateId: candidates[0]!.id as string,
      expectedVersion: Number(candidates[0]!.version),
      note: '与已合作达人重复',
      workspaceId,
    });
    const objectKey = 'evidence/cleanup/archived-candidate.webp';
    await insertConfirmedMedia(observationIds.archivedCandidate, objectKey, 400);

    const summary = await cleanupMediaObjects(pool, storage, {
      batchSize: 20,
      orphanCleanupEnabled: true,
      orphanGraceDays: 7,
      retentionDays: 3_650,
      workspaceId,
    });

    // 归档只写 archived_at，候选行仍然存在；孤儿判据是「没有候选行」，
    // 所以已归档候选的证据必须原样留下，等人工恢复后继续可用。
    expect(summary.deletedOrphans).toBe(0);
    expect(deleteCount(objectKey)).toBe(0);
    expect(await readMedia(objectKey)).toMatchObject({ status: 'confirmed' });
  });

  it('回收中断后重跑不重复删除也不漏删', async () => {
    await seedCreator({
      creatorId: 'cleanup-orphan-interrupted',
      followerCount: 9_000,
      observationId: observationIds.orphanInterrupted,
      runId: activeRunId,
    });
    const objectKey = 'evidence/cleanup/orphan-interrupted.webp';
    await insertConfirmedMedia(observationIds.orphanInterrupted, objectKey, 10);

    // 第一轮在删除 OSS 对象时失败：行已被 claim 成 expired，对象仍在。
    failDeleteObject = true;
    const interrupted = await cleanupMediaObjects(pool, storage, {
      batchSize: 20,
      orphanCleanupEnabled: true,
      orphanGraceDays: 7,
      retentionDays: 3_650,
      workspaceId,
    });
    failDeleteObject = false;
    expect(interrupted.deletedOrphans).toBe(0);
    expect(interrupted.failed).toBe(1);
    expect(deleteFailures).toBe(1);
    expect(await readMedia(objectKey)).toMatchObject({ status: 'expired' });

    // 重跑由既有的未确认路径接手 expired 行，孤儿路径不会二次 claim。
    const resumed = await cleanupMediaObjects(pool, storage, {
      batchSize: 20,
      orphanCleanupEnabled: true,
      orphanGraceDays: 7,
      retentionDays: 3_650,
      workspaceId,
    });

    expect(resumed.deletedOrphans).toBe(0);
    expect(resumed.deletedUnconfirmed).toBe(1);
    expect(resumed.failed).toBe(0);
    expect(deleteCount(objectKey)).toBe(1);
    expect(await readMedia(objectKey)).toMatchObject({ status: 'deleted' });
  });

  it('开关关闭时孤儿不回收，既有两条回收路径行为不变', async () => {
    await seedCreator({
      creatorId: 'cleanup-orphan-switch-off',
      followerCount: 9_500,
      observationId: observationIds.orphanSwitchOff,
      runId: activeRunId,
    });
    const orphanKey = 'evidence/cleanup/orphan-switch-off.webp';
    const pendingKey = 'evidence/cleanup/pending-expired.webp';
    const retentionKey = 'evidence/cleanup/retention-archived.webp';
    await insertConfirmedMedia(observationIds.orphanSwitchOff, orphanKey, 8);
    await insertExpiredPendingMedia(observationIds.orphanSwitchOff, pendingKey);
    await insertConfirmedMedia(observationIds.retentionArchived, retentionKey, 300);

    const summary = await cleanupMediaObjects(pool, storage, {
      batchSize: 20,
      retentionDays: 1,
      workspaceId,
    });

    expect(summary.deletedOrphans).toBe(0);
    expect(deleteCount(orphanKey)).toBe(0);
    expect(await readMedia(orphanKey)).toMatchObject({ status: 'confirmed' });
    // 未确认路径与「已归档 + 超保留期」路径照常工作。
    expect(summary.deletedUnconfirmed).toBe(1);
    expect(deleteCount(pendingKey)).toBe(1);
    expect(summary.deletedConfirmed).toBe(1);
    expect(deleteCount(retentionKey)).toBe(1);
    expect(await readMedia(retentionKey)).toMatchObject({ status: 'deleted' });
  });

  it('同一对象同时符合孤儿与归档留存判据时只被 claim 一次', async () => {
    const objectKey = 'evidence/cleanup/orphan-archived.webp';
    await insertConfirmedMedia(observationIds.orphanArchived, objectKey, 400);

    // 宽限期调到 365 天，使本次调用里只有这一行符合孤儿判据；
    // 它同时落在已归档任务且远超 1 天保留期，两条路径都会选中它。
    const summary = await cleanupMediaObjects(pool, storage, {
      batchSize: 20,
      orphanCleanupEnabled: true,
      orphanGraceDays: 365,
      retentionDays: 1,
      workspaceId,
    });

    expect(summary.deletedConfirmed).toBe(1);
    expect(summary.deletedOrphans).toBe(0);
    expect(deleteCount(objectKey)).toBe(1);
    expect(await readMedia(objectKey)).toMatchObject({ status: 'deleted' });
  });

  it('单轮回收受批大小上限约束，最老的孤儿优先出队', async () => {
    const oldest = {
      ageDays: 102,
      key: 'evidence/cleanup/orphan-batch-oldest.webp',
      observationId: observationIds.batchOldest,
    };
    const middle = {
      ageDays: 101,
      key: 'evidence/cleanup/orphan-batch-middle.webp',
      observationId: observationIds.batchMiddle,
    };
    const youngest = {
      ageDays: 100,
      key: 'evidence/cleanup/orphan-batch-youngest.webp',
      observationId: observationIds.batchYoungest,
    };
    // 三行都比其他用例遗留的 confirmed 孤儿行更老（那些只有 1 天和 8 天），
    // 因此 ORDER BY confirmed_at ASC 一定先取到本用例自己的行，与用例执行顺序无关。
    for (const [index, item] of [oldest, middle, youngest].entries()) {
      await seedCreator({
        creatorId: `cleanup-orphan-batch-${index}`,
        followerCount: 7_100 + index * 100,
        observationId: item.observationId,
        runId: activeRunId,
      });
      await insertConfirmedMedia(item.observationId, item.key, item.ageDays);
    }

    const summary = await cleanupMediaObjects(pool, storage, {
      batchSize: 2,
      orphanCleanupEnabled: true,
      orphanGraceDays: 7,
      retentionDays: 3_650,
      workspaceId,
    });

    expect(summary.deletedConfirmed).toBe(0);
    expect(summary.deletedOrphans).toBe(2);
    expect(deleteCount(oldest.key)).toBe(1);
    expect(deleteCount(middle.key)).toBe(1);
    // 超出批大小的那一行原样留在 confirmed，等下一轮定时清理，不会一次删穿整张表。
    expect(deleteCount(youngest.key)).toBe(0);
    expect(await readMedia(youngest.key)).toMatchObject({ status: 'confirmed' });
  });
});
