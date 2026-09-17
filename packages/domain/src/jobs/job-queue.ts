import { randomUUID } from 'node:crypto';

import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';

const enqueueSchema = z
  .object({
    deduplicationKey: z.string().min(1).max(255).optional(),
    jobType: z.string().min(1).max(100),
    maxAttempts: z.number().int().min(1).max(100).default(5),
    payload: z.record(z.string(), z.unknown()),
    priority: z.number().int().min(0).max(65_535).default(100),
    runAt: z.date().default(() => new Date()),
    workspaceId: z.uuid(),
  })
  .strict();

interface JobRow extends RowDataPacket {
  attempt_count: number;
  deduplication_key: string | null;
  id: string;
  job_type: string;
  lease_expires_at: Date | null;
  lease_owner: string | null;
  max_attempts: number;
  payload_json: Record<string, unknown>;
  priority: number;
  run_at: Date;
  status: JobStatus;
  workspace_id: string;
}

export type JobStatus = 'ready' | 'leased' | 'succeeded' | 'retry' | 'failed' | 'dead';

export interface BackgroundJob {
  attemptCount: number;
  deduplicationKey: string | null;
  id: string;
  jobType: string;
  leaseExpiresAt: Date;
  leaseOwner: string;
  maxAttempts: number;
  payload: Record<string, unknown>;
  priority: number;
  runAt: Date;
  workspaceId: string;
}

export class JobLeaseConflictError extends Error {
  public constructor() {
    super('Background job lease is no longer owned by this worker.');
    this.name = 'JobLeaseConflictError';
  }
}

export async function enqueueBackgroundJob(pool: Pool, rawInput: unknown) {
  const input = enqueueSchema.parse(rawInput);
  const id = randomUUID();
  try {
    await pool.execute(
      `INSERT INTO background_jobs
       (id, workspace_id, job_type, deduplication_key, payload_json,
        priority, run_at, max_attempts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.workspaceId,
        input.jobType,
        input.deduplicationKey ?? null,
        JSON.stringify(input.payload),
        input.priority,
        input.runAt,
        input.maxAttempts,
      ],
    );
    return { created: true, id };
  } catch (error) {
    if (!input.deduplicationKey || !isDuplicateEntry(error)) throw error;
    const [rows] = await pool.query<JobRow[]>(
      `SELECT ${jobColumns} FROM background_jobs
       WHERE workspace_id = ? AND job_type = ? AND deduplication_key = ? LIMIT 1`,
      [input.workspaceId, input.jobType, input.deduplicationKey],
    );
    if (!rows[0]) throw error;
    return { created: false, id: rows[0].id };
  }
}

export async function claimBackgroundJob(
  pool: Pool,
  workerId: string,
  options: { jobTypes?: string[]; leaseMs?: number; now?: Date } = {},
): Promise<BackgroundJob | null> {
  const leaseMs = options.leaseMs ?? 60_000;
  const now = options.now ?? new Date();
  if (!workerId || leaseMs < 1_000 || leaseMs > 3_600_000) {
    throw new RangeError('Invalid worker lease configuration.');
  }
  return withTransaction(pool, async (connection) => {
    await connection.execute(
      `UPDATE background_jobs
       SET status = 'dead', lease_owner = NULL, lease_expires_at = NULL,
           dead_lettered_at = ?, last_error_code = 'LEASE_EXHAUSTED',
           last_error_message = 'Worker lease expired after maximum attempts.'
       WHERE status = 'leased' AND lease_expires_at <= ? AND attempt_count >= max_attempts`,
      [now, now],
    );
    const typeFilter = options.jobTypes?.length
      ? ` AND job_type IN (${options.jobTypes.map(() => '?').join(', ')})`
      : '';
    const [rows] = await connection.query<JobRow[]>(
      `SELECT ${jobColumns} FROM background_jobs
       WHERE attempt_count < max_attempts
         AND ((status IN ('ready', 'retry') AND run_at <= ?)
           OR (status = 'leased' AND lease_expires_at <= ?))${typeFilter}
       ORDER BY priority ASC, run_at ASC, id ASC
       LIMIT 1 FOR UPDATE SKIP LOCKED`,
      [now, now, ...(options.jobTypes ?? [])],
    );
    const row = rows[0];
    if (!row) return null;
    const leaseExpiresAt = new Date(now.getTime() + leaseMs);
    await connection.execute(
      `UPDATE background_jobs
       SET status = 'leased', lease_owner = ?, lease_expires_at = ?,
           attempt_count = attempt_count + 1, updated_at = CURRENT_TIMESTAMP(3)
       WHERE id = ?`,
      [workerId, leaseExpiresAt, row.id],
    );
    return {
      attemptCount: row.attempt_count + 1,
      deduplicationKey: row.deduplication_key,
      id: row.id,
      jobType: row.job_type,
      leaseExpiresAt,
      leaseOwner: workerId,
      maxAttempts: row.max_attempts,
      payload: row.payload_json,
      priority: row.priority,
      runAt: row.run_at,
      workspaceId: row.workspace_id,
    };
  });
}

export async function completeBackgroundJob(
  pool: Pool,
  jobId: string,
  workerId: string,
  result: Record<string, unknown>,
): Promise<void> {
  const [update] = await pool.execute<import('mysql2/promise').ResultSetHeader>(
    `UPDATE background_jobs
     SET status = 'succeeded', result_json = ?, lease_owner = NULL,
         lease_expires_at = NULL, completed_at = CURRENT_TIMESTAMP(3)
     WHERE id = ? AND status = 'leased' AND lease_owner = ?`,
    [JSON.stringify(result), jobId, workerId],
  );
  if (update.affectedRows !== 1) throw new JobLeaseConflictError();
}

export async function failBackgroundJob(
  pool: Pool,
  job: Pick<BackgroundJob, 'attemptCount' | 'id' | 'leaseOwner' | 'maxAttempts'>,
  error: { code: string; message: string },
  now = new Date(),
): Promise<'retry' | 'dead'> {
  const dead = job.attemptCount >= job.maxAttempts;
  const retryAt = new Date(now.getTime() + retryDelayMs(job.attemptCount));
  const [update] = await pool.execute<import('mysql2/promise').ResultSetHeader>(
    `UPDATE background_jobs
     SET status = ?, run_at = ?, lease_owner = NULL, lease_expires_at = NULL,
         last_error_code = ?, last_error_message = ?,
         dead_lettered_at = ?, updated_at = CURRENT_TIMESTAMP(3)
     WHERE id = ? AND status = 'leased' AND lease_owner = ?`,
    [
      dead ? 'dead' : 'retry',
      dead ? now : retryAt,
      error.code.slice(0, 100),
      error.message.slice(0, 2_000),
      dead ? now : null,
      job.id,
      job.leaseOwner,
    ],
  );
  if (update.affectedRows !== 1) throw new JobLeaseConflictError();
  return dead ? 'dead' : 'retry';
}

export function retryDelayMs(attemptCount: number): number {
  return Math.min(15 * 60_000, 5_000 * 2 ** Math.max(0, attemptCount - 1));
}

function isDuplicateEntry(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && error.code === 'ER_DUP_ENTRY'
  );
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

const jobColumns = `id, workspace_id, job_type, deduplication_key, payload_json,
  status, priority, run_at, lease_owner, lease_expires_at, attempt_count, max_attempts`;
