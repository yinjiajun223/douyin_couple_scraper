import type { Pool, RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDefaultCampaignRuleSet } from '@douyin/contracts';

import { bootstrapFirstAdmin } from '../auth/bootstrap-admin.js';
import { createMysqlPool, runMigrations } from '../database/migrations.js';
import { seedInitialWorkspace } from '../database/seed.js';
import { getOperationsDashboard } from '../dashboard/operations-dashboard.js';
import {
  appendCandidateNote,
  CandidateVersionConflictError,
  getCandidateWorkflow,
  InvalidPipelineTransitionError,
  OutreachVersionConflictError,
  submitManualReview,
  transitionCandidatePipeline,
  updateCandidateOutreach,
} from './candidate-workflow.js';
import { exportCandidateCsv } from './candidate-export.js';

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
    await pool.execute(
      `INSERT INTO ai_analysis_runs
       (id, workspace_id, candidate_id, prompt_version, result_schema_version,
        input_evidence_json, normalized_result_json, status, completed_at)
       VALUES (?, ?, ?, 'test-v1', 1, '{}', ?, 'succeeded', CURRENT_TIMESTAMP(3))`,
      [
        '7a000000-0000-4000-8000-000000000009',
        workspaceId,
        candidateId,
        JSON.stringify({ suitability: { value: 'recommended', confidence: 0.9 } }),
      ],
    );
  });

  afterAll(async () => pool.end());

  it('manual decision overrides the business conclusion without changing AI evidence', async () => {
    await submitManualReview(pool, {
      actorRole: 'admin',
      actorUserId,
      candidateId,
      decision: 'rejected',
      expectedVersion: 1,
      reason: '内容调性不适合本次应用推广',
      workspaceId,
    });
    const workflow = await getCandidateWorkflow(pool, adminAccess(), candidateId);
    expect(workflow.reviews[0]).toMatchObject({
      decision: 'rejected',
      reason: '内容调性不适合本次应用推广',
    });
    const [aiRows] = await pool.query<RowDataPacket[]>(
      'SELECT normalized_result_json FROM ai_analysis_runs WHERE candidate_id = ?',
      [candidateId],
    );
    expect(aiRows[0]?.normalized_result_json).toMatchObject({
      suitability: { value: 'recommended' },
    });
  });

  it('records allowed status transitions and rejects skipped stages', async () => {
    const before = await getCandidateWorkflow(pool, adminAccess(), candidateId);
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
    const moved = await transitionCandidatePipeline(pool, {
      actorRole: 'admin',
      actorUserId,
      candidateId,
      expectedVersion: before.candidateVersion,
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
});
