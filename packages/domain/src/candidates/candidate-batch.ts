import type { Pool } from 'mysql2/promise';
import { z } from 'zod';

import { PermissionDeniedError } from '../auth/permissions.js';
import { CandidateAccessDeniedError } from './candidate-access.js';
import { CandidateNotFoundError } from './candidate-library.js';
import {
  archiveCandidate,
  CandidateVersionConflictError,
  CandidateWorkflowNotFoundError,
  InvalidPipelineTransitionError,
  submitManualReview,
} from './candidate-workflow.js';

// 上限是网关超时与连接池的折中：批量项顺序执行、各自开一个事务，
// 100 条实测约 1 秒级（见 tasks.md 4.6 的实测记录）。超限时下调这个数字，不要改成并发。
export const BATCH_OPERATION_LIMIT = 100;

export type BatchItemFailureCode =
  | 'CANDIDATE_NOT_FOUND'
  | 'INVALID_INPUT'
  | 'INVALID_PIPELINE_TRANSITION'
  | 'PERMISSION_DENIED'
  | 'VERSION_CONFLICT';

export interface BatchItemResult {
  code?: BatchItemFailureCode;
  currentVersion?: number;
  from?: string;
  id: string;
  to?: string;
  ok: boolean;
}

export interface BatchResult {
  failed: number;
  results: BatchItemResult[];
  succeeded: number;
}

const batchTargetSchema = z
  .object({
    candidateId: z.uuid(),
    expectedVersion: z.number().int().positive(),
  })
  .strict();

// 同一批里重复出现同一个候选没有意义：第一次已经递增版本，第二次只会变成版本冲突，
// 因此在校验阶段就拒绝，让调用方看到「重复提交」而不是误判成并发修改。
const batchTargetsSchema = z
  .array(batchTargetSchema)
  .min(1)
  .max(BATCH_OPERATION_LIMIT)
  .refine(
    (targets) => new Set(targets.map((target) => target.candidateId)).size === targets.length,
    { message: '同一批次不能重复包含同一个候选', path: ['items'] },
  );

const batchReviewSchema = z
  .object({
    actorRole: z.enum(['admin', 'operator', 'readonly']),
    actorUserId: z.uuid(),
    decision: z.enum(['pending', 'approved', 'rejected']),
    items: batchTargetsSchema,
    reason: z.string().trim().min(1).max(2_000).nullable().optional(),
    workspaceId: z.uuid(),
  })
  .strict();

const batchArchiveSchema = z
  .object({
    actorRole: z.enum(['admin', 'operator', 'readonly']),
    actorUserId: z.uuid(),
    items: batchTargetsSchema,
    note: z.string().trim().min(1).max(500).nullable().optional(),
    workspaceId: z.uuid(),
  })
  .strict();

/**
 * 批量人工复核：逐条复用 `submitManualReview`，语义与单条完全一致
 * （仅从 `pending_review` 自动推进、单次版本递增、事件与审计各一条）。
 *
 * 顺序执行且每条各自开事务：部分成功是预期语义，失败项不影响已提交项。
 * 非预期错误（数据库不可用等）直接抛出，此时已提交的项不会回滚。
 */
export async function batchSubmitManualReview(pool: Pool, rawInput: unknown): Promise<BatchResult> {
  const input = batchReviewSchema.parse(rawInput);
  return runBatch(input.items, async (target) =>
    submitManualReview(pool, {
      actorRole: input.actorRole,
      actorUserId: input.actorUserId,
      candidateId: target.candidateId,
      decision: input.decision,
      expectedVersion: target.expectedVersion,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      workspaceId: input.workspaceId,
    }),
  );
}

/** 批量归档：逐条复用 `archiveCandidate`，失败项保持原样。 */
export async function batchArchiveCandidates(pool: Pool, rawInput: unknown): Promise<BatchResult> {
  const input = batchArchiveSchema.parse(rawInput);
  return runBatch(input.items, async (target) =>
    archiveCandidate(pool, {
      actorRole: input.actorRole,
      actorUserId: input.actorUserId,
      candidateId: target.candidateId,
      expectedVersion: target.expectedVersion,
      ...(input.note === undefined ? {} : { note: input.note }),
      workspaceId: input.workspaceId,
    }),
  );
}

async function runBatch(
  targets: ReadonlyArray<{ candidateId: string; expectedVersion: number }>,
  operate: (target: { candidateId: string; expectedVersion: number }) => Promise<unknown>,
): Promise<BatchResult> {
  const results: BatchItemResult[] = [];
  // 顺序 await，不用 Promise.all：并发会一次性占满连接池，而每项都要独占一个连接开事务。
  for (const target of targets) {
    try {
      await operate(target);
      results.push({ id: target.candidateId, ok: true });
    } catch (error) {
      results.push(toFailure(target.candidateId, error));
    }
  }
  return {
    failed: results.filter((result) => !result.ok).length,
    results,
    succeeded: results.filter((result) => result.ok).length,
  };
}

function toFailure(id: string, error: unknown): BatchItemResult {
  if (error instanceof CandidateVersionConflictError) {
    return { code: 'VERSION_CONFLICT', currentVersion: error.currentVersion, id, ok: false };
  }
  if (error instanceof InvalidPipelineTransitionError) {
    return { code: 'INVALID_PIPELINE_TRANSITION', from: error.from, id, ok: false, to: error.to };
  }
  if (error instanceof PermissionDeniedError) {
    return { code: 'PERMISSION_DENIED', id, ok: false };
  }
  // 越权与不存在返回同一个码：与单条候选路由一致，不向调用方泄露「这条确实存在」。
  if (
    error instanceof CandidateWorkflowNotFoundError ||
    error instanceof CandidateNotFoundError ||
    error instanceof CandidateAccessDeniedError
  ) {
    return { code: 'CANDIDATE_NOT_FOUND', id, ok: false };
  }
  if (error instanceof Error && error.name === 'ZodError') {
    return { code: 'INVALID_INPUT', id, ok: false };
  }
  throw error;
}
