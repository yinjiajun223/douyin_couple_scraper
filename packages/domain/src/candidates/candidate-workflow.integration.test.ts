import { randomUUID } from 'node:crypto';

import type { Pool, RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDefaultCampaignRuleSet } from '@douyin/contracts';

import { bootstrapFirstAdmin } from '../auth/bootstrap-admin.js';
import { PermissionDeniedError } from '../auth/permissions.js';
import { createMysqlPool, runMigrations } from '../database/migrations.js';
import { seedInitialWorkspace } from '../database/seed.js';
import { getOperationsDashboard } from '../dashboard/operations-dashboard.js';
import { batchArchiveCandidates, batchSubmitManualReview } from './candidate-batch.js';
import { exportCandidateCsv } from './candidate-export.js';
import { listCandidates } from './candidate-library.js';
import {
  appendCandidateNote,
  archiveCandidate,
  CandidateVersionConflictError,
  CandidateWorkflowNotFoundError,
  getCandidateWorkflow,
  InvalidPipelineTransitionError,
  OutreachVersionConflictError,
  setCandidateTags,
  submitManualReview,
  transitionCandidatePipeline,
  unarchiveCandidate,
  updateCandidateOutreach,
} from './candidate-workflow.js';

const databaseUrl = process.env.MYSQL_TEST_URL;
const describeWithMysql = databaseUrl ? describe : describe.skip;

