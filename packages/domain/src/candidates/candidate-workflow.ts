import { randomUUID } from 'node:crypto';

import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';

import { writeAuditEvent } from '../audit/audit-events.js';
import type { WorkspaceRole } from '../auth/permissions.js';
import { candidateVisibilityPredicate, resolveCandidateScope } from './candidate-access.js';
import type { CandidateAccessContext } from './candidate-access.js';

export const PIPELINE_STATUSES = [
  'pending_review',
  'unsuitable',
  'to_contact',
  'contacted',
  'communicating',
  'partnered',
  'declined',
] as const;

export type PipelineStatus = (typeof PIPELINE_STATUSES)[number];
export type ManualDecision = 'pending' | 'approved' | 'rejected';

const allowedTransitions: Readonly<Record<PipelineStatus, readonly PipelineStatus[]>> = {
  pending_review: ['unsuitable', 'to_contact'],
  unsuitable: ['pending_review'],
  to_contact: ['unsuitable', 'contacted', 'declined'],
  contacted: ['communicating', 'declined'],
  communicating: ['contacted', 'partnered', 'declined'],
  partnered: ['communicating'],
  declined: ['to_contact', 'communicating'],
};

interface CandidateRow extends RowDataPacket {
  pipeline_status: PipelineStatus;
  version: number;
}

interface OutreachRow extends RowDataPacket {
  contact_channel: string | null;
  contact_value: string | null;
  cooperation_notes: string | null;
  currency: string | null;
  id: string;
  next_action: string | null;
  next_follow_up_at: Date | null;
  owner_user_id: string | null;
  owner_assigned_at: Date | null;
  owner_name: string | null;
  quoted_amount: string | number | null;
  version: number;
}

interface WorkflowReviewRow extends RowDataPacket {
  created_at: Date;
  decision: ManualDecision;
  display_name: string;
  id: string;
  reason: string | null;
}

interface WorkflowNoteRow extends RowDataPacket {
  body: string;
  created_at: Date;
  display_name: string;
  id: string;
}

interface WorkflowEventRow extends RowDataPacket {
  changed_fields_json: Record<string, unknown>;
  created_at: Date;
  display_name: string | null;
  event_type: string;
  id: string;
  next_status: string | null;
  note: string | null;
  previous_status: string | null;
}

const manualReviewSchema = z
  .object({
    actorRole: z.enum(['admin', 'operator', 'readonly']),
    actorUserId: z.uuid(),
    candidateId: z.uuid(),
    decision: z.enum(['pending', 'approved', 'rejected']),
    expectedVersion: z.number().int().positive(),
    reason: z.string().trim().min(1).max(2_000).nullable().optional(),
    workspaceId: z.uuid(),
  })
  .strict()
  .refine((input) => input.decision !== 'rejected' || Boolean(input.reason), {
    message: '标记不符合时必须填写理由',
    path: ['reason'],
  });

const outreachSchema = z
  .object({
    actorRole: z.enum(['admin', 'operator', 'readonly']),
    actorUserId: z.uuid(),
    candidateId: z.uuid(),
    contactChannel: z.string().trim().min(1).max(50).nullable().optional(),
    contactValue: z.string().trim().min(1).max(500).nullable().optional(),
    currency: z.string().trim().length(3).toUpperCase().nullable().optional(),
    expectedVersion: z.number().int().nonnegative(),
    nextAction: z.string().trim().min(1).max(500).nullable().optional(),
    nextFollowUpAt: z.coerce.date().nullable().optional(),
    ownerUserId: z.uuid().nullable().optional(),
    quotedAmount: z.number().nonnegative().max(999_999_999.99).nullable().optional(),
    workspaceId: z.uuid(),
  })
  .strict();

export class CandidateWorkflowNotFoundError extends Error {
  public constructor() {
    super('找不到候选或合作记录');
    this.name = 'CandidateWorkflowNotFoundError';
  }
}

