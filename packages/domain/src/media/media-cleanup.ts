import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

import type { ObjectStorageClient } from './object-storage.js';

export const DEFAULT_MEDIA_RETENTION_DAYS = 180;
export const DEFAULT_MEDIA_CLEANUP_BATCH_SIZE = 100;
export const DEFAULT_ORPHAN_MEDIA_GRACE_DAYS = 7;

interface CleanupMediaRow extends RowDataPacket {
  id: string;
  object_key: string;
  status: 'confirmed' | 'expired' | 'pending';
}

export interface MediaCleanupOptions {
  batchSize?: number;
  now?: Date;
  orphanCleanupEnabled?: boolean;
  orphanGraceDays?: number;
  retentionDays?: number;
  workspaceId?: string;
}

export interface MediaCleanupSummary {
  deletedConfirmed: number;
  deletedOrphans: number;
  deletedUnconfirmed: number;
  failed: number;
  preservedReferenced: number;
}

export async function cleanupMediaObjects(
  pool: Pool,
  storage: ObjectStorageClient,
  options: MediaCleanupOptions = {},
): Promise<MediaCleanupSummary> {
  const now = options.now ?? new Date();
  const retentionDays = options.retentionDays ?? DEFAULT_MEDIA_RETENTION_DAYS;
  const orphanGraceDays = options.orphanGraceDays ?? DEFAULT_ORPHAN_MEDIA_GRACE_DAYS;
  const batchSize = options.batchSize ?? DEFAULT_MEDIA_CLEANUP_BATCH_SIZE;
  const workspaceId = options.workspaceId ?? null;
  assertCleanupOptions(retentionDays, orphanGraceDays, batchSize);
  const retentionCutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1_000);
  const orphanCutoff = new Date(now.getTime() - orphanGraceDays * 24 * 60 * 60 * 1_000);

  const [unconfirmedRows] = await pool.query<CleanupMediaRow[]>(
    `SELECT id, object_key, status
     FROM media_objects
     WHERE ((status = 'pending' AND expires_at <= ?) OR status = 'expired')
       AND (? IS NULL OR workspace_id = ?)
     ORDER BY created_at
     LIMIT ?`,
    [now, workspaceId, workspaceId, batchSize],
  );
  const unconfirmedResult = await deleteRows(pool, storage, unconfirmedRows, now);

  const [oldConfirmedCountRows] = await pool.query<(RowDataPacket & { total: number })[]>(
    `SELECT COUNT(*) AS total
     FROM media_objects
     WHERE status = 'confirmed' AND confirmed_at <= ?
       AND (? IS NULL OR workspace_id = ?)`,
    [retentionCutoff, workspaceId, workspaceId],
  );
  const [retentionRows] = await pool.query<CleanupMediaRow[]>(
    `SELECT media.id, media.object_key, media.status
     FROM media_objects media
     LEFT JOIN creator_observations creator
       ON creator.workspace_id = media.workspace_id
      AND creator.id = media.creator_observation_id
     LEFT JOIN post_observations post
       ON post.workspace_id = media.workspace_id
      AND post.id = media.post_observation_id
     LEFT JOIN collection_runs run
       ON run.workspace_id = media.workspace_id
      AND run.id = COALESCE(creator.run_id, post.run_id)
     LEFT JOIN campaigns campaign
       ON campaign.workspace_id = media.workspace_id
      AND campaign.id = run.campaign_id
     WHERE media.status = 'confirmed'
       AND media.confirmed_at <= ?
       AND (? IS NULL OR media.workspace_id = ?)
       AND (campaign.id IS NULL OR campaign.status = 'archived')
     ORDER BY media.confirmed_at
     LIMIT ?`,
    [retentionCutoff, workspaceId, workspaceId, batchSize],
  );
  const retentionResult = await deleteRows(pool, storage, retentionRows, now);

  // 孤儿路径排在留存路径之后：被留存路径 claim 过的行状态已不是 confirmed，
  // 下面的查询天然取不到，两条路径不会重复 claim 同一个对象。
  const orphanRows = options.orphanCleanupEnabled
    ? await selectOrphanRows(pool, orphanCutoff, workspaceId, batchSize)
    : [];
  const orphanResult = await deleteRows(pool, storage, orphanRows, now);

  return {
    deletedConfirmed: retentionResult.deleted,
    deletedOrphans: orphanResult.deleted,
    deletedUnconfirmed: unconfirmedResult.deleted,
    failed: unconfirmedResult.failed + retentionResult.failed + orphanResult.failed,
    preservedReferenced: Math.max(
      0,
      Number(oldConfirmedCountRows[0]?.total ?? 0) - retentionRows.length,
    ),
  };
}

// 入库闸门之后，硬筛未通过的达人不再有 campaign_candidates 行，其截图没有业务消费者。
// 判据只有这一条，且删除不可逆，因此 creator_observation_id 为空、无法判定归属的素材
// 一律不回收。
async function selectOrphanRows(
  pool: Pool,
  orphanCutoff: Date,
  workspaceId: string | null,
  batchSize: number,
): Promise<CleanupMediaRow[]> {
  const [rows] = await pool.query<CleanupMediaRow[]>(
    `SELECT media.id, media.object_key, media.status
     FROM media_objects media
     JOIN creator_observations creator
       ON creator.workspace_id = media.workspace_id
      AND creator.id = media.creator_observation_id
     WHERE media.status = 'confirmed'
       AND media.confirmed_at <= ?
       AND (? IS NULL OR media.workspace_id = ?)
       AND NOT EXISTS (
         SELECT 1
         FROM campaign_candidates candidates
         WHERE candidates.workspace_id = media.workspace_id
           AND candidates.creator_id = creator.creator_id
       )
     ORDER BY media.confirmed_at
     LIMIT ?`,
    [orphanCutoff, workspaceId, workspaceId, batchSize],
  );
  return rows;
}

async function deleteRows(
  pool: Pool,
  storage: ObjectStorageClient,
  rows: CleanupMediaRow[],
  now: Date,
): Promise<{ deleted: number; failed: number }> {
  let deleted = 0;
  let failed = 0;

  for (const row of rows) {
    if (row.status !== 'expired') {
      const [claimResult] = await pool.execute<ResultSetHeader>(
        `UPDATE media_objects SET status = 'expired', expires_at = ?
         WHERE id = ? AND status = ?`,
        [now, row.id, row.status],
      );
      if (claimResult.affectedRows !== 1) continue;
    }

    try {
      await storage.deleteObject(row.object_key);
      const [deleteResult] = await pool.execute<ResultSetHeader>(
        `UPDATE media_objects SET status = 'deleted'
         WHERE id = ? AND status = 'expired'`,
        [row.id],
      );
      if (deleteResult.affectedRows === 1) deleted += 1;
    } catch {
      failed += 1;
    }
  }

  return { deleted, failed };
}

function assertCleanupOptions(
  retentionDays: number,
  orphanGraceDays: number,
  batchSize: number,
): void {
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3_650) {
    throw new RangeError('retentionDays must be an integer from 1 to 3650.');
  }
  if (!Number.isInteger(orphanGraceDays) || orphanGraceDays < 1 || orphanGraceDays > 3_650) {
    throw new RangeError('orphanGraceDays must be an integer from 1 to 3650.');
  }
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) {
    throw new RangeError('batchSize must be an integer from 1 to 500.');
  }
}