describeWithMysql('manual review and outreach workflow', () => {
  const workspaceId = '7a000000-0000-4000-8000-000000000001';
  const campaignId = '7a000000-0000-4000-8000-000000000002';
  const ruleVersionId = '7a000000-0000-4000-8000-000000000003';
  const runId = '7a000000-0000-4000-8000-000000000004';
  const deviceId = '7a000000-0000-4000-8000-000000000005';
  const creatorId = '7a000000-0000-4000-8000-000000000006';
  const observationId = '7a000000-0000-4000-8000-000000000007';
  const candidateId = '7a000000-0000-4000-8000-000000000008';
  let pool: Pool;
  let actorUserId: string;
  const adminAccess = () => ({ actorRole: 'admin' as const, actorUserId, workspaceId });

  beforeAll(async () => {
    pool = createMysqlPool(databaseUrl!);
    await runMigrations(pool);
    await seedInitialWorkspace(pool, {
      workspaceId,
      workspaceName: '人工工作流测试',
      workspaceSlug: 'candidate-workflow-test',
    });
    actorUserId = (
      await bootstrapFirstAdmin(pool, {
        displayName: '复核管理员',
        email: 'workflow-admin@example.test',
        password: 'StrongWorkflowAdmin2026',
        workspaceId,
      })
    ).userId;
    const rules = JSON.stringify(createDefaultCampaignRuleSet());
    await pool.execute(
      'INSERT INTO devices (id, workspace_id, owner_user_id, name, token_hash) VALUES (?, ?, ?, ?, ?)',
      [deviceId, workspaceId, actorUserId, '工作流设备', 'a'.repeat(64)],
    );
    await pool.execute(
      `INSERT INTO campaigns
       (id, workspace_id, name, rule_schema_version, rules_json, created_by_user_id)
       VALUES (?, ?, '人工工作流任务', 1, ?, ?)`,
      [campaignId, workspaceId, rules, actorUserId],
    );
    await pool.execute(
      `INSERT INTO campaign_rule_versions
       (id, workspace_id, campaign_id, version, rule_schema_version, rules_json, created_by_user_id)
       VALUES (?, ?, ?, 1, 1, ?, ?)`,
      [ruleVersionId, workspaceId, campaignId, rules, actorUserId],
    );
    await pool.execute(
      `INSERT INTO collection_runs
       (id, workspace_id, campaign_id, rule_version_id, progress_json, created_by_user_id)
       VALUES (?, ?, ?, ?, '{}', ?)`,
      [runId, workspaceId, campaignId, ruleVersionId, actorUserId],
    );
    await pool.execute(
      `INSERT INTO creators
       (id, workspace_id, platform, platform_creator_id, first_observed_at, last_observed_at)
       VALUES (?, ?, 'douyin', 'workflow-creator', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
      [creatorId, workspaceId],
    );
    await pool.execute(
      `INSERT INTO creator_observations
       (id, workspace_id, creator_id, run_id, device_id, nickname, biography,
        profile_url, parser_confidence, collector_version, parser_version, observed_at)
       VALUES (?, ?, ?, ?, ?, '工作流达人', '公开简介', 'https://www.douyin.com/user/workflow-creator',
        0.99, '1.0.0', '1.0.0', CURRENT_TIMESTAMP(3))`,
      [observationId, workspaceId, creatorId, runId, deviceId],
    );
    await pool.execute(
      `INSERT INTO campaign_candidates
       (id, workspace_id, campaign_id, creator_id, latest_run_id,
        latest_creator_observation_id, hard_filter_status)
       VALUES (?, ?, ?, ?, ?, ?, 'pass')`,
      [candidateId, workspaceId, campaignId, creatorId, runId, observationId],
    );
  });

  afterAll(async () => pool.end());

  it('records the manual decision as the final business conclusion', async () => {
    const reviewed = await submitManualReview(pool, {
      actorRole: 'admin',
      actorUserId,
      candidateId,
      decision: 'rejected',
      expectedVersion: 1,
      reason: '内容调性不适合本次应用推广',
      workspaceId,
    });
    expect(reviewed).toEqual({
      id: expect.any(String),
      pipelineStatus: 'unsuitable',
      version: 2,
    });
    const workflow = await getCandidateWorkflow(pool, adminAccess(), candidateId);
    expect(workflow.reviews[0]).toMatchObject({
      decision: 'rejected',
      reason: '内容调性不适合本次应用推广',
    });
    expect(workflow.pipelineStatus).toBe('unsuitable');
    expect(workflow.candidateVersion).toBe(2);
  });

  it('records allowed status transitions and rejects skipped stages', async () => {
    const before = await getCandidateWorkflow(pool, adminAccess(), candidateId);
    expect(before.pipelineStatus).toBe('unsuitable');
    await expect(
      transitionCandidatePipeline(pool, {
        actorRole: 'admin',
        actorUserId,
        candidateId,
        expectedVersion: before.candidateVersion,
        nextStatus: 'partnered',
        workspaceId,
      }),
    ).rejects.toBeInstanceOf(InvalidPipelineTransitionError);
    await transitionCandidatePipeline(pool, {
      actorRole: 'admin',
      actorUserId,
      candidateId,
      expectedVersion: before.candidateVersion,
      nextStatus: 'pending_review',
      workspaceId,
    });
    const reopened = await getCandidateWorkflow(pool, adminAccess(), candidateId);
    const moved = await transitionCandidatePipeline(pool, {
      actorRole: 'admin',
      actorUserId,
      candidateId,
      expectedVersion: reopened.candidateVersion,
      nextStatus: 'to_contact',
      workspaceId,
    });
    expect(moved.status).toBe('to_contact');
    expect((await getCandidateWorkflow(pool, adminAccess(), candidateId)).events[0]).toMatchObject({
      eventType: 'pipeline_status_changed',
      previousStatus: 'pending_review',
      nextStatus: 'to_contact',
    });
  });

  it('uses optimistic versions for concurrent review/outreach and keeps notes append-only', async () => {
    const workflow = await getCandidateWorkflow(pool, adminAccess(), candidateId);
    const reviews = await Promise.allSettled([
      submitManualReview(pool, {
        actorRole: 'admin',
        actorUserId,
        candidateId,
        decision: 'approved',
        expectedVersion: workflow.candidateVersion,
        reason: '人工复核通过',
        workspaceId,
      }),
      submitManualReview(pool, {
        actorRole: 'admin',
        actorUserId,
        candidateId,
        decision: 'pending',
        expectedVersion: workflow.candidateVersion,
        reason: '需要再看一条作品',
        workspaceId,
      }),
    ]);
    expect(reviews.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejectedReview = reviews.find((result) => result.status === 'rejected');
    expect(rejectedReview).toMatchObject({ reason: expect.any(CandidateVersionConflictError) });

    const outreachUpdates = await Promise.allSettled([
      updateCandidateOutreach(pool, {
        actorRole: 'admin',
        actorUserId,
        candidateId,
        contactChannel: 'douyin',
        contactValue: '公开私信',
        currency: 'CNY',
        expectedVersion: 0,
        nextAction: '发送合作简介',
        quotedAmount: 500,
        workspaceId,
      }),
      updateCandidateOutreach(pool, {
        actorRole: 'admin',
        actorUserId,
        candidateId,
        expectedVersion: 0,
        nextAction: '覆盖另一位同事的修改',
        workspaceId,
      }),
    ]);
    expect(outreachUpdates.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejectedOutreach = outreachUpdates.find((result) => result.status === 'rejected');
    expect(rejectedOutreach).toMatchObject({ reason: expect.any(OutreachVersionConflictError) });

    await appendCandidateNote(pool, {
      actorRole: 'admin',
      actorUserId,
      body: '第一次沟通记录',
      candidateId,
      workspaceId,
    });
    await appendCandidateNote(pool, {
      actorRole: 'admin',
      actorUserId,
      body: '第二次补充记录',
      candidateId,
      workspaceId,
    });
    const current = await getCandidateWorkflow(pool, adminAccess(), candidateId);
    expect(current.notes.map((note) => note.body)).toEqual(['第二次补充记录', '第一次沟通记录']);
    expect(current.outreach).toMatchObject({ version: 1 });
    await updateCandidateOutreach(pool, {
      actorRole: 'admin',
      actorUserId,
      candidateId,
      expectedVersion: 1,
      ownerUserId: actorUserId,
      workspaceId,
    });

    await pool.execute("UPDATE collection_runs SET status = 'running' WHERE id = ?", [runId]);
    await pool.execute(
      `INSERT INTO collection_runs
       (id, workspace_id, campaign_id, rule_version_id, status, progress_json, created_by_user_id)
       VALUES (?, ?, ?, ?, 'failed', '{}', ?)`,
      ['7a000000-0000-4000-8000-000000000010', workspaceId, campaignId, ruleVersionId, actorUserId],
    );
    for (const [index, hardFilterStatus] of ['fail', 'unknown'].entries()) {
      const creatorNumber = 20 + index * 3;
      const hiddenCreatorId = `7a000000-0000-4000-8000-${String(creatorNumber).padStart(12, '0')}`;
      const hiddenObservationId = `7a000000-0000-4000-8000-${String(creatorNumber + 1).padStart(12, '0')}`;
      const hiddenCandidateId = `7a000000-0000-4000-8000-${String(creatorNumber + 2).padStart(12, '0')}`;
      await pool.execute(
        `INSERT INTO creators
         (id, workspace_id, platform, platform_creator_id, first_observed_at, last_observed_at)
         VALUES (?, ?, 'douyin', ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
        [hiddenCreatorId, workspaceId, `workflow-${hardFilterStatus}`],
      );
      await pool.execute(
        `INSERT INTO creator_observations
         (id, workspace_id, creator_id, run_id, device_id, nickname, profile_url,
          parser_confidence, collector_version, parser_version, observed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0.99, '1.0.0', '1.0.0', CURRENT_TIMESTAMP(3))`,
        [
          hiddenObservationId,
          workspaceId,
          hiddenCreatorId,
          runId,
          deviceId,
          `隐藏${hardFilterStatus}`,
          `https://www.douyin.com/user/workflow-${hardFilterStatus}`,
        ],
      );
      await pool.execute(
        `INSERT INTO campaign_candidates
         (id, workspace_id, campaign_id, creator_id, latest_run_id,
          latest_creator_observation_id, assignee_user_id, hard_filter_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          hiddenCandidateId,
          workspaceId,
          campaignId,
          hiddenCreatorId,
          runId,
          hiddenObservationId,
          actorUserId,
          hardFilterStatus,
        ],
      );
    }
    await expect(getOperationsDashboard(pool, adminAccess())).resolves.toEqual({
      failedRuns: 1,
      myAssignments: 1,
      pendingReview: 0,
      runningRuns: 1,
      toContact: 1,
    });

    const exported = await exportCandidateCsv(pool, {
      actorRole: 'admin',
      actorUserId,
      filters: { pipelineStatus: 'to_contact' },
      workspaceId,
    });
    expect(exported.count).toBe(1);
    expect(exported.csv).toContain('工作流达人');
    expect(exported.csv).not.toMatch(/credential|cookie|device.?token|api.?key|oss.?key/iu);
    const [exportAudits] = await pool.query<RowDataPacket[]>(
      "SELECT summary_json FROM audit_events WHERE workspace_id = ? AND action = 'export.created'",
      [workspaceId],
    );
    expect(exportAudits[0]?.summary_json).toMatchObject({ count: 1 });
  });

  async function createPendingCandidate(platformCreatorId: string) {
    const newCreatorId = randomUUID();
    const newObservationId = randomUUID();
    const newCandidateId = randomUUID();
    await pool.execute(
      `INSERT INTO creators
       (id, workspace_id, platform, platform_creator_id, first_observed_at, last_observed_at)
       VALUES (?, ?, 'douyin', ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
      [newCreatorId, workspaceId, platformCreatorId],
    );
    await pool.execute(
      `INSERT INTO creator_observations
       (id, workspace_id, creator_id, run_id, device_id, nickname, profile_url,
        parser_confidence, collector_version, parser_version, observed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0.99, '1.0.0', '1.0.0', CURRENT_TIMESTAMP(3))`,
      [
        newObservationId,
        workspaceId,
        newCreatorId,
        runId,
        deviceId,
        platformCreatorId,
        `https://www.douyin.com/user/${platformCreatorId}`,
      ],
    );
    await pool.execute(
      `INSERT INTO campaign_candidates
       (id, workspace_id, campaign_id, creator_id, latest_run_id,
        latest_creator_observation_id, hard_filter_status)
       VALUES (?, ?, ?, ?, ?, ?, 'pass')`,
      [newCandidateId, workspaceId, campaignId, newCreatorId, runId, newObservationId],
    );
    return newCandidateId;
  }

  it('复核通过在同一操作内推进到待联系，只递增一次版本并留下两条事件', async () => {
    const target = await createPendingCandidate('workflow-auto-approve');
    const reviewed = await submitManualReview(pool, {
      actorRole: 'admin',
      actorUserId,
      candidateId: target,
      decision: 'approved',
      expectedVersion: 1,
      workspaceId,
    });
    expect(reviewed).toEqual({
      id: expect.any(String),
      pipelineStatus: 'to_contact',
      version: 2,
    });
    const workflow = await getCandidateWorkflow(pool, adminAccess(), target);
    expect(workflow.pipelineStatus).toBe('to_contact');
    expect(workflow.candidateVersion).toBe(2);
    // candidate_events 只有毫秒级 created_at 与随机 UUID 主键，同一事务内的两条事件
    // 没有可依赖的先后次序，因此只断言两条都在且内容正确。
    expect(new Set(workflow.events.map((event) => event.eventType))).toEqual(
      new Set(['manual_reviewed', 'pipeline_status_changed']),
    );
    expect(workflow.events).toHaveLength(2);
    expect(workflow.events).toContainEqual(
      expect.objectContaining({
        eventType: 'pipeline_status_changed',
        previousStatus: 'pending_review',
        nextStatus: 'to_contact',
      }),
    );
    const [audits] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS total FROM audit_events
       WHERE workspace_id = ? AND subject_id = ? AND action = 'candidate.reviewed'`,
      [workspaceId, target],
    );
    expect(Number(audits[0]?.total)).toBe(1);
  });

  it('待定结论只记录历史，不推进阶段', async () => {
    const target = await createPendingCandidate('workflow-auto-pending');
    const reviewed = await submitManualReview(pool, {
      actorRole: 'admin',
      actorUserId,
      candidateId: target,
      decision: 'pending',
      expectedVersion: 1,
      reason: '需要再看一条作品',
      workspaceId,
    });
    expect(reviewed).toMatchObject({ pipelineStatus: 'pending_review', version: 2 });
    const workflow = await getCandidateWorkflow(pool, adminAccess(), target);
    expect(workflow.pipelineStatus).toBe('pending_review');
    expect(workflow.events.map((event) => event.eventType)).toEqual(['manual_reviewed']);
  });

  it('已离开待复核阶段时补交结论只记录历史，不改变阶段也不报错', async () => {
    const target = await createPendingCandidate('workflow-auto-late');
    await transitionCandidatePipeline(pool, {
      actorRole: 'admin',
      actorUserId,
      candidateId: target,
      expectedVersion: 1,
      nextStatus: 'to_contact',
      workspaceId,
    });
    await transitionCandidatePipeline(pool, {
      actorRole: 'admin',
      actorUserId,
      candidateId: target,
      expectedVersion: 2,
      nextStatus: 'contacted',
      workspaceId,
    });
    const reviewed = await submitManualReview(pool, {
      actorRole: 'admin',
      actorUserId,
      candidateId: target,
      decision: 'rejected',
      expectedVersion: 3,
      reason: '补记：沟通后判断调性不符',
      workspaceId,
    });
    expect(reviewed).toMatchObject({ pipelineStatus: 'contacted', version: 4 });
    const workflow = await getCandidateWorkflow(pool, adminAccess(), target);
    expect(workflow.pipelineStatus).toBe('contacted');
    expect(workflow.reviews[0]).toMatchObject({ decision: 'rejected' });
  });

  it('写审计失败时复核结论与阶段推进一并回滚', async () => {
    const target = await createPendingCandidate('workflow-auto-rollback');
    const realConnection = await pool.getConnection();
    const failingPool = {
      getConnection: async () =>
        new Proxy(realConnection, {
          get(connection, property) {
            if (property === 'execute') {
              return (sql: string, parameters?: unknown[]) => {
                if (sql.includes('audit_events')) {
                  return Promise.reject(new Error('injected audit failure'));
                }
                return connection.execute(sql as never, parameters as never);
              };
            }
            const value = Reflect.get(connection, property);
            return typeof value === 'function' ? value.bind(connection) : value;
          },
        }),
    } as unknown as Pool;

    await expect(
      submitManualReview(failingPool, {
        actorRole: 'admin',
        actorUserId,
        candidateId: target,
        decision: 'approved',
        expectedVersion: 1,
        workspaceId,
      }),
    ).rejects.toThrow('injected audit failure');

    const workflow = await getCandidateWorkflow(pool, adminAccess(), target);
    expect(workflow.pipelineStatus).toBe('pending_review');
    expect(workflow.candidateVersion).toBe(1);
    expect(workflow.reviews).toEqual([]);
    expect(workflow.events).toEqual([]);
  });

  it('归档与恢复在同一事务内写事件和审计，并各递增一次版本', async () => {
    const target = await createPendingCandidate('workflow-archive');
    const archived = await archiveCandidate(pool, {
      actorRole: 'admin',
      actorUserId,
      candidateId: target,
      expectedVersion: 1,
      note: '重复账号',
      workspaceId,
    });
    expect(archived).toEqual({ id: target, version: 2 });

    const [archivedRows] = await pool.query<RowDataPacket[]>(
      'SELECT archived_at FROM campaign_candidates WHERE id = ?',
      [target],
    );
    expect(archivedRows[0]?.archived_at).toBeInstanceOf(Date);

    const restored = await unarchiveCandidate(pool, {
      actorRole: 'admin',
      actorUserId,
      candidateId: target,
      expectedVersion: 2,
      workspaceId,
    });
    expect(restored).toEqual({ id: target, version: 3 });
    const [restoredRows] = await pool.query<RowDataPacket[]>(
      'SELECT archived_at FROM campaign_candidates WHERE id = ?',
      [target],
    );
    expect(restoredRows[0]?.archived_at).toBeNull();

    const workflow = await getCandidateWorkflow(pool, adminAccess(), target);
    expect(new Set(workflow.events.map((event) => event.eventType))).toEqual(
      new Set(['archived', 'unarchived']),
    );
    const [auditRows] = await pool.query<RowDataPacket[]>(
      `SELECT action FROM audit_events
       WHERE workspace_id = ? AND subject_id = ? ORDER BY created_at, id`,
      [workspaceId, target],
    );
    expect(auditRows.map((row) => row.action)).toEqual([
      'candidate.archived',
      'candidate.unarchived',
    ]);
  });

  it('归档遇到版本冲突或越权目标时不做任何修改', async () => {
    const target = await createPendingCandidate('workflow-archive-conflict');
    await expect(
      archiveCandidate(pool, {
        actorRole: 'admin',
        actorUserId,
        candidateId: target,
        expectedVersion: 9,
        workspaceId,
      }),
    ).rejects.toBeInstanceOf(CandidateVersionConflictError);

    await expect(
      archiveCandidate(pool, {
        actorRole: 'admin',
        actorUserId,
        candidateId: randomUUID(),
        expectedVersion: 1,
        workspaceId,
      }),
    ).rejects.toBeInstanceOf(CandidateWorkflowNotFoundError);

    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT archived_at, version FROM campaign_candidates WHERE id = ?',
      [target],
    );
    expect(rows[0]?.archived_at).toBeNull();
    expect(rows[0]?.version).toBe(1);
  });
  const readTagNames = async (targetCandidateId: string) => {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT tags.name FROM candidate_tags
       JOIN tags ON tags.workspace_id = candidate_tags.workspace_id
        AND tags.id = candidate_tags.tag_id
       WHERE candidate_tags.workspace_id = ? AND candidate_tags.candidate_id = ?`,
      [workspaceId, targetCandidateId],
    );
    return rows.map((row) => row.name as string).sort();
  };

  it('标签按名复用同一词表，移除只解除关联', async () => {
    const first = await createPendingCandidate('workflow-tags-first');
    const second = await createPendingCandidate('workflow-tags-second');

    const created = await setCandidateTags(pool, {
      actorRole: 'admin',
      actorUserId,
      candidateId: first,
      tags: [' 情侣 ', '校园', '校园'],
      workspaceId,
    });
    expect(created).toEqual({ id: first, tags: ['情侣', '校园'] });
    await setCandidateTags(pool, {
      actorRole: 'admin',
      actorUserId,
      candidateId: second,
      tags: ['情侣'],
      workspaceId,
    });

    const [vocabulary] = await pool.query<RowDataPacket[]>(
      `SELECT name FROM tags WHERE workspace_id = ? AND name IN ('情侣', '校园')`,
      [workspaceId],
    );
    expect(vocabulary).toHaveLength(2);
    expect(await readTagNames(first)).toEqual(['情侣', '校园'].sort());
    expect(await readTagNames(second)).toEqual(['情侣']);

    // 达人库既有的 tagNames 过滤直接命中新写入的关联，无需额外索引或改查询。
    const filtered = await listCandidates(pool, {
      ...adminAccess(),
      limit: 50,
      tagNames: ['情侣'],
    });
    expect(filtered.map((item) => item.id).sort()).toEqual([first, second].sort());

    // 同样的标签集合重复提交是空操作：不写事件，也不写审计。
    const [eventsBefore] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS total FROM candidate_events
       WHERE candidate_id = ? AND event_type = 'tags_changed'`,
      [first],
    );
    await setCandidateTags(pool, {
      actorRole: 'admin',
      actorUserId,
      candidateId: first,
      tags: ['校园', '情侣'],
      workspaceId,
    });
    const [eventsAfter] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS total FROM candidate_events
       WHERE candidate_id = ? AND event_type = 'tags_changed'`,
      [first],
    );
    expect(Number(eventsAfter[0]?.total)).toBe(Number(eventsBefore[0]?.total));

    await setCandidateTags(pool, {
      actorRole: 'admin',
      actorUserId,
      candidateId: second,
      tags: [],
      workspaceId,
    });
    expect(await readTagNames(second)).toEqual([]);
    // 词表里的「情侣」仍在，第一位达人的关联不受影响。
    expect(await readTagNames(first)).toEqual(['情侣', '校园'].sort());

    const [eventRows] = await pool.query<RowDataPacket[]>(
      `SELECT candidate_id, changed_fields_json FROM candidate_events
       WHERE candidate_id IN (?, ?) AND event_type = 'tags_changed'
       ORDER BY created_at, id`,
      [first, second],
    );
    expect(eventRows).toHaveLength(3);
    expect(eventRows[0]?.changed_fields_json).toMatchObject({
      added: ['情侣', '校园'],
      removed: [],
    });
    expect(eventRows[2]?.changed_fields_json).toMatchObject({ removed: ['情侣'] });

    const [audits] = await pool.query<RowDataPacket[]>(
      `SELECT action FROM audit_events WHERE subject_id IN (?, ?) AND subject_type = 'candidate'`,
      [first, second],
    );
    expect(audits).toHaveLength(3);
    expect(audits.every((row) => row.action === 'candidate.tags_changed')).toBe(true);
  });

  it('两名成员同时创建同名标签时词表只留一行且都指向它', async () => {
    const left = await createPendingCandidate('workflow-tags-race-left');
    const right = await createPendingCandidate('workflow-tags-race-right');

    await Promise.all([
      setCandidateTags(pool, {
        actorRole: 'admin',
        actorUserId,
        candidateId: left,
        tags: ['并发标签'],
        workspaceId,
      }),
      setCandidateTags(pool, {
        actorRole: 'admin',
        actorUserId,
        candidateId: right,
        tags: ['并发标签'],
        workspaceId,
      }),
    ]);

    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT tags.id, COUNT(candidate_tags.candidate_id) AS total
       FROM tags
       LEFT JOIN candidate_tags ON candidate_tags.workspace_id = tags.workspace_id
        AND candidate_tags.tag_id = tags.id
       WHERE tags.workspace_id = ? AND tags.name = '并发标签'
       GROUP BY tags.id`,
      [workspaceId],
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.total)).toBe(2);
  });

  it('只读成员与可见范围之外的成员都不能改标签', async () => {
    const target = await createPendingCandidate('workflow-tags-guard');

    await expect(
      setCandidateTags(pool, {
        actorRole: 'readonly',
        actorUserId,
        candidateId: target,
        tags: ['受限标签'],
        workspaceId,
      }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);

    const outsiderId = randomUUID();
    await pool.execute(
      `INSERT INTO users (id, email, password_hash, display_name)
       VALUES (?, ?, 'integration-test-only', '范围外成员')`,
      [outsiderId, `tags-outsider-${outsiderId}@example.test`],
    );
    await pool.execute(
      `INSERT INTO memberships (workspace_id, user_id, role) VALUES (?, ?, 'operator')`,
      [workspaceId, outsiderId],
    );
    await expect(
      setCandidateTags(pool, {
        actorRole: 'operator',
        actorUserId: outsiderId,
        candidateId: target,
        tags: ['受限标签'],
        workspaceId,
      }),
    ).rejects.toBeInstanceOf(CandidateWorkflowNotFoundError);

    const [vocabulary] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS total FROM tags WHERE workspace_id = ? AND name = '受限标签'`,
      [workspaceId],
    );
    expect(Number(vocabulary[0]?.total)).toBe(0);
    expect(await readTagNames(target)).toEqual([]);
    const [events] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS total FROM candidate_events
       WHERE candidate_id = ? AND event_type = 'tags_changed'`,
      [target],
    );
    expect(Number(events[0]?.total)).toBe(0);
  });
  it('批量复核与单条语义一致：各自推进阶段、各递增一次版本、事件与审计各一条', async () => {
    const targets = [
      await createPendingCandidate('workflow-batch-approve-a'),
      await createPendingCandidate('workflow-batch-approve-b'),
      await createPendingCandidate('workflow-batch-approve-c'),
    ];

    const result = await batchSubmitManualReview(pool, {
      actorRole: 'admin',
      actorUserId,
      decision: 'approved',
      items: targets.map((candidateId) => ({ candidateId, expectedVersion: 1 })),
      workspaceId,
    });

    expect(result.succeeded).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.results).toEqual(targets.map((id) => ({ id, ok: true })));

    const [candidates] = await pool.query<RowDataPacket[]>(
      `SELECT id, pipeline_status, version FROM campaign_candidates WHERE id IN (?, ?, ?)`,
      targets,
    );
    expect(candidates).toHaveLength(3);
    expect(
      candidates.every((row) => row.pipeline_status === 'to_contact' && Number(row.version) === 2),
    ).toBe(true);

    const [totals] = await pool.query<RowDataPacket[]>(
      `SELECT (SELECT COUNT(*) FROM manual_reviews WHERE candidate_id IN (?, ?, ?))
            + (SELECT COUNT(*) FROM candidate_events
                WHERE candidate_id IN (?, ?, ?) AND event_type = 'manual_reviewed')
            + (SELECT COUNT(*) FROM candidate_events
                WHERE candidate_id IN (?, ?, ?) AND event_type = 'pipeline_status_changed')
            + (SELECT COUNT(*) FROM audit_events
                WHERE subject_id IN (?, ?, ?) AND action = 'candidate.reviewed') AS total`,
      [...targets, ...targets, ...targets, ...targets],
    );
    // 三个候选 x（1 条复核 + 1 条复核事件 + 1 条阶段事件 + 1 条审计）= 12，
    // 与逐条调用单条领域函数的产物完全一致。
    expect(Number(totals[0]?.total)).toBe(12);
  });

  it('批量操作部分成功：失败项原因明确、数据完全未变，成功项不被回滚', async () => {
    const accepted = await createPendingCandidate('workflow-batch-partial-ok');
    const stale = await createPendingCandidate('workflow-batch-partial-stale');
    const missing = randomUUID();

    const result = await batchSubmitManualReview(pool, {
      actorRole: 'admin',
      actorUserId,
      decision: 'approved',
      items: [
        { candidateId: accepted, expectedVersion: 1 },
        { candidateId: stale, expectedVersion: 9 },
        { candidateId: missing, expectedVersion: 1 },
      ],
      workspaceId,
    });

    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(2);
    expect(result.results).toEqual([
      { id: accepted, ok: true },
      { code: 'VERSION_CONFLICT', currentVersion: 1, id: stale, ok: false },
      { code: 'CANDIDATE_NOT_FOUND', id: missing, ok: false },
    ]);

    // 成功项照常推进，说明没有聚合式回滚。
    const [advanced] = await pool.query<RowDataPacket[]>(
      'SELECT pipeline_status, version FROM campaign_candidates WHERE id = ?',
      [accepted],
    );
    expect(advanced[0]).toMatchObject({ pipeline_status: 'to_contact', version: 2 });

    // 失败项一点痕迹都不留：阶段、版本、复核记录、事件、审计全部为空。
    const [untouched] = await pool.query<RowDataPacket[]>(
      `SELECT pipeline_status, version,
              (SELECT COUNT(*) FROM manual_reviews WHERE candidate_id = ?) AS reviews,
              (SELECT COUNT(*) FROM candidate_events WHERE candidate_id = ?) AS events,
              (SELECT COUNT(*) FROM audit_events WHERE subject_id = ?) AS audits
       FROM campaign_candidates WHERE id = ?`,
      [stale, stale, stale, stale],
    );
    expect(untouched[0]).toMatchObject({
      audits: 0,
      events: 0,
      pipeline_status: 'pending_review',
      reviews: 0,
      version: 1,
    });

    // 越权目标与不存在目标返回同一个码，且同样不留痕迹。
    const outsiderId = randomUUID();
    await pool.execute(
      `INSERT INTO users (id, email, password_hash, display_name)
       VALUES (?, ?, 'integration-test-only', '批量越权成员')`,
      [outsiderId, `batch-outsider-${outsiderId}@example.test`],
    );
    await pool.execute(
      `INSERT INTO memberships (workspace_id, user_id, role) VALUES (?, ?, 'operator')`,
      [workspaceId, outsiderId],
    );
    const own = await createPendingCandidate('workflow-batch-partial-own');
    const foreign = await createPendingCandidate('workflow-batch-partial-foreign');
    await pool.execute(`UPDATE campaign_candidates SET assignee_user_id = ? WHERE id = ?`, [
      outsiderId,
      own,
    ]);

    const scoped = await batchArchiveCandidates(pool, {
      actorRole: 'operator',
      actorUserId: outsiderId,
      items: [
        { candidateId: own, expectedVersion: 1 },
        { candidateId: foreign, expectedVersion: 1 },
      ],
      workspaceId,
    });
    expect(scoped.results).toEqual([
      { id: own, ok: true },
      { code: 'CANDIDATE_NOT_FOUND', id: foreign, ok: false },
    ]);
    const [foreignRows] = await pool.query<RowDataPacket[]>(
      'SELECT archived_at, version FROM campaign_candidates WHERE id = ?',
      [foreign],
    );
    expect(foreignRows[0]?.archived_at).toBeNull();
    expect(Number(foreignRows[0]?.version)).toBe(1);
    const [ownRows] = await pool.query<RowDataPacket[]>(
      'SELECT archived_at, version FROM campaign_candidates WHERE id = ?',
      [own],
    );
    expect(ownRows[0]?.archived_at).toBeInstanceOf(Date);
    expect(Number(ownRows[0]?.version)).toBe(2);
  });
});