export class CandidateVersionConflictError extends Error {
  public constructor(public readonly currentVersion: number) {
    super(`候选已被其他成员更新，当前版本为 ${currentVersion}`);
    this.name = 'CandidateVersionConflictError';
  }
}

export class OutreachVersionConflictError extends Error {
  public constructor(public readonly currentVersion: number) {
    super(`合作记录已被其他成员更新，当前版本为 ${currentVersion}`);
    this.name = 'OutreachVersionConflictError';
  }
}

export class InvalidPipelineTransitionError extends Error {
  public constructor(
    public readonly from: PipelineStatus,
    public readonly to: PipelineStatus,
  ) {
    super(`不允许从 ${from} 变更到 ${to}`);
    this.name = 'InvalidPipelineTransitionError';
  }
}

export function canTransitionPipeline(from: PipelineStatus, to: PipelineStatus): boolean {
  return allowedTransitions[from].includes(to);
}

export async function submitManualReview(pool: Pool, rawInput: unknown) {
  const input = manualReviewSchema.parse(rawInput);
  return withTransaction(pool, async (connection) => {
    const candidate = await lockCandidate(connection, input, input.candidateId);
    assertCandidateVersion(candidate, input.expectedVersion);
    const reviewId = randomUUID();
    await connection.execute(
      `INSERT INTO manual_reviews
       (id, workspace_id, candidate_id, reviewer_user_id, decision, reason,
        based_on_candidate_version)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        reviewId,
        input.workspaceId,
        input.candidateId,
        input.actorUserId,
        input.decision,
        input.reason ?? null,
        candidate.version,
      ],
    );
    await connection.execute(
      'UPDATE campaign_candidates SET version = version + 1 WHERE workspace_id = ? AND id = ?',
      [input.workspaceId, input.candidateId],
    );
    await appendCandidateEvent(connection, {
      actorUserId: input.actorUserId,
      candidateId: input.candidateId,
      changedFields: { decision: input.decision, reason: input.reason ?? null },
      eventType: 'manual_reviewed',
      workspaceId: input.workspaceId,
    });
    await writeAuditEvent(connection, {
      action: 'candidate.reviewed',
      actorUserId: input.actorUserId,
      subjectId: input.candidateId,
      subjectType: 'candidate',
      summary: { decision: input.decision },
      workspaceId: input.workspaceId,
    });
    return { id: reviewId, version: candidate.version + 1 };
  });
}

export async function transitionCandidatePipeline(
  pool: Pool,
  input: {
    actorRole: WorkspaceRole;
    actorUserId: string;
    candidateId: string;
    expectedVersion: number;
    nextStatus: PipelineStatus;
    note?: string;
    workspaceId: string;
  },
) {
  return withTransaction(pool, async (connection) => {
    const candidate = await lockCandidate(connection, input, input.candidateId);
    assertCandidateVersion(candidate, input.expectedVersion);
    if (!canTransitionPipeline(candidate.pipeline_status, input.nextStatus)) {
      throw new InvalidPipelineTransitionError(candidate.pipeline_status, input.nextStatus);
    }
    await connection.execute(
      `UPDATE campaign_candidates
       SET pipeline_status = ?, version = version + 1 WHERE workspace_id = ? AND id = ?`,
      [input.nextStatus, input.workspaceId, input.candidateId],
    );
    await appendCandidateEvent(connection, {
      actorUserId: input.actorUserId,
      candidateId: input.candidateId,
      changedFields: { pipelineStatus: input.nextStatus },
      eventType: 'pipeline_status_changed',
      nextStatus: input.nextStatus,
      ...(input.note ? { note: input.note } : {}),
      previousStatus: candidate.pipeline_status,
      workspaceId: input.workspaceId,
    });
    await writeAuditEvent(connection, {
      action: 'outreach.status_changed',
      actorUserId: input.actorUserId,
      subjectId: input.candidateId,
      subjectType: 'candidate',
      summary: { from: candidate.pipeline_status, to: input.nextStatus },
      workspaceId: input.workspaceId,
    });
    return { status: input.nextStatus, version: candidate.version + 1 };
  });
}

export async function updateCandidateOutreach(pool: Pool, rawInput: unknown) {
  const input = outreachSchema.parse(rawInput);
  return withTransaction(pool, async (connection) => {
    await lockCandidate(connection, input, input.candidateId);
    if (input.ownerUserId) {
      const [members] = await connection.query<RowDataPacket[]>(
        `SELECT memberships.user_id FROM memberships
         JOIN users ON users.id = memberships.user_id
         WHERE memberships.workspace_id = ? AND memberships.user_id = ?
           AND users.status = 'active' LIMIT 1`,
        [input.workspaceId, input.ownerUserId],
      );
      if (!members[0]) throw new CandidateWorkflowNotFoundError();
    }
    const existing = await lockOutreach(connection, input.workspaceId, input.candidateId);
    const currentVersion = existing?.version ?? 0;
    if (input.expectedVersion !== currentVersion) {
      throw new OutreachVersionConflictError(currentVersion);
    }
    const next = {
      contactChannel: valueOrCurrent(input.contactChannel, existing?.contact_channel),
      contactValue: valueOrCurrent(input.contactValue, existing?.contact_value),
      currency: valueOrCurrent(input.currency, existing?.currency),
      nextAction: valueOrCurrent(input.nextAction, existing?.next_action),
      nextFollowUpAt: valueOrCurrent(input.nextFollowUpAt, existing?.next_follow_up_at),
      ownerUserId: valueOrCurrent(input.ownerUserId, existing?.owner_user_id),
      quotedAmount: valueOrCurrent(input.quotedAmount, existing?.quoted_amount),
    };
    if (existing) {
      await connection.execute(
        `UPDATE outreach_records SET
         owner_assigned_at = CASE
           WHEN ? IS NULL THEN NULL
           WHEN NOT (owner_user_id <=> ?) THEN CURRENT_TIMESTAMP(3)
           ELSE owner_assigned_at
         END,
         owner_user_id = ?, contact_channel = ?, contact_value = ?,
         quoted_amount = ?, currency = ?, next_follow_up_at = ?, next_action = ?, version = version + 1
         WHERE workspace_id = ? AND candidate_id = ?`,
        [
          next.ownerUserId,
          next.ownerUserId,
          next.ownerUserId,
          next.contactChannel,
          next.contactValue,
          next.quotedAmount,
          next.currency,
          next.nextFollowUpAt,
          next.nextAction,
          input.workspaceId,
          input.candidateId,
        ],
      );
    } else {
      await connection.execute(
        `INSERT INTO outreach_records
         (id, workspace_id, candidate_id, owner_user_id, owner_assigned_at,
          contact_channel, contact_value,
          quoted_amount, currency, next_follow_up_at, next_action)
         VALUES (?, ?, ?, ?, CASE WHEN ? IS NULL THEN NULL ELSE CURRENT_TIMESTAMP(3) END,
                 ?, ?, ?, ?, ?, ?)`,
        [
          randomUUID(),
          input.workspaceId,
          input.candidateId,
          next.ownerUserId,
          next.ownerUserId,
          next.contactChannel,
          next.contactValue,
          next.quotedAmount,
          next.currency,
          next.nextFollowUpAt,
          next.nextAction,
        ],
      );
    }
    const changedFields = Object.keys(input).filter(
      (key) => !['workspaceId', 'actorUserId', 'candidateId', 'expectedVersion'].includes(key),
    );
    await appendCandidateEvent(connection, {
      actorUserId: input.actorUserId,
      candidateId: input.candidateId,
      changedFields: { fields: changedFields },
      eventType: 'outreach_updated',
      workspaceId: input.workspaceId,
    });
    await writeAuditEvent(connection, {
      action: 'outreach.status_changed',
      actorUserId: input.actorUserId,
      subjectId: input.candidateId,
      subjectType: 'candidate',
      summary: { fields: changedFields, operation: 'outreach_updated' },
      workspaceId: input.workspaceId,
    });
    return { version: currentVersion + 1 };
  });
}

export async function appendCandidateNote(
  pool: Pool,
  input: {
    actorRole: WorkspaceRole;
    actorUserId: string;
    body: string;
    candidateId: string;
    workspaceId: string;
  },
) {
  const parsed = z
    .object({
      actorRole: z.enum(['admin', 'operator', 'readonly']),
      actorUserId: z.uuid(),
      body: z.string().trim().min(1).max(5_000),
      candidateId: z.uuid(),
      workspaceId: z.uuid(),
    })
    .strict()
    .parse(input);
  await lockCandidate(pool, parsed, parsed.candidateId);
  const id = randomUUID();
  await pool.execute(
    `INSERT INTO candidate_notes (id, workspace_id, candidate_id, author_user_id, body)
     VALUES (?, ?, ?, ?, ?)`,
    [id, parsed.workspaceId, parsed.candidateId, parsed.actorUserId, parsed.body],
  );
  await appendCandidateEvent(pool, {
    actorUserId: parsed.actorUserId,
    candidateId: parsed.candidateId,
    changedFields: { noteId: id },
    eventType: 'note_added',
    workspaceId: parsed.workspaceId,
  });
  await writeAuditEvent(pool, {
    action: 'outreach.status_changed',
    actorUserId: parsed.actorUserId,
    subjectId: parsed.candidateId,
    subjectType: 'candidate',
    summary: { noteId: id, operation: 'note_added' },
    workspaceId: parsed.workspaceId,
  });
  return { id };
}

export async function getCandidateWorkflow(
  pool: Pool,
  access: CandidateAccessContext,
  candidateId: string,
) {
  const candidate = await lockCandidate(pool, access, candidateId);
  const [reviews] = await pool.query<WorkflowReviewRow[]>(
    `SELECT reviews.id, reviews.decision, reviews.reason, reviews.created_at, users.display_name
     FROM manual_reviews reviews JOIN users ON users.id = reviews.reviewer_user_id
     WHERE reviews.workspace_id = ? AND reviews.candidate_id = ?
     ORDER BY reviews.created_at DESC, reviews.id DESC`,
    [access.workspaceId, candidateId],
  );
  const [outreachRows] = await pool.query<OutreachRow[]>(
    `SELECT outreach.id, outreach.owner_user_id, outreach.contact_channel,
            outreach.contact_value, outreach.quoted_amount, outreach.currency,
            outreach.next_follow_up_at, outreach.next_action, outreach.cooperation_notes,
            outreach.owner_assigned_at,
            outreach.version, users.display_name AS owner_name
     FROM outreach_records outreach LEFT JOIN users ON users.id = outreach.owner_user_id
     WHERE outreach.workspace_id = ? AND outreach.candidate_id = ? LIMIT 1`,
    [access.workspaceId, candidateId],
  );
  const [notes] = await pool.query<WorkflowNoteRow[]>(
    `SELECT notes.id, notes.body, notes.created_at, users.display_name
     FROM candidate_notes notes JOIN users ON users.id = notes.author_user_id
     WHERE notes.workspace_id = ? AND notes.candidate_id = ?
     ORDER BY notes.created_at DESC, notes.id DESC`,
    [access.workspaceId, candidateId],
  );
  const [events] = await pool.query<WorkflowEventRow[]>(
    `SELECT events.id, events.event_type, events.previous_status, events.next_status,
            events.changed_fields_json, events.note, events.created_at, users.display_name
     FROM candidate_events events LEFT JOIN users ON users.id = events.actor_user_id
     WHERE events.workspace_id = ? AND events.candidate_id = ?
     ORDER BY events.created_at DESC, events.id DESC LIMIT 100`,
    [access.workspaceId, candidateId],
  );
  const outreach = outreachRows[0];
  return {
    candidateVersion: candidate.version,
    events: events.map((event) => ({
      changedFields: event.changed_fields_json,
      createdAt: event.created_at,
      eventType: event.event_type,
      id: event.id,
      nextStatus: event.next_status,
      note: event.note,
      previousStatus: event.previous_status,
      actorDisplayName: event.display_name,
    })),
    notes: notes.map((note) => ({
      authorDisplayName: note.display_name,
      body: note.body,
      createdAt: note.created_at,
      id: note.id,
    })),
    outreach: outreach
      ? {
          contactChannel: outreach.contact_channel,
          contactValue: outreach.contact_value,
          currency: outreach.currency,
          nextAction: outreach.next_action,
          nextFollowUpAt: outreach.next_follow_up_at,
          ownerUserId: outreach.owner_user_id,
          ownerAssignedAt: outreach.owner_assigned_at,
          ownerDisplayName: outreach.owner_name,
          quotedAmount: outreach.quoted_amount === null ? null : Number(outreach.quoted_amount),
          version: outreach.version,
        }
      : null,
    pipelineStatus: candidate.pipeline_status,
    reviews: reviews.map((review) => ({
      createdAt: review.created_at,
      decision: review.decision,
      id: review.id,
      reason: review.reason,
      reviewerDisplayName: review.display_name,
    })),
  };
}

async function lockCandidate(
  executor: Pool | PoolConnection,
  access: CandidateAccessContext,
  candidateId: string,
) {
  const scope = resolveCandidateScope(access);
  const visibility = candidateVisibilityPredicate('candidates', scope.targetUserId);
  const [rows] = await executor.query<CandidateRow[]>(
    `SELECT version, pipeline_status FROM campaign_candidates
     AS candidates
     WHERE candidates.workspace_id = ? AND candidates.id = ? AND ${visibility.sql}
     LIMIT 1${'getConnection' in executor ? '' : ' FOR UPDATE'}`,
    [access.workspaceId, candidateId, ...visibility.parameters],
  );
  if (!rows[0]) throw new CandidateWorkflowNotFoundError();
  return rows[0];
}

async function lockOutreach(connection: PoolConnection, workspaceId: string, candidateId: string) {
  const [rows] = await connection.query<OutreachRow[]>(
    `SELECT id, owner_user_id, owner_assigned_at, NULL AS owner_name, contact_channel, contact_value,
            quoted_amount, currency, next_follow_up_at, next_action, cooperation_notes, version
     FROM outreach_records WHERE workspace_id = ? AND candidate_id = ? LIMIT 1 FOR UPDATE`,
    [workspaceId, candidateId],
  );
  return rows[0];
}

function assertCandidateVersion(candidate: CandidateRow, expectedVersion: number) {
  if (candidate.version !== expectedVersion) {
    throw new CandidateVersionConflictError(candidate.version);
  }
}

async function appendCandidateEvent(
  executor: Pick<Pool | PoolConnection, 'execute'>,
  input: {
    actorUserId: string;
    candidateId: string;
    changedFields: Record<string, unknown>;
    eventType: string;
    nextStatus?: string;
    note?: string;
    previousStatus?: string;
    workspaceId: string;
  },
) {
  await executor.execute(
    `INSERT INTO candidate_events
     (id, workspace_id, candidate_id, actor_user_id, event_type, previous_status,
      next_status, changed_fields_json, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      randomUUID(),
      input.workspaceId,
      input.candidateId,
      input.actorUserId,
      input.eventType,
      input.previousStatus ?? null,
      input.nextStatus ?? null,
      JSON.stringify(input.changedFields),
      input.note ?? null,
    ],
  );
}

function valueOrCurrent<T>(value: T | undefined, current: T | null | undefined): T | null {
  return value === undefined ? (current ?? null) : value;
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
