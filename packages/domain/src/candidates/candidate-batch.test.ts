import type { Pool, PoolConnection } from 'mysql2/promise';
import { describe, expect, it } from 'vitest';

import {
  batchArchiveCandidates,
  batchSubmitManualReview,
  BATCH_OPERATION_LIMIT,
} from './candidate-batch.js';

const workspaceId = '9a000000-0000-4000-8000-000000000001';
const actorUserId = '9a000000-0000-4000-8000-000000000002';
const adminAccess = { actorRole: 'admin' as const, actorUserId, workspaceId };

const candidateIds = {
  blocked: '9a000000-0000-4000-8000-000000000011',
  ok: '9a000000-0000-4000-8000-000000000012',
  stale: '9a000000-0000-4000-8000-000000000013',
};

/**
 * 假连接：`lockCandidate` 的 SELECT 由 `lockedRows` 决定，其余写入语句一律放行。
 * 这样可以在不启动 MySQL 的前提下验证批量的上限、顺序与逐项结果结构。
 */
function fakePool(lockedRows: (candidateId: string) => Array<Record<string, unknown>>) {
  const lockedOrder: string[] = [];
  const connection = {
    beginTransaction: async () => undefined,
    commit: async () => undefined,
    execute: async () => [{ affectedRows: 1 }],
    query: async (_sql: string, parameters: unknown[] = []) => {
      const candidateId = String(parameters[1]);
      lockedOrder.push(candidateId);
      return [lockedRows(candidateId)];
    },
    release: () => undefined,
    rollback: async () => undefined,
  };
  const pool = { getConnection: async () => connection as unknown as PoolConnection };
  return { lockedOrder, pool: pool as unknown as Pool };
}

const items = (entries: ReadonlyArray<[string, number]>) =>
  entries.map(([candidateId, expectedVersion]) => ({ candidateId, expectedVersion }));

describe('候选批量操作', () => {
  it('超过上限的批量请求在校验阶段被拒绝，不触达数据库', async () => {
    const pool = {
      getConnection: () => {
        throw new Error('超限请求不应触达数据库');
      },
    } as unknown as Pool;
    const tooMany = items(
      Array.from({ length: BATCH_OPERATION_LIMIT + 1 }, (_, index) => [
        `9a000000-0000-4000-8000-000000${String(index).padStart(3, '0')}`,
        1,
      ]),
    );

    const review = await batchSubmitManualReview(pool, {
      ...adminAccess,
      decision: 'approved',
      items: tooMany,
    }).catch((error: Error) => error.name);
    expect(review).toBe('ZodError');

    const archive = await batchArchiveCandidates(pool, { ...adminAccess, items: tooMany }).catch(
      (error: Error) => error.name,
    );
    expect(archive).toBe('ZodError');
  });

  it('空批次与重复候选都在校验阶段被拒绝', async () => {
    const { pool } = fakePool(() => [{ pipeline_status: 'pending_review', version: 1 }]);

    for (const badItems of [
      [],
      items([
        [candidateIds.ok, 1],
        [candidateIds.ok, 1],
      ]),
    ]) {
      await expect(
        batchSubmitManualReview(pool, { ...adminAccess, decision: 'approved', items: badItems }),
      ).rejects.toMatchObject({ name: 'ZodError' });
      await expect(
        batchArchiveCandidates(pool, { ...adminAccess, items: badItems }),
      ).rejects.toMatchObject({ name: 'ZodError' });
    }
  });

  it('按输入顺序逐条执行，并对每条返回独立结果', async () => {
    const { lockedOrder, pool } = fakePool((candidateId) =>
      candidateId === candidateIds.blocked
        ? []
        : candidateId === candidateIds.stale
          ? [{ pipeline_status: 'pending_review', version: 7 }]
          : [{ pipeline_status: 'pending_review', version: 1 }],
    );
    const ordered = [candidateIds.ok, candidateIds.blocked, candidateIds.stale];

    const reviewed = await batchSubmitManualReview(pool, {
      ...adminAccess,
      decision: 'approved',
      items: items(ordered.map((id) => [id, 1])),
    });

    expect(lockedOrder).toEqual(ordered);
    expect(reviewed.succeeded).toBe(1);
    expect(reviewed.failed).toBe(2);
    expect(reviewed.results).toEqual([
      { id: candidateIds.ok, ok: true },
      { code: 'CANDIDATE_NOT_FOUND', id: candidateIds.blocked, ok: false },
      {
        code: 'VERSION_CONFLICT',
        currentVersion: 7,
        id: candidateIds.stale,
        ok: false,
      },
    ]);

    const archived = await batchArchiveCandidates(pool, {
      ...adminAccess,
      items: items(ordered.map((id) => [id, 1])),
      note: '重复达人',
    });
    // 归档走同一条逐项路径：失败项各自独立，成功项不因同批有其他失败而回滚。
    expect(archived.results.map((result) => result.ok)).toEqual([true, false, false]);
    expect(archived.succeeded).toBe(1);
    expect(archived.failed).toBe(2);
  });
});
