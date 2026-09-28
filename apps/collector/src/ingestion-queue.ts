import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { collectorBatchSchema, ingestionAcknowledgementSchema } from '@douyin/contracts';
import type { CollectorBatch, IngestionAcknowledgement } from '@douyin/contracts';

const QUEUE_RECORD_VERSION = 1;

interface IngestionQueueRecord {
  acknowledgedObservationIds: string[];
  attemptCount: number;
  batch: CollectorBatch;
  createdAt: string;
  id: string;
  lastErrorCode: string | null;
  nextAttemptAt: string;
  version: typeof QUEUE_RECORD_VERSION;
}

export interface CollectorBatchSender {
  sendBatch(batch: CollectorBatch): Promise<IngestionAcknowledgement>;
}

export interface ProcessQueueOptions {
  afterObservationConfirmed?: (observationId: string) => Promise<void>;
  now?: Date;
}

export interface IngestionQueueOptions {
  /** Test seam: replaces the atomic tmp+rename write of a queue record. */
  replaceFile?: (target: string, content: string) => Promise<void>;
}

const REPLACE_RETRY_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);
const REPLACE_ATTEMPTS = 3;

export type ProcessQueueResult =
  | { status: 'empty' | 'not_due' }
  | { acknowledgement: IngestionAcknowledgement; status: 'completed' }
  | { attemptCount: number; nextAttemptAt: string; status: 'retry_scheduled' };

export class IngestionAcknowledgementMismatchError extends Error {
  public constructor() {
    super('The ingestion acknowledgement does not match the queued batch.');
    this.name = 'IngestionAcknowledgementMismatchError';
  }
}

export class PersistentIngestionQueue {
  private readonly queueDirectory: string;
  private readonly replaceFile: (target: string, content: string) => Promise<void>;

  public constructor(dataDirectory: string, options: IngestionQueueOptions = {}) {
    this.queueDirectory = path.join(path.resolve(dataDirectory), 'pending-ingestion');
    this.replaceFile =
      options.replaceFile ?? ((target, content) => this.replaceFileAtomic(target, content));
  }

  public async enqueue(rawBatch: unknown, now = new Date()): Promise<string> {
    const batch = collectorBatchSchema.parse(rawBatch);
    const existing = (await this.readRecords()).find(
      (record) => record.batch.idempotencyKey === batch.idempotencyKey,
    );
    if (existing) {
      if (JSON.stringify(existing.batch) !== JSON.stringify(batch)) {
        throw new IngestionAcknowledgementMismatchError();
      }
      return existing.id;
    }

    const record: IngestionQueueRecord = {
      acknowledgedObservationIds: [],
      attemptCount: 0,
      batch,
      createdAt: now.toISOString(),
      id: randomUUID(),
      lastErrorCode: null,
      nextAttemptAt: now.toISOString(),
      version: QUEUE_RECORD_VERSION,
    };
    await this.writeRecord(record);
    return record.id;
  }

  public async listPending(): Promise<
    Array<
      Pick<
        IngestionQueueRecord,
        'acknowledgedObservationIds' | 'attemptCount' | 'batch' | 'id' | 'nextAttemptAt'
      >
    >
  > {
    return (await this.readRecords()).map((record) => ({
      acknowledgedObservationIds: record.acknowledgedObservationIds,
      attemptCount: record.attemptCount,
      batch: record.batch,
      id: record.id,
      nextAttemptAt: record.nextAttemptAt,
    }));
  }

