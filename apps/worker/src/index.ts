import {
  AliyunObjectStorageClient,
  cleanupMediaObjects,
  createMysqlPool,
  parseWorkerConfig,
} from '@douyin/domain';
import type { ObjectStorageClient, WorkerConfig } from '@douyin/domain';
import type { Pool } from 'mysql2/promise';

export function workerStatus() {
  return { service: 'worker', status: 'idle' as const };
}

export async function runMediaCleanupOnce(
  pool: Pool,
  storage: ObjectStorageClient,
  config: Pick<
    WorkerConfig,
    | 'MEDIA_CLEANUP_BATCH_SIZE'
    | 'MEDIA_RETENTION_DAYS'
    | 'ORPHAN_MEDIA_CLEANUP_ENABLED'
    | 'ORPHAN_MEDIA_GRACE_DAYS'
  >,
) {
  return cleanupMediaObjects(pool, storage, {
    batchSize: config.MEDIA_CLEANUP_BATCH_SIZE,
    orphanCleanupEnabled: config.ORPHAN_MEDIA_CLEANUP_ENABLED,
    orphanGraceDays: config.ORPHAN_MEDIA_GRACE_DAYS,
    retentionDays: config.MEDIA_RETENTION_DAYS,
  });
}

async function start(): Promise<void> {
  const config = parseWorkerConfig(process.env);
  const pool = createMysqlPool(config.DATABASE_URL);
  const storage = new AliyunObjectStorageClient({
    accessKeyId: config.OSS_ACCESS_KEY_ID,
    accessKeySecret: config.OSS_ACCESS_KEY_SECRET,
    bucket: config.OSS_BUCKET,
    endpoint: config.OSS_ENDPOINT,
    region: config.OSS_REGION,
  });
  let cleanupRunning = false;
  const runCleanup = async () => {
    if (cleanupRunning) return;
    cleanupRunning = true;
    try {
      const summary = await runMediaCleanupOnce(pool, storage, config);
      console.log(JSON.stringify({ event: 'media.cleanup.completed', ...summary }));
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'media.cleanup.failed',
          errorType: error instanceof Error ? error.name : 'UnknownError',
        }),
      );
    } finally {
      cleanupRunning = false;
    }
  };

  console.log(JSON.stringify({ ...workerStatus(), workerId: config.WORKER_ID }));
  await runCleanup();
  const cleanupTimer = setInterval(() => void runCleanup(), config.MEDIA_CLEANUP_INTERVAL_MS);
  const stop = async () => {
    clearInterval(cleanupTimer);
    await pool.end();
    process.exitCode = 0;
  };
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
}

if (process.env.NODE_ENV !== 'test') {
  await start();
}
