import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { PersistentIngestionQueue } from './ingestion-queue.js';

const temporaryDirectories: string[] = [];
const firstObservationId = '71000000-0000-4000-8000-000000000001';
const secondObservationId = '71000000-0000-4000-8000-000000000002';

const batch = {
  protocolVersion: '1.0.0',
  collectorVersion: '1.0.0',
  parserVersion: '0.2.0',
  deviceId: '71000000-0000-4000-8000-000000000010',
  runId: '71000000-0000-4000-8000-000000000020',
  idempotencyKey: 'batch-offline-restart-0001',
  observations: [firstObservationId, secondObservationId].map((observationId, index) => ({
    observationId,
    platform: 'douyin' as const,
    platformCreatorId: `creator-${index}`,
    profileUrl: `https://www.douyin.com/user/creator-${index}`,
    nickname: `达人 ${index}`,
    biography: null,
    followerCount: null,
    followerCountRaw: null,
    observedAt: '2026-09-15T00:00:00.000Z',
    posts: [],
    parserConfidence: 0.9,
  })),
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('本地持久待同步队列', () => {
  it('断网后指数重试，确认中途崩溃并重启也不丢失、不重复业务记录', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'douyin-ingestion-queue-'));
    temporaryDirectories.push(dataRoot);
    const firstProcess = new PersistentIngestionQueue(dataRoot);
    await firstProcess.enqueue(batch, new Date('2026-09-15T00:00:00.000Z'));

    const offline = await firstProcess.processNext(
      { sendBatch: vi.fn().mockRejectedValue(new Error('offline')) },
      { now: new Date('2026-09-15T00:00:00.000Z') },
    );
    expect(offline).toEqual({
      attemptCount: 1,
      nextAttemptAt: '2026-09-15T00:00:01.000Z',
      status: 'retry_scheduled',
    });
    expect(
      await firstProcess.processNext(
        { sendBatch: vi.fn() },
        { now: new Date('2026-09-15T00:00:00.500Z') },
      ),
    ).toEqual({ status: 'not_due' });

    const storedBusinessObservations = new Set<string>();
    const seenIdempotencyKeys = new Set<string>();
    const sender = {
      sendBatch: vi.fn().mockImplementation(async (submitted: typeof batch) => {
        const duplicateBatch = seenIdempotencyKeys.has(submitted.idempotencyKey);
        if (!duplicateBatch) {
          seenIdempotencyKeys.add(submitted.idempotencyKey);
          for (const observation of submitted.observations) {
            storedBusinessObservations.add(observation.observationId);
          }
        }
        return {
          idempotencyKey: submitted.idempotencyKey,
          duplicateBatch,
          results: submitted.observations.map((observation) => ({
            observationId: observation.observationId,
            status: duplicateBatch ? ('duplicate' as const) : ('accepted' as const),
          })),
        };
      }),
    };
    await expect(
      firstProcess.processNext(sender, {
        afterObservationConfirmed: async (observationId) => {
          if (observationId === firstObservationId) throw new Error('simulated process crash');
        },
        now: new Date('2026-09-15T00:00:01.000Z'),
      }),
    ).rejects.toThrow('simulated process crash');
    expect((await firstProcess.listPending())[0]?.acknowledgedObservationIds).toEqual([
      firstObservationId,
    ]);

    const restartedProcess = new PersistentIngestionQueue(dataRoot);
    await expect(
      restartedProcess.processNext(sender, { now: new Date('2026-09-15T00:00:02.000Z') }),
    ).resolves.toMatchObject({ status: 'completed', acknowledgement: { duplicateBatch: true } });
    expect(await restartedProcess.listPending()).toEqual([]);
    expect(sender.sendBatch).toHaveBeenCalledTimes(2);
    expect([...storedBusinessObservations]).toEqual([firstObservationId, secondObservationId]);
  });

  it('相同幂等键不能对应不同批次内容', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'douyin-ingestion-conflict-'));
    temporaryDirectories.push(dataRoot);
    const queue = new PersistentIngestionQueue(dataRoot);
    await queue.enqueue(batch);

    await expect(
      queue.enqueue({
        ...batch,
        observations: [{ ...batch.observations[0], nickname: '被修改的达人' }],
      }),
    ).rejects.toThrow('does not match');
  });
});
