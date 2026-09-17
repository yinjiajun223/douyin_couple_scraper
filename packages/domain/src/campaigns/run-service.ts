import { randomUUID } from 'node:crypto';

import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';

import { collectorRunProgressSchema, parseCampaignRuleSet } from '@douyin/contracts';
import type { CampaignRuleSet, CollectorRunProgress } from '@douyin/contracts';

import { writeAuditEvent } from '../audit/audit-events.js';
import { CampaignRecordNotFoundError } from './campaign-service.js';

export const COLLECTION_RUN_STATUSES = [
  'ready',
  'claimed',
  'running',
  'paused',
  'completed',
  'failed',
  'terminated',
] as const;

export type CollectionRunStatus = (typeof COLLECTION_RUN_STATUSES)[number];

const allowedRunTransitions: Readonly<Record<CollectionRunStatus, readonly CollectionRunStatus[]>> =
  {
    ready: ['claimed', 'terminated'],
    claimed: ['running', 'terminated'],
    running: ['paused', 'completed', 'failed', 'terminated'],
    paused: ['running', 'failed', 'terminated'],
    completed: [],
    failed: [],
    terminated: [],
  };

const createRunSchema = z
  .object({
    workspaceId: z.uuid(),
    campaignId: z.uuid(),
    actorUserId: z.uuid(),
  })
  .strict();

const deviceRunActionSchema = z
  .object({
    workspaceId: z.uuid(),
    runId: z.uuid(),
    deviceId: z.uuid(),
  })
  .strict();

const userRunActionSchema = z
  .object({
    workspaceId: z.uuid(),
    runId: z.uuid(),
    actorUserId: z.uuid(),
  })
  .strict();

const reportProgressSchema = deviceRunActionSchema.extend({
  progress: collectorRunProgressSchema,
});

interface CampaignForRunRow extends RowDataPacket {
  id: string;
  rule_schema_version: number;
  rules_json: CampaignRuleSet;
  status: 'active' | 'archived';
}

interface NextVersionRow extends RowDataPacket {
  next_version: number;
}

interface CollectionRunRow extends RowDataPacket {
  campaign_id: string;
  id: string;
  progress_json: CollectorRunProgress;
  rule_version_id: string;
  rules_json: CampaignRuleSet;
  status: CollectionRunStatus;
  stop_reason: CollectionRunStopReason | null;
}

interface ReadyCollectionRunRow extends CollectionRunRow {
  campaign_name: string;
  recommendation_profile_description: string | null;
  rule_version: number;
}

interface CollectionRunSummaryRow extends ReadyCollectionRunRow {
  claimed_at: Date | null;
  created_at: Date;
  device_id: string | null;
  device_name: string | null;
  ended_at: Date | null;
  error_code: string | null;
  error_message: string | null;
  started_at: Date | null;
  updated_at: Date;
}

interface RunDeviceRow extends RowDataPacket {
  device_id: string;
}

export type CollectionRunStopReason =
  | 'max_feed_items'
  | 'max_creator_profiles'
  | 'max_duration_minutes'
  | 'target_candidates'
  | 'manual_termination';

export interface ReadyCollectionRun {
  id: string;
  campaignId: string;
  campaignName: string;
  recommendationProfileDescription: string | null;
  ruleVersionId: string;
  ruleVersion: number;
  status: 'ready';
  rules: CampaignRuleSet;
}

