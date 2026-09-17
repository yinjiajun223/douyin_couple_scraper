import type { Pool, RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMysqlPool, runMigrations } from '../database/migrations.js';
import { seedInitialWorkspace } from '../database/seed.js';
import {
  claimBackgroundJob,
  completeBackgroundJob,
  enqueueBackgroundJob,
  failBackgroundJob,
} from './job-queue.js';

const databaseUrl = process.env.MYSQL_TEST_URL;
const describeWithMysql = databaseUrl ? describe : describe.skip;

describeWithMysql('MySQL background job queue', () => {
  const workspaceId = '6a000000-0000-4000-8000-000000000001';
  let pool: Pool;

  beforeAll(async () => {
    pool = createMysqlPool(databaseUrl!);
    await runMigrations(pool);
    await seedInitialWorkspace(pool, {
      workspaceId,
      workspaceName: '后台任务测试',
      workspaceSlug: 'job-queue-test',
    });
  });

  afterAll(async () => pool.end());

  it('deduplicates enqueue and lets another worker recover an expired lease', async () => {
    const runAt = new Date('2026-09-15T10:00:00.000Z');
    const input = {
      deduplicationKey: 'candidate:lease-test:v1',
      jobType: 'lease-recovery-test',
      payload: { candidateId: 'lease-test' },
      runAt,
      workspaceId,
    };
    const first = await enqueueBackgroundJob(pool, input);
    const duplicate = await enqueueBackgroundJob(pool, input);
    expect(first.created).toBe(true);
    expect(duplicate).toEqual({ created: false, id: first.id });

    const abandoned = await claimBackgroundJob(pool, 'worker-a', {
      leaseMs: 1_000,
      now: runAt,
      jobTypes: ['lease-recovery-test'],
    });
    expect(abandoned?.id).toBe(first.id);
    const recovered = await claimBackgroundJob(pool, 'worker-b', {
      leaseMs: 1_000,
      now: new Date(runAt.getTime() + 1_001),
      jobTypes: ['lease-recovery-test'],
    });
    expect(recovered).toMatchObject({ attemptCount: 2, id: first.id, leaseOwner: 'worker-b' });
    await completeBackgroundJob(pool, recovered!.id, 'worker-b', { analysisId: 'done' });
  });

  it('allows only one of two competing workers to claim a job and dead-letters after retries', async () => {
    const now = new Date('2026-09-15T11:00:00.000Z');
    const queued = await enqueueBackgroundJob(pool, {
      deduplicationKey: 'candidate:compete:v1',
      jobType: 'worker-competition-test',
      maxAttempts: 1,
      payload: { candidateId: 'compete' },
      runAt: now,
      workspaceId,
    });
    const claims = await Promise.all([
      claimBackgroundJob(pool, 'worker-c', { jobTypes: ['worker-competition-test'], now }),
      claimBackgroundJob(pool, 'worker-d', { jobTypes: ['worker-competition-test'], now }),
    ]);
    const winners = claims.filter((claim) => claim?.id === queued.id);
    expect(winners).toHaveLength(1);
    expect(
      await failBackgroundJob(
        pool,
        winners[0]!,
        { code: 'RATE_LIMIT', message: 'retry later' },
        now,
      ),
    ).toBe('dead');
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT status, dead_lettered_at FROM background_jobs WHERE id = ?',
      [queued.id],
    );
    expect(rows[0]).toMatchObject({ status: 'dead' });
    expect(rows[0]?.dead_lettered_at).toBeInstanceOf(Date);
  });
});
