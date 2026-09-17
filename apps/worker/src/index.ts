import {
  AliyunObjectStorageClient,
  claimBackgroundJob,
  cleanupMediaObjects,
  completeBackgroundJob,
  createMysqlPool,
  CredentialCipher,
  failBackgroundJob,
  loadCandidateAiEvidence,
  parseWorkerConfig,
  runAiAnalysis,
} from '@douyin/domain';
import type {
  CredentialCipher as CredentialCipherType,
  ObjectStorageClient,
  WorkerConfig,
} from '@douyin/domain';
import type { Pool } from 'mysql2/promise';

export function workerStatus() {
  return { service: 'worker', status: 'idle' as const };
}

export async function runMediaCleanupOnce(
  pool: Pool,
  storage: ObjectStorageClient,
  config: Pick<WorkerConfig, 'MEDIA_CLEANUP_BATCH_SIZE' | 'MEDIA_RETENTION_DAYS'>,
) {
  return cleanupMediaObjects(pool, storage, {
    batchSize: config.MEDIA_CLEANUP_BATCH_SIZE,
    retentionDays: config.MEDIA_RETENTION_DAYS,
  });
}

export async function runBackgroundJobOnce(
  pool: Pool,
  storage: ObjectStorageClient,
  cipher: CredentialCipherType,
  workerId: string,
) {
  const job = await claimBackgroundJob(pool, workerId, { jobTypes: ['ai-screening'] });
  if (!job) return null;
  try {
    const analysisId = typeof job.payload.analysisId === 'string' ? job.payload.analysisId : '';
    if (!analysisId) throw new Error('AI screening job is missing analysisId.');
    const result = await runAiAnalysis(pool, cipher, job.workspaceId, analysisId, (candidateId) =>
      loadCandidateAiEvidence(pool, storage, job.workspaceId, candidateId),
    );
    await completeBackgroundJob(pool, job.id, workerId, { analysisId, resultSchemaVersion: 1 });
    console.log(
      JSON.stringify({
        event: 'job.completed',
        jobId: job.id,
        jobType: job.jobType,
        workspaceId: job.workspaceId,
        analysisId,
        candidateId:
          typeof job.payload.candidateId === 'string' ? job.payload.candidateId : undefined,
      }),
    );
    return { id: job.id, status: 'succeeded' as const, result };
  } catch (error) {
    const status = await failBackgroundJob(pool, job, {
      code: error instanceof Error ? error.name : 'UnknownError',
      message: error instanceof Error ? error.message : 'AI screening failed.',
    });
    console.error(
      JSON.stringify({
        event: 'job.failed',
        jobId: job.id,
        jobType: job.jobType,
        workspaceId: job.workspaceId,
        candidateId:
          typeof job.payload.candidateId === 'string' ? job.payload.candidateId : undefined,
        errorType: error instanceof Error ? error.name : 'UnknownError',
        status,
      }),
    );
    return { id: job.id, status };
  }
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
  const credentialCipher = CredentialCipher.fromSingleKey(config.CREDENTIAL_ENCRYPTION_KEY);
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
  let pollRunning = false;
  const pollJobs = async () => {
    if (pollRunning) return;
    pollRunning = true;
    try {
      await Promise.all(
        Array.from({ length: config.WORKER_CONCURRENCY }, (_, index) =>
          runBackgroundJobOnce(pool, storage, credentialCipher, `${config.WORKER_ID}:${index + 1}`),
        ),
      );
    } finally {
      pollRunning = false;
    }
  };
  await pollJobs();
  const pollTimer = setInterval(() => void pollJobs(), config.WORKER_POLL_INTERVAL_MS);
  const stop = async () => {
    clearInterval(cleanupTimer);
    clearInterval(pollTimer);
    await pool.end();
    process.exitCode = 0;
  };
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
}

if (process.env.NODE_ENV !== 'test') {
  await start();
}