export interface CollectionRunSummary {
  id: string;
  campaignId: string;
  campaignName: string;
  ruleVersion: number;
  status: CollectionRunStatus;
  stopReason: CollectionRunStopReason | null;
  errorCode: string | null;
  errorMessage: string | null;
  progress: CollectorRunProgress;
  device: { id: string; name: string } | null;
  claimedAt: Date | null;
  startedAt: Date | null;
  endedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreatedCollectionRun {
  id: string;
  campaignId: string;
  ruleVersionId: string;
  ruleVersion: number;
  status: 'ready';
  rules: CampaignRuleSet;
}

export class CampaignNotActiveError extends Error {
  constructor() {
    super('已归档的筛选任务不能创建新运行');
    this.name = 'CampaignNotActiveError';
  }
}

export class InvalidRunStatusTransitionError extends Error {
  constructor(
    readonly from: CollectionRunStatus,
    readonly to: CollectionRunStatus,
  ) {
    super(`采集运行不能从 ${from} 直接变更为 ${to}`);
    this.name = 'InvalidRunStatusTransitionError';
  }
}

export class CollectionRunNotFoundError extends Error {
  constructor() {
    super('找不到采集运行');
    this.name = 'CollectionRunNotFoundError';
  }
}

export class CollectionRunDeviceMismatchError extends Error {
  constructor() {
    super('当前采集设备没有领取这次运行');
    this.name = 'CollectionRunDeviceMismatchError';
  }
}

export class CollectionRunNotRunningError extends Error {
  constructor(readonly status: CollectionRunStatus) {
    super(`只有运行中的采集任务可以上报进度，当前状态为 ${status}`);
    this.name = 'CollectionRunNotRunningError';
  }
}

export class RunProgressRegressionError extends Error {
  constructor() {
    super('累计运行进度不能小于已经确认的进度');
    this.name = 'RunProgressRegressionError';
  }
}

export function canTransitionRunStatus(
  from: CollectionRunStatus,
  to: CollectionRunStatus,
): boolean {
  return allowedRunTransitions[from].includes(to);
}

export function assertRunStatusTransition(
  from: CollectionRunStatus,
  to: CollectionRunStatus,
): void {
  if (!canTransitionRunStatus(from, to)) {
    throw new InvalidRunStatusTransitionError(from, to);
  }
}

export function determineRunStopReason(
  rules: CampaignRuleSet,
  progress: CollectorRunProgress,
): CollectionRunStopReason | null {
  const conditions = rules.stopConditions;
  if (
    conditions.targetCandidates !== undefined &&
    progress.candidatesFound >= conditions.targetCandidates
  ) {
    return 'target_candidates';
  }
  if (conditions.maxFeedItems !== undefined && progress.feedItemsSeen >= conditions.maxFeedItems) {
    return 'max_feed_items';
  }
  if (
    conditions.maxCreatorProfiles !== undefined &&
    progress.creatorProfilesSeen >= conditions.maxCreatorProfiles
  ) {
    return 'max_creator_profiles';
  }
  if (
    conditions.maxDurationMinutes !== undefined &&
    progress.elapsedSeconds >= conditions.maxDurationMinutes * 60
  ) {
    return 'max_duration_minutes';
  }
  return null;
}

export async function createCollectionRun(
  pool: Pool,
  rawInput: unknown,
): Promise<CreatedCollectionRun> {
  const input = createRunSchema.parse(rawInput);
  return withTransaction(pool, async (connection) => {
    const [campaigns] = await connection.query<CampaignForRunRow[]>(
      `SELECT id, status, rule_schema_version, rules_json
       FROM campaigns
       WHERE workspace_id = ? AND id = ?
       FOR UPDATE`,
      [input.workspaceId, input.campaignId],
    );
    const campaign = campaigns[0];
    if (!campaign) throw new CampaignRecordNotFoundError('campaign');
    if (campaign.status !== 'active') throw new CampaignNotActiveError();

    const rules = parseCampaignRuleSet(campaign.rules_json);
    const [versions] = await connection.query<NextVersionRow[]>(
      `SELECT COALESCE(MAX(version), 0) + 1 AS next_version
       FROM campaign_rule_versions
       WHERE campaign_id = ?`,
      [input.campaignId],
    );
    const ruleVersion = Number(versions[0]?.next_version ?? 1);
    const ruleVersionId = randomUUID();
    const runId = randomUUID();

    await connection.execute(
      `INSERT INTO campaign_rule_versions
       (id, workspace_id, campaign_id, version, rule_schema_version, rules_json,
        created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        ruleVersionId,
        input.workspaceId,
        input.campaignId,
        ruleVersion,
        campaign.rule_schema_version,
        JSON.stringify(rules),
        input.actorUserId,
      ],
    );
    await connection.execute(
      `INSERT INTO collection_runs
       (id, workspace_id, campaign_id, rule_version_id, status, progress_json,
        created_by_user_id)
       VALUES (?, ?, ?, ?, 'ready', ?, ?)`,
      [
        runId,
        input.workspaceId,
        input.campaignId,
        ruleVersionId,
        JSON.stringify({
          feedItemsSeen: 0,
          creatorProfilesSeen: 0,
          candidatesFound: 0,
          elapsedSeconds: 0,
        }),
        input.actorUserId,
      ],
    );
    await writeAuditEvent(connection, {
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      action: 'campaign.run_created',
      subjectType: 'collection_run',
      subjectId: runId,
      summary: { campaignId: input.campaignId, ruleVersion },
    });

    return {
      id: runId,
      campaignId: input.campaignId,
      ruleVersionId,
      ruleVersion,
      status: 'ready',
      rules,
    };
  });
}

export async function listReadyCollectionRuns(
  pool: Pool,
  workspaceId: string,
  limit = 20,
): Promise<ReadyCollectionRun[]> {
  const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 100));
  const [rows] = await pool.query<ReadyCollectionRunRow[]>(
    `SELECT runs.id, runs.campaign_id, runs.rule_version_id, runs.status,
            runs.stop_reason, runs.progress_json, campaigns.name AS campaign_name,
            campaigns.recommendation_profile_description,
            versions.version AS rule_version, versions.rules_json
     FROM collection_runs runs
     JOIN campaigns ON campaigns.id = runs.campaign_id
     JOIN campaign_rule_versions versions ON versions.id = runs.rule_version_id
     WHERE runs.workspace_id = ? AND runs.status = 'ready'
     ORDER BY runs.created_at
     LIMIT ?`,
    [workspaceId, boundedLimit],
  );
  return rows.map((row) => ({
    id: row.id,
    campaignId: row.campaign_id,
    campaignName: row.campaign_name,
    recommendationProfileDescription: row.recommendation_profile_description,
    ruleVersionId: row.rule_version_id,
    ruleVersion: row.rule_version,
    status: 'ready',
    rules: parseCampaignRuleSet(row.rules_json),
  }));
}

export async function listCollectionRuns(
  pool: Pool,
  workspaceId: string,
  campaignId?: string,
  limit = 100,
): Promise<CollectionRunSummary[]> {
  const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 200));
  const campaignFilter = campaignId ? ' AND runs.campaign_id = ?' : '';
  const parameters: Array<string | number> = [workspaceId];
  if (campaignId) parameters.push(campaignId);
  parameters.push(boundedLimit);
  const [rows] = await pool.query<CollectionRunSummaryRow[]>(
    `SELECT runs.id, runs.campaign_id, runs.rule_version_id, runs.status,
            runs.stop_reason, runs.error_code, runs.error_message, runs.progress_json,
            runs.claimed_at, runs.started_at, runs.ended_at, runs.created_at, runs.updated_at,
            campaigns.name AS campaign_name, campaigns.recommendation_profile_description,
            versions.version AS rule_version, versions.rules_json,
            devices.id AS device_id, devices.name AS device_name
     FROM collection_runs runs
     JOIN campaigns ON campaigns.id = runs.campaign_id
     JOIN campaign_rule_versions versions ON versions.id = runs.rule_version_id
     LEFT JOIN run_devices ON run_devices.run_id = runs.id
     LEFT JOIN devices ON devices.id = run_devices.device_id
     WHERE runs.workspace_id = ?${campaignFilter}
     ORDER BY runs.created_at DESC
     LIMIT ?`,
    parameters,
  );
  return rows.map((row) => ({
    id: row.id,
    campaignId: row.campaign_id,
    campaignName: row.campaign_name,
    ruleVersion: row.rule_version,
    status: row.status,
    stopReason: row.stop_reason,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    progress: collectorRunProgressSchema.parse(row.progress_json),
    device: row.device_id && row.device_name ? { id: row.device_id, name: row.device_name } : null,
    claimedAt: row.claimed_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function listCollectorRuns(pool: Pool, workspaceId: string, deviceId: string) {
  const [rows] = await pool.query<ReadyCollectionRunRow[]>(
    `SELECT runs.id, runs.status, runs.progress_json, runs.stop_reason,
            campaigns.name AS campaign_name, versions.rules_json
     FROM collection_runs runs
     JOIN campaigns ON campaigns.id = runs.campaign_id
     JOIN campaign_rule_versions versions ON versions.id = runs.rule_version_id
     LEFT JOIN run_devices ON run_devices.run_id = runs.id
     WHERE runs.workspace_id = ?
       AND (runs.status = 'ready' OR run_devices.device_id = ?)
     ORDER BY (runs.status IN ('claimed', 'running', 'paused')) DESC, runs.created_at DESC
     LIMIT 200`,
    [workspaceId, deviceId],
  );
  return rows.map((row) => ({
    id: row.id,
    campaignName: row.campaign_name,
    status: row.status,
    progress: collectorRunProgressSchema.parse(row.progress_json),
    rules: parseCampaignRuleSet(row.rules_json),
    stopReason: row.stop_reason,
  }));
}

export async function claimCollectionRun(pool: Pool, rawInput: unknown) {
  const input = deviceRunActionSchema.parse(rawInput);
  return withTransaction(pool, async (connection) => {
    const run = await findRunForUpdate(connection, input.workspaceId, input.runId);
    assertRunStatusTransition(run.status, 'claimed');
    await connection.execute(
      `INSERT INTO run_devices (workspace_id, run_id, device_id)
       VALUES (?, ?, ?)`,
      [input.workspaceId, input.runId, input.deviceId],
    );
    await connection.execute(
      `UPDATE collection_runs
       SET status = 'claimed', claimed_at = CURRENT_TIMESTAMP(3)
       WHERE workspace_id = ? AND id = ?`,
      [input.workspaceId, input.runId],
    );
    await writeRunStatusAudit(connection, {
      workspaceId: input.workspaceId,
      actorDeviceId: input.deviceId,
      runId: input.runId,
      from: run.status,
      to: 'claimed',
    });
    return { id: input.runId, status: 'claimed' as const };
  });
}

export async function startClaimedCollectionRun(pool: Pool, rawInput: unknown) {
  const input = deviceRunActionSchema.parse(rawInput);
  return withTransaction(pool, async (connection) => {
    const run = await findRunForUpdate(connection, input.workspaceId, input.runId);
    await assertRunOwnedByDevice(connection, input.runId, input.deviceId);
    assertRunStatusTransition(run.status, 'running');
    await connection.execute(
      `UPDATE collection_runs
       SET status = 'running', started_at = COALESCE(started_at, CURRENT_TIMESTAMP(3))
       WHERE workspace_id = ? AND id = ?`,
      [input.workspaceId, input.runId],
    );
    await connection.execute(
      `UPDATE run_devices
       SET started_at = COALESCE(started_at, CURRENT_TIMESTAMP(3))
       WHERE run_id = ? AND device_id = ?`,
      [input.runId, input.deviceId],
    );
    await writeRunStatusAudit(connection, {
      workspaceId: input.workspaceId,
      actorDeviceId: input.deviceId,
      runId: input.runId,
      from: run.status,
      to: 'running',
    });
    return { id: input.runId, status: 'running' as const };
  });
}

export async function pauseCollectionRun(pool: Pool, rawInput: unknown) {
  return changeRunStatusByUser(pool, rawInput, 'paused');
}

export async function resumeCollectionRun(pool: Pool, rawInput: unknown) {
  return changeRunStatusByUser(pool, rawInput, 'running');
}

export async function terminateCollectionRun(pool: Pool, rawInput: unknown) {
  return changeRunStatusByUser(pool, rawInput, 'terminated');
}

export async function pauseCollectionRunByDevice(pool: Pool, rawInput: unknown) {
  return changeRunStatusByDevice(pool, rawInput, 'paused');
}

export async function resumeCollectionRunByDevice(pool: Pool, rawInput: unknown) {
  return changeRunStatusByDevice(pool, rawInput, 'running');
}

export async function terminateCollectionRunByDevice(pool: Pool, rawInput: unknown) {
  return changeRunStatusByDevice(pool, rawInput, 'terminated');
}

export async function reportCollectionRunProgress(pool: Pool, rawInput: unknown) {
  const input = reportProgressSchema.parse(rawInput);
  return withTransaction(pool, async (connection) => {
    const run = await findRunForUpdate(connection, input.workspaceId, input.runId);
    await assertRunOwnedByDevice(connection, input.runId, input.deviceId);
    if (run.status !== 'running') throw new CollectionRunNotRunningError(run.status);
    const previous = collectorRunProgressSchema.parse(run.progress_json);
    if (hasProgressRegression(previous, input.progress)) throw new RunProgressRegressionError();

    const rules = parseCampaignRuleSet(run.rules_json);
    const stopReason = determineRunStopReason(rules, input.progress);
    if (stopReason) assertRunStatusTransition(run.status, 'completed');
    await connection.execute(
      `UPDATE collection_runs
       SET progress_json = ?, status = ?, stop_reason = ?,
           ended_at = CASE WHEN ? IS NULL THEN ended_at ELSE CURRENT_TIMESTAMP(3) END
       WHERE workspace_id = ? AND id = ?`,
      [
        JSON.stringify(input.progress),
        stopReason ? 'completed' : 'running',
        stopReason,
        stopReason,
        input.workspaceId,
        input.runId,
      ],
    );
    if (stopReason) {
      await connection.execute(
        `UPDATE run_devices SET completed_at = CURRENT_TIMESTAMP(3)
         WHERE run_id = ? AND device_id = ?`,
        [input.runId, input.deviceId],
      );
      await writeRunStatusAudit(connection, {
        workspaceId: input.workspaceId,
        actorDeviceId: input.deviceId,
        runId: input.runId,
        from: run.status,
        to: 'completed',
        stopReason,
      });
    }
    return {
      id: input.runId,
      status: stopReason ? ('completed' as const) : ('running' as const),
      stopReason,
      progress: input.progress,
    };
  });
}

async function changeRunStatusByUser(
  pool: Pool,
  rawInput: unknown,
  target: 'paused' | 'running' | 'terminated',
) {
  const input = userRunActionSchema.parse(rawInput);
  return withTransaction(pool, async (connection) => {
    const run = await findRunForUpdate(connection, input.workspaceId, input.runId);
    assertRunStatusTransition(run.status, target);
    await connection.execute(
      `UPDATE collection_runs
       SET status = ?, ended_at = CASE WHEN ? = 'terminated' THEN CURRENT_TIMESTAMP(3) ELSE ended_at END,
           stop_reason = CASE WHEN ? = 'terminated' THEN 'manual_termination' ELSE stop_reason END
       WHERE workspace_id = ? AND id = ?`,
      [target, target, target, input.workspaceId, input.runId],
    );
    await writeRunStatusAudit(connection, {
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      runId: input.runId,
      from: run.status,
      to: target,
      ...(target === 'terminated' ? { stopReason: 'manual_termination' } : {}),
    });
    return { id: input.runId, status: target };
  });
}

async function changeRunStatusByDevice(
  pool: Pool,
  rawInput: unknown,
  target: 'paused' | 'running' | 'terminated',
) {
  const input = deviceRunActionSchema.parse(rawInput);
  return withTransaction(pool, async (connection) => {
    const run = await findRunForUpdate(connection, input.workspaceId, input.runId);
    await assertRunOwnedByDevice(connection, input.runId, input.deviceId);
    assertRunStatusTransition(run.status, target);
    await connection.execute(
      `UPDATE collection_runs
       SET status = ?, ended_at = CASE WHEN ? = 'terminated' THEN CURRENT_TIMESTAMP(3) ELSE ended_at END,
           stop_reason = CASE WHEN ? = 'terminated' THEN 'manual_termination' ELSE stop_reason END
       WHERE workspace_id = ? AND id = ?`,
      [target, target, target, input.workspaceId, input.runId],
    );
    await writeRunStatusAudit(connection, {
      workspaceId: input.workspaceId,
      actorDeviceId: input.deviceId,
      runId: input.runId,
      from: run.status,
      to: target,
      ...(target === 'terminated' ? { stopReason: 'manual_termination' } : {}),
    });
    return { id: input.runId, status: target };
  });
}

async function findRunForUpdate(
  connection: PoolConnection,
  workspaceId: string,
  runId: string,
): Promise<CollectionRunRow> {
  const [rows] = await connection.query<CollectionRunRow[]>(
    `SELECT runs.id, runs.campaign_id, runs.rule_version_id, runs.status,
            runs.stop_reason, runs.progress_json, versions.rules_json
     FROM collection_runs runs
     JOIN campaign_rule_versions versions ON versions.id = runs.rule_version_id
     WHERE runs.workspace_id = ? AND runs.id = ?
     FOR UPDATE`,
    [workspaceId, runId],
  );
  if (!rows[0]) throw new CollectionRunNotFoundError();
  return rows[0];
}

async function assertRunOwnedByDevice(connection: PoolConnection, runId: string, deviceId: string) {
  const [rows] = await connection.query<RunDeviceRow[]>(
    'SELECT device_id FROM run_devices WHERE run_id = ? AND device_id = ? LIMIT 1',
    [runId, deviceId],
  );
  if (!rows[0]) throw new CollectionRunDeviceMismatchError();
}

function hasProgressRegression(
  previous: CollectorRunProgress,
  next: CollectorRunProgress,
): boolean {
  return (
    next.feedItemsSeen < previous.feedItemsSeen ||
    next.creatorProfilesSeen < previous.creatorProfilesSeen ||
    next.candidatesFound < previous.candidatesFound ||
    next.elapsedSeconds < previous.elapsedSeconds
  );
}

async function writeRunStatusAudit(
  executor: Pick<PoolConnection, 'execute'>,
  input: {
    workspaceId: string;
    actorUserId?: string;
    actorDeviceId?: string;
    runId: string;
    from: CollectionRunStatus;
    to: CollectionRunStatus;
    stopReason?: string;
  },
) {
  await writeAuditEvent(executor, {
    workspaceId: input.workspaceId,
    ...(input.actorUserId ? { actorUserId: input.actorUserId } : {}),
    ...(input.actorDeviceId ? { actorDeviceId: input.actorDeviceId } : {}),
    action: 'campaign.run_status_changed',
    subjectType: 'collection_run',
    subjectId: input.runId,
    summary: {
      from: input.from,
      to: input.to,
      ...(input.stopReason ? { stopReason: input.stopReason } : {}),
    },
  });
}

async function withTransaction<T>(pool: Pool, work: (connection: PoolConnection) => Promise<T>) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