  public async processNext(
    sender: CollectorBatchSender,
    options: ProcessQueueOptions = {},
  ): Promise<ProcessQueueResult> {
    const now = options.now ?? new Date();
    const record = (await this.readRecords())[0];
    if (!record) return { status: 'empty' };
    if (Date.parse(record.nextAttemptAt) > now.getTime()) return { status: 'not_due' };

    let acknowledgement: IngestionAcknowledgement;
    try {
      acknowledgement = ingestionAcknowledgementSchema.parse(await sender.sendBatch(record.batch));
    } catch (error) {
      record.attemptCount += 1;
      record.lastErrorCode = error instanceof Error ? error.name : 'UnknownError';
      record.nextAttemptAt = new Date(
        now.getTime() + Math.min(60_000, 1_000 * 2 ** Math.min(record.attemptCount - 1, 6)),
      ).toISOString();
      await this.writeRecord(record);
      return {
        attemptCount: record.attemptCount,
        nextAttemptAt: record.nextAttemptAt,
        status: 'retry_scheduled',
      };
    }
    this.assertAcknowledgementMatches(record.batch, acknowledgement);

    for (const result of acknowledgement.results) {
      if (!record.acknowledgedObservationIds.includes(result.observationId)) {
        record.acknowledgedObservationIds.push(result.observationId);
        record.lastErrorCode = null;
        await this.writeRecord(record);
        await options.afterObservationConfirmed?.(result.observationId);
      }
    }
    if (
      record.batch.observations.every((observation) =>
        record.acknowledgedObservationIds.includes(observation.observationId),
      )
    ) {
      await unlink(this.recordPath(record.id));
      return { acknowledgement, status: 'completed' };
    }
    throw new IngestionAcknowledgementMismatchError();
  }

  private assertAcknowledgementMatches(
    batch: CollectorBatch,
    acknowledgement: IngestionAcknowledgement,
  ): void {
    const expectedIds = new Set(batch.observations.map((observation) => observation.observationId));
    if (
      acknowledgement.idempotencyKey !== batch.idempotencyKey ||
      acknowledgement.results.some((result) => !expectedIds.has(result.observationId))
    ) {
      throw new IngestionAcknowledgementMismatchError();
    }
  }

  private async readRecords(): Promise<IngestionQueueRecord[]> {
    await mkdir(this.queueDirectory, { recursive: true });
    const files = (await readdir(this.queueDirectory))
      .filter((file) => /^[0-9a-f-]+\.json$/u.test(file))
      .sort();
    const records: IngestionQueueRecord[] = [];
    for (const file of files) {
      const parsed = JSON.parse(
        await readFile(path.join(this.queueDirectory, file), 'utf8'),
      ) as unknown;
      if (!isQueueRecord(parsed)) throw new Error(`Invalid ingestion queue record: ${file}`);
      records.push(parsed);
    }
    return records.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  private async writeRecord(record: IngestionQueueRecord): Promise<void> {
    await mkdir(this.queueDirectory, { recursive: true });
    const target = this.recordPath(record.id);
    const content = `${JSON.stringify(record)}\n`;
    let lastError: unknown;
    for (let attempt = 1; attempt <= REPLACE_ATTEMPTS; attempt += 1) {
      try {
        await this.replaceFile(target, content);
        return;
      } catch (error) {
        lastError = error;
        const code = (error as NodeJS.ErrnoException).code;
        if (!code || !REPLACE_RETRY_CODES.has(code) || attempt === REPLACE_ATTEMPTS) break;
        await new Promise((resolve) => setTimeout(resolve, 150 * attempt));
      }
    }
    throw lastError;
  }

  /**
   * Windows antivirus/manager software can hold a transient lock on the queue
   * record, making rename fail with EPERM/EACCES/EBUSY. Never leave a stale tmp
   * file behind when a replace attempt fails.
   */
  private async replaceFileAtomic(target: string, content: string): Promise<void> {
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
    try {
      await rename(temporary, target);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  private recordPath(id: string): string {
    return path.join(this.queueDirectory, `${id}.json`);
  }
}

function isQueueRecord(value: unknown): value is IngestionQueueRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<IngestionQueueRecord>;
  return (
    record.version === QUEUE_RECORD_VERSION &&
    typeof record.id === 'string' &&
    typeof record.createdAt === 'string' &&
    typeof record.nextAttemptAt === 'string' &&
    typeof record.attemptCount === 'number' &&
    Array.isArray(record.acknowledgedObservationIds) &&
    collectorBatchSchema.safeParse(record.batch).success
  );
}
