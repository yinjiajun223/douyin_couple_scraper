import type { Pool } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDefaultCampaignRuleSet } from '@douyin/contracts';

import { bootstrapFirstAdmin } from '../auth/bootstrap-admin.js';
import { createMysqlPool, runMigrations } from '../database/migrations.js';
import { seedInitialWorkspace } from '../database/seed.js';
import { issueMediaAccessUrl, MediaObjectNotFoundError } from '../media/media-service.js';
import type { ObjectStorageClient } from '../media/object-storage.js';
import { exportCandidateCsv } from './candidate-export.js';
import {
  CandidateNotFoundError,
  getCandidateDetail,
  listCandidatePage,
  listCandidates,
} from './candidate-library.js';
import {
  appendCandidateNote,
  archiveCandidate,
  CandidateWorkflowNotFoundError,
  unarchiveCandidate,
} from './candidate-workflow.js';

const databaseUrl = process.env.MYSQL_TEST_URL;
const describeWithMysql = databaseUrl ? describe : describe.skip;

describeWithMysql('达人库成员数据范围', () => {
  const workspaceId = '81000000-0000-4000-8000-000000000001';
  const campaignId = '81000000-0000-4000-8000-000000000002';
  const ruleVersionId = '81000000-0000-4000-8000-000000000003';
  const operatorA = '81000000-0000-4000-8000-000000000004';
  const operatorB = '81000000-0000-4000-8000-000000000005';
  const deviceA = '81000000-0000-4000-8000-000000000006';
  const deviceB = '81000000-0000-4000-8000-000000000007';
  const candidateShared = '81000000-0000-4000-8000-000000000020';
  const candidateA = '81000000-0000-4000-8000-000000000021';
  const candidateB = '81000000-0000-4000-8000-000000000022';
  const candidateAssigned = '81000000-0000-4000-8000-000000000023';
  const mediaA = '81000000-0000-4000-8000-000000000030';
  const mediaB = '81000000-0000-4000-8000-000000000031';
  let pool: Pool;
  let adminUserId: string;

  const accessA = (role: 'operator' | 'readonly' = 'operator') => ({
    actorRole: role,
    actorUserId: operatorA,
    workspaceId,
  });
  const accessB = () => ({ actorRole: 'operator' as const, actorUserId: operatorB, workspaceId });
  const adminAccess = (memberUserId?: string) => ({
    actorRole: 'admin' as const,
    actorUserId: adminUserId,
    ...(memberUserId ? { memberUserId } : {}),
    workspaceId,
  });

  beforeAll(async () => {
    pool = createMysqlPool(databaseUrl!);
    await runMigrations(pool);
    await seedInitialWorkspace(pool, {
      workspaceId,
      workspaceName: '达人库成员范围测试',
      workspaceSlug: 'candidate-member-scope-test',
    });
    adminUserId = (
      await bootstrapFirstAdmin(pool, {
        displayName: '范围测试管理员',
        email: 'scope-admin@example.test',
        password: 'StrongScopeAdmin2026',
        workspaceId,
      })
    ).userId;
    for (const [id, email, name] of [
      [operatorA, 'scope-a@example.test', '运营甲'],
      [operatorB, 'scope-b@example.test', '运营乙'],
    ] as const) {
      await pool.execute(
        `INSERT INTO users (id, email, password_hash, display_name)
         VALUES (?, ?, 'integration-test-only', ?)`,
        [id, email, name],
      );
      await pool.execute(
        `INSERT INTO memberships (workspace_id, user_id, role) VALUES (?, ?, 'operator')`,
        [workspaceId, id],
      );
    }
    await pool.execute(
      `INSERT INTO devices (id, workspace_id, owner_user_id, name, token_hash)
       VALUES (?, ?, ?, '运营甲设备', ?), (?, ?, ?, '运营乙设备', ?)`,
      [
        deviceA,
        workspaceId,
        operatorA,
        `${'8'.repeat(63)}a`,
        deviceB,
        workspaceId,
        operatorB,
        `${'8'.repeat(63)}b`,
      ],
    );
    const rules = JSON.stringify(createDefaultCampaignRuleSet());
    await pool.execute(
      `INSERT INTO campaigns
       (id, workspace_id, name, rule_schema_version, rules_json, created_by_user_id)
       VALUES (?, ?, '成员范围任务', 2, ?, ?)`,
      [campaignId, workspaceId, rules, adminUserId],
    );
    await pool.execute(
      `INSERT INTO campaign_rule_versions
       (id, workspace_id, campaign_id, version, rule_schema_version, rules_json, created_by_user_id)
       VALUES (?, ?, ?, 1, 2, ?, ?)`,
      [ruleVersionId, workspaceId, campaignId, rules, adminUserId],
    );

    const runs = [
      ['81000000-0000-4000-8000-000000000010', operatorA],
      ['81000000-0000-4000-8000-000000000011', operatorB],
      ['81000000-0000-4000-8000-000000000012', operatorA],
      ['81000000-0000-4000-8000-000000000013', operatorB],
      ['81000000-0000-4000-8000-000000000014', operatorB],
    ] as const;
    for (const [runId, creatorUserId] of runs) {
      await pool.execute(
        `INSERT INTO collection_runs
         (id, workspace_id, campaign_id, rule_version_id, progress_json, created_by_user_id)
         VALUES (?, ?, ?, ?, '{}', ?)`,
        [runId, workspaceId, campaignId, ruleVersionId, creatorUserId],
      );
    }

    const creators = [
      ['81000000-0000-4000-8000-000000000040', 'scope-shared'],
      ['81000000-0000-4000-8000-000000000041', 'scope-a-only'],
      ['81000000-0000-4000-8000-000000000042', 'scope-b-only'],
      ['81000000-0000-4000-8000-000000000043', 'scope-assigned'],
    ] as const;
    for (const [creatorId, platformCreatorId] of creators) {
      await pool.execute(
        `INSERT INTO creators
         (id, workspace_id, platform, platform_creator_id, first_observed_at, last_observed_at)
         VALUES (?, ?, 'douyin', ?, '2026-09-10 00:00:00.000', '2026-09-18 00:00:00.000')`,
        [creatorId, workspaceId, platformCreatorId],
      );
    }

    const observations = [
      [
        '81000000-0000-4000-8000-000000000050',
        creators[0][0],
        runs[0][0],
        deviceA,
        '共享达人·甲视图',
        '2026-09-15 16:30:00.000',
      ],
      [
        '81000000-0000-4000-8000-000000000051',
        creators[0][0],
        runs[1][0],
        deviceB,
        '共享达人·乙视图',
        '2026-09-16 08:00:00.000',
      ],
      [
        '81000000-0000-4000-8000-000000000052',
        creators[1][0],
        runs[2][0],
        deviceA,
        '甲独有达人',
        '2026-09-14 08:00:00.000',
      ],
      [
        '81000000-0000-4000-8000-000000000053',
        creators[2][0],
        runs[3][0],
        deviceB,
        '乙独有达人',
        '2026-09-13 08:00:00.000',
      ],
      [
        '81000000-0000-4000-8000-000000000054',
        creators[3][0],
        runs[4][0],
        deviceB,
        '分配给甲的达人',
        '2026-09-12 08:00:00.000',
      ],
    ] as const;
    for (const [observationId, creatorId, runId, deviceId, nickname, observedAt] of observations) {
      await pool.execute(
        `INSERT INTO creator_observations
         (id, workspace_id, creator_id, run_id, device_id, nickname, profile_url,
          follower_count, parser_confidence, collector_version, parser_version, observed_at)
         VALUES (?, ?, ?, ?, ?, ?, CONCAT('https://www.douyin.com/user/', ?),
                 1200, 0.99, '1.0.0', '1.0.0', ?)`,
        [observationId, workspaceId, creatorId, runId, deviceId, nickname, creatorId, observedAt],
      );
      await pool.execute(
        `INSERT INTO run_creator_sources
         (workspace_id, run_id, creator_id, device_id, first_observation_id,
          first_observed_at, last_observed_at, observation_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
        [workspaceId, runId, creatorId, deviceId, observationId, observedAt, observedAt],
      );
    }
    const candidates = [
      [candidateShared, creators[0][0], runs[1][0], observations[1][0]],
      [candidateA, creators[1][0], runs[2][0], observations[2][0]],
      [candidateB, creators[2][0], runs[3][0], observations[3][0]],
      [candidateAssigned, creators[3][0], runs[4][0], observations[4][0]],
    ] as const;
    for (const [candidateId, creatorId, runId, observationId] of candidates) {
      await pool.execute(
        `INSERT INTO campaign_candidates
         (id, workspace_id, campaign_id, creator_id, latest_run_id,
          latest_creator_observation_id, hard_filter_status)
         VALUES (?, ?, ?, ?, ?, ?, 'pass')`,
        [candidateId, workspaceId, campaignId, creatorId, runId, observationId],
      );
    }
    await pool.execute(
      `INSERT INTO outreach_records
       (id, workspace_id, candidate_id, owner_user_id, owner_assigned_at)
       VALUES ('81000000-0000-4000-8000-000000000060', ?, ?, ?, '2026-09-17 00:00:00.000')`,
      [workspaceId, candidateAssigned, operatorA],
    );
    await pool.execute(
      `INSERT INTO media_objects
       (id, workspace_id, creator_observation_id, object_key, purpose, mime_type,
        byte_size, checksum_sha256, status, confirmed_at)
       VALUES (?, ?, ?, 'scope/a.webp', 'profile_screenshot', 'image/webp', 100, ?, 'confirmed', CURRENT_TIMESTAMP(3)),
              (?, ?, ?, 'scope/b.webp', 'profile_screenshot', 'image/webp', 100, ?, 'confirmed', CURRENT_TIMESTAMP(3))`,
      [
        mediaA,
        workspaceId,
        observations[2][0],
        'a'.repeat(64),
        mediaB,
        workspaceId,
        observations[3][0],
        'b'.repeat(64),
      ],
    );
  });

  afterAll(async () => pool.end());

  it('按设备归属和显式分配隔离列表，并为同一达人返回各自观察证据', async () => {
    const listA = await listCandidates(pool, { ...accessA(), limit: 20 });
    const listB = await listCandidates(pool, { ...accessB(), limit: 20 });
    const readonlyA = await listCandidates(pool, { ...accessA('readonly'), limit: 20 });
    expect(listA.map((item) => item.id).sort()).toEqual(
      [candidateA, candidateAssigned, candidateShared].sort(),
    );
    expect(readonlyA.map((item) => item.id).sort()).toEqual(
      [candidateA, candidateAssigned, candidateShared].sort(),
    );
    expect(listB.map((item) => item.id).sort()).toEqual(
      [candidateAssigned, candidateB, candidateShared].sort(),
    );
    expect(listA.find((item) => item.id === candidateShared)?.nickname).toBe('共享达人·甲视图');
    expect(listB.find((item) => item.id === candidateShared)?.nickname).toBe('共享达人·乙视图');

    const detailA = await getCandidateDetail(pool, accessA(), candidateShared);
    const detailB = await getCandidateDetail(pool, accessB(), candidateShared);
    expect(detailA.observations.map((item) => item.device.id)).toEqual([deviceA]);
    expect(detailB.observations.map((item) => item.device.id)).toEqual([deviceB]);
    await expect(getCandidateDetail(pool, accessA(), candidateB)).rejects.toBeInstanceOf(
      CandidateNotFoundError,
    );
  });

  it('管理员可看全量或指定运营，并按当前查看人的首次发现时间稳定分页', async () => {
    const all = await listCandidates(pool, { ...adminAccess(), limit: 20 });
    const asA = await listCandidates(pool, { ...adminAccess(operatorA), limit: 20 });
    expect(all).toHaveLength(4);
    expect(asA.map((item) => item.id).sort()).toEqual(
      [candidateA, candidateAssigned, candidateShared].sort(),
    );

    const firstPage = await listCandidatePage(pool, { ...accessA(), limit: 1 });
    const secondPage = await listCandidatePage(pool, {
      ...accessA(),
      cursor: firstPage.nextCursor,
      limit: 1,
    });
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    expect(secondPage.candidates[0]?.id).not.toBe(firstPage.candidates[0]?.id);

    const shanghaiDay = await listCandidates(pool, {
      ...accessA(),
      discoveredFrom: '2026-09-16T00:00:00+08:00',
      discoveredTo: '2026-09-17T00:00:00+08:00',
      limit: 20,
    });
    expect(shanghaiDay.map((item) => item.id)).toEqual([candidateShared]);
    const assignedDay = await listCandidates(pool, {
      ...accessA(),
      discoveredFrom: '2026-09-17T00:00:00Z',
      discoveredTo: '2026-09-18T00:00:00Z',
      limit: 20,
    });
    expect(assignedDay.map((item) => item.id)).toEqual([candidateAssigned]);
  });

  it('详情衍生操作、导出和私有截图沿用同一成员范围', async () => {
    await expect(
      appendCandidateNote(pool, { ...accessA(), body: '越权备注', candidateId: candidateB }),
    ).rejects.toBeInstanceOf(CandidateWorkflowNotFoundError);

    const exported = await exportCandidateCsv(pool, {
      ...accessA(),
      filters: { limit: 20 },
    });
    expect(exported.csv).toContain('甲独有达人');
    expect(exported.csv).toContain('分配给甲的达人');
    expect(exported.csv).not.toContain('乙独有达人');

    const storage: ObjectStorageClient = {
      createSignedGetUrl: async ({ objectKey }) => `https://oss.example/${objectKey}`,
      createSignedPutUrl: async () => '',
      deleteObject: async () => undefined,
      headObject: async () => ({
        byteSize: 100,
        checksumSha256: 'a'.repeat(64),
        contentType: 'image/webp',
        etag: 'etag',
      }),
    };
    await expect(issueMediaAccessUrl(pool, storage, accessA(), mediaA)).resolves.toMatchObject({
      id: mediaA,
    });
    await expect(issueMediaAccessUrl(pool, storage, accessA(), mediaB)).rejects.toBeInstanceOf(
      MediaObjectNotFoundError,
    );
  });

  it('归档候选后素材签名访问沿用同一成员范围', async () => {
    const storage: ObjectStorageClient = {
      createSignedGetUrl: async ({ objectKey }) => `https://oss.example/${objectKey}`,
      createSignedPutUrl: async () => '',
      deleteObject: async () => undefined,
      headObject: async () => ({
        byteSize: 100,
        checksumSha256: 'a'.repeat(64),
        contentType: 'image/webp',
        etag: 'etag',
      }),
    };
    const versions: Record<string, number> = {};
    for (const candidateId of [candidateA, candidateB]) {
      const detail = await getCandidateDetail(pool, adminAccess(), candidateId);
      versions[candidateId] = detail.candidate.version;
      await archiveCandidate(pool, {
        actorRole: 'admin',
        actorUserId: adminUserId,
        candidateId,
        expectedVersion: versions[candidateId],
        note: '重复达人',
        workspaceId,
      });
    }

    // 归档只影响列表分区，不改变记录级可见范围：看得见的人仍能取到签名地址，
    // 看不见的人仍然拿到与「不存在」一致的结果。
    await expect(issueMediaAccessUrl(pool, storage, accessA(), mediaA)).resolves.toMatchObject({
      id: mediaA,
    });
    await expect(issueMediaAccessUrl(pool, storage, accessA(), mediaB)).rejects.toBeInstanceOf(
      MediaObjectNotFoundError,
    );
    await expect(issueMediaAccessUrl(pool, storage, accessB(), mediaA)).rejects.toBeInstanceOf(
      MediaObjectNotFoundError,
    );
    await expect(issueMediaAccessUrl(pool, storage, accessB(), mediaB)).resolves.toMatchObject({
      id: mediaB,
    });

    for (const candidateId of [candidateA, candidateB]) {
      await unarchiveCandidate(pool, {
        actorRole: 'admin',
        actorUserId: adminUserId,
        candidateId,
        expectedVersion: versions[candidateId]! + 1,
        workspaceId,
      });
    }
    expect(
      (await getCandidateDetail(pool, adminAccess(), candidateA)).candidate.archivedAt,
    ).toBeNull();
  });
});
