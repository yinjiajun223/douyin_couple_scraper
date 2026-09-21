import { createHash, randomUUID } from 'node:crypto';

import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';

import {
  assertCollectorProtocolCompatible,
  collectorBatchSchema,
  ingestionAcknowledgementSchema,
} from '@douyin/contracts';
import type {
  CollectorBatch,
  CreatorObservation,
  IngestionAcknowledgement,
} from '@douyin/contracts';
import { normalizeDouyinPostUrl, normalizeDouyinProfileUrl } from '@douyin/platform-douyin';

import type { DevicePrincipal } from '../auth/devices.js';
import { evaluateHardFilters } from '../screening/hard-filter.js';

interface OwnedRunRow extends RowDataPacket {
  campaign_id: string;
  rule_version_id: string;
  rules_json: CollectorBatchRules;
  status: string;
}

type CollectorBatchRules = Parameters<typeof evaluateHardFilters>[0];

interface IngestionKeyRow extends RowDataPacket {
  acknowledgement_json: IngestionAcknowledgement | null;
  request_checksum_sha256: string;
  status: 'processing' | 'completed' | 'failed';
}

interface IdRow extends RowDataPacket {
  id: string;
}

interface ObservationIdentityRow extends RowDataPacket {
  workspace_id: string;
}

interface CandidateRow extends RowDataPacket {
  id: string;
}

export class CollectorDeviceIdentityMismatchError extends Error {
  constructor() {
    super('请求中的设备标识与设备令牌不一致');
    this.name = 'CollectorDeviceIdentityMismatchError';
  }
}

export class CollectorRunAccessDeniedError extends Error {
  constructor() {
    super('当前设备没有领取这次采集运行');
    this.name = 'CollectorRunAccessDeniedError';
  }
}

export class CollectorRunNotIngestibleError extends Error {
  constructor(readonly status: string) {
    super(`当前运行状态不接受观察数据：${status}`);
    this.name = 'CollectorRunNotIngestibleError';
  }
}

export class IngestionIdempotencyConflictError extends Error {
  constructor() {
    super('同一幂等键不能用于不同的采集批次');
    this.name = 'IngestionIdempotencyConflictError';
  }
}

export class IngestionAlreadyProcessingError extends Error {
  constructor() {
    super('同一采集批次正在处理中');
    this.name = 'IngestionAlreadyProcessingError';
  }
}

export async function ingestCollectorBatch(
  pool: Pool,
  device: DevicePrincipal,
  rawBatch: unknown,
): Promise<IngestionAcknowledgement> {
  const batch = collectorBatchSchema.parse(rawBatch);
  assertCollectorProtocolCompatible(batch.protocolVersion);
  if (batch.deviceId !== device.deviceId) throw new CollectorDeviceIdentityMismatchError();

  return withTransaction(pool, async (connection) => {
    const run = await assertRunOwnership(connection, device, batch);
    const checksum = createHash('sha256').update(JSON.stringify(batch)).digest('hex');
    const existing = await findIngestionKey(connection, device, batch.idempotencyKey);
    if (existing) {
      if (existing.request_checksum_sha256 !== checksum) {
        throw new IngestionIdempotencyConflictError();
      }
      if (existing.status === 'completed' && existing.acknowledgement_json) {
        return ingestionAcknowledgementSchema.parse({
          ...existing.acknowledgement_json,
          duplicateBatch: true,
        });
      }
      throw new IngestionAlreadyProcessingError();
    }

    const ingestionKeyId = randomUUID();
    await connection.execute(
      `INSERT INTO ingestion_keys
       (id, workspace_id, device_id, run_id, idempotency_key, request_checksum_sha256,
        status, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 'processing', DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 7 DAY))`,
      [
        ingestionKeyId,
        device.workspaceId,
        device.deviceId,
        batch.runId,
        batch.idempotencyKey,
        checksum,
      ],
    );

    const results: IngestionAcknowledgement['results'] = [];
    for (const observation of batch.observations) {
      results.push(await ingestCreatorObservation(connection, device, batch, run, observation));
    }
    const acknowledgement = ingestionAcknowledgementSchema.parse({
      idempotencyKey: batch.idempotencyKey,
      duplicateBatch: false,
      results,
    });
    await connection.execute(
      `UPDATE ingestion_keys
       SET status = 'completed', acknowledgement_json = ?, completed_at = CURRENT_TIMESTAMP(3)
       WHERE id = ?`,
      [JSON.stringify(acknowledgement), ingestionKeyId],
    );
    return acknowledgement;
  });
}

async function assertRunOwnership(
  connection: PoolConnection,
  device: DevicePrincipal,
  batch: CollectorBatch,
): Promise<OwnedRunRow> {
  const [rows] = await connection.query<OwnedRunRow[]>(
    `SELECT runs.status, runs.campaign_id, runs.rule_version_id, versions.rules_json
     FROM collection_runs runs
     JOIN run_devices
       ON run_devices.workspace_id = runs.workspace_id
      AND run_devices.run_id = runs.id
     JOIN campaign_rule_versions versions ON versions.id = runs.rule_version_id
     WHERE runs.workspace_id = ? AND runs.id = ? AND run_devices.device_id = ?
     LIMIT 1
     FOR UPDATE`,
    [device.workspaceId, batch.runId, device.deviceId],
  );
  const run = rows[0];
  if (!run) throw new CollectorRunAccessDeniedError();
  if (run.status !== 'running') throw new CollectorRunNotIngestibleError(run.status);
  return run;
}

async function findIngestionKey(
  connection: PoolConnection,
  device: DevicePrincipal,
  idempotencyKey: string,
): Promise<IngestionKeyRow | undefined> {
  const [rows] = await connection.query<IngestionKeyRow[]>(
    `SELECT status, request_checksum_sha256, acknowledgement_json
     FROM ingestion_keys
     WHERE workspace_id = ? AND device_id = ? AND idempotency_key = ?
     LIMIT 1
     FOR UPDATE`,
    [device.workspaceId, device.deviceId, idempotencyKey],
  );
  return rows[0];
}

async function ingestCreatorObservation(
  connection: PoolConnection,
  device: DevicePrincipal,
  batch: CollectorBatch,
  run: OwnedRunRow,
  observation: CreatorObservation,
): Promise<IngestionAcknowledgement['results'][number]> {
  const [existingObservations] = await connection.query<ObservationIdentityRow[]>(
    'SELECT workspace_id FROM creator_observations WHERE id = ? LIMIT 1 FOR UPDATE',
    [observation.observationId],
  );
  if (existingObservations[0]) {
    return {
      observationId: observation.observationId,
      status:
        existingObservations[0].workspace_id === device.workspaceId ? 'duplicate' : 'rejected',
      ...(existingObservations[0].workspace_id === device.workspaceId
        ? {}
        : { reason: 'observation_id_conflict' }),
    };
  }

  const observedAt = new Date(observation.observedAt);
  const profileUrl = normalizeDouyinProfileUrl(observation.profileUrl);
  const creatorId = await findOrCreateCreator(
    connection,
    device.workspaceId,
    observation,
    profileUrl,
  );
  await connection.execute(
    `INSERT INTO creator_observations
     (id, workspace_id, creator_id, run_id, device_id, nickname, biography,
      follower_count, follower_count_raw, profile_url, parser_confidence,
      collector_version, parser_version, observed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      observation.observationId,
      device.workspaceId,
      creatorId,
      batch.runId,
      device.deviceId,
      observation.nickname,
      observation.biography,
      observation.followerCount,
      observation.followerCountRaw,
      profileUrl,
      observation.parserConfidence,
      batch.collectorVersion,
      batch.parserVersion,
      observedAt,
    ],
  );
  await connection.execute(
    `INSERT INTO run_creator_sources
     (workspace_id, run_id, creator_id, device_id, first_observation_id,
      first_observed_at, last_observed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       last_observed_at = GREATEST(last_observed_at, VALUES(last_observed_at)),
       observation_count = observation_count + 1`,
    [
      device.workspaceId,
      batch.runId,
      creatorId,
      device.deviceId,
      observation.observationId,
      observedAt,
      observedAt,
    ],
  );
  const hardFilterPosts: Array<Parameters<typeof evaluateHardFilters>[1]['posts'][number]> = [];
  for (const post of observation.posts) {
    const postUrl = normalizeDouyinPostUrl(post.postUrl);
    const postId = await findOrCreatePost(connection, device.workspaceId, creatorId, post, postUrl);
    const postObservationId = randomUUID();
    await connection.execute(
      `INSERT INTO post_observations
       (id, workspace_id, post_id, creator_observation_id, run_id, device_id,
        caption, like_count, like_count_raw, published_at, observed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        postObservationId,
        device.workspaceId,
        postId,
        observation.observationId,
        batch.runId,
        device.deviceId,
        post.caption,
        post.likeCount,
        post.likeCountRaw,
        post.publishedAt ? new Date(post.publishedAt) : null,
        new Date(post.observedAt),
      ],
    );
    hardFilterPosts.push({
      postId,
      postObservationId,
      postUrl,
      likeCount: post.likeCount,
      likeCountRaw: post.likeCountRaw,
      publishedAt: post.publishedAt,
      observedAt: post.observedAt,
    });
  }

  const hardFilter = evaluateHardFilters(run.rules_json, {
    creatorObservationId: observation.observationId,
    followerCount: observation.followerCount,
    followerCountRaw: observation.followerCountRaw,
    posts: hardFilterPosts,
    ...(observation.postsWindowComplete === undefined
      ? {}
      : { postsWindowComplete: observation.postsWindowComplete }),
    evaluatedAt: observation.observedAt,
  });
  const candidateId = await findOrCreateCandidate(connection, {
    workspaceId: device.workspaceId,
    campaignId: run.campaign_id,
    creatorId,
    runId: batch.runId,
    creatorObservationId: observation.observationId,
    outcome: hardFilter.outcome,
  });
  // 未入库的达人没有候选行，rule_evaluations.candidate_id 的外键也就无处可指；
  // 其结论可由上面的不可变观测与 run.rule_version_id 指向的规则快照重算。
  if (candidateId !== null) {
    for (const evaluation of hardFilter.evaluations) {
      const matchedPosts = evaluation.evidence.matchedPosts as
        Array<{ postObservationId: string }> | undefined;
      await connection.execute(
        `INSERT INTO rule_evaluations
         (id, workspace_id, candidate_id, run_id, rule_version_id,
          creator_observation_id, matched_post_observation_id, rule_key,
          rule_category, outcome, evidence_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'hard', ?, ?)`,
        [
          randomUUID(),
          device.workspaceId,
          candidateId,
          batch.runId,
          run.rule_version_id,
          observation.observationId,
          matchedPosts?.[0]?.postObservationId ?? null,
          evaluation.ruleId,
          evaluation.outcome,
          JSON.stringify({
            ...evaluation.evidence,
            evidenceReferences: evaluation.evidenceReferences,
          }),
        ],
      );
    }
  }

  return { observationId: observation.observationId, status: 'accepted' };
}

async function findOrCreateCandidate(
  connection: PoolConnection,
  input: {
    workspaceId: string;
    campaignId: string;
    creatorId: string;
    runId: string;
    creatorObservationId: string;
    outcome: 'pass' | 'fail' | 'unknown';
  },
): Promise<string | null> {
  const [rows] = await connection.query<CandidateRow[]>(
    `SELECT id FROM campaign_candidates
     WHERE campaign_id = ? AND creator_id = ?
     LIMIT 1 FOR UPDATE`,
    [input.campaignId, input.creatorId],
  );
  const existing = rows[0];
  if (existing) {
    // hard_filter_status 表示「入库资格（创建时判定）」，不随后续运行改写：
    // 达人库默认谓词是 hard_filter_status <> 'fail'，若把已晋级候选改写成
    // fail，运营正在跟进的达人会从列表里静默消失。
    await connection.execute(
      `UPDATE campaign_candidates
       SET latest_run_id = ?, latest_creator_observation_id = ?,
           version = version + 1
       WHERE id = ?`,
      [input.runId, input.creatorObservationId, existing.id],
    );
    return existing.id;
  }

  if (input.outcome !== 'pass') {
    return null;
  }

  const id = randomUUID();
  await connection.execute(
    `INSERT INTO campaign_candidates
     (id, workspace_id, campaign_id, creator_id, latest_run_id,
      latest_creator_observation_id, hard_filter_status)
     VALUES (?, ?, ?, ?, ?, ?, 'pass')`,
    [
      id,
      input.workspaceId,
      input.campaignId,
      input.creatorId,
      input.runId,
      input.creatorObservationId,
    ],
  );
  return id;
}

async function findOrCreateCreator(
  connection: PoolConnection,
  workspaceId: string,
  observation: CreatorObservation,
  profileUrl: string,
): Promise<string> {
  const [rows] = await connection.query<IdRow[]>(
    `SELECT id FROM creators
     WHERE workspace_id = ? AND platform = ? AND platform_creator_id = ?
     LIMIT 1 FOR UPDATE`,
    [workspaceId, observation.platform, observation.platformCreatorId],
  );
  const existing = rows[0];
  if (existing) {
    await connection.execute(
      `UPDATE creators
       SET canonical_profile_url = ?,
           first_observed_at = LEAST(first_observed_at, ?),
           last_observed_at = GREATEST(last_observed_at, ?)
       WHERE id = ?`,
      [profileUrl, new Date(observation.observedAt), new Date(observation.observedAt), existing.id],
    );
    return existing.id;
  }

  const id = randomUUID();
  await connection.execute(
    `INSERT INTO creators
     (id, workspace_id, platform, platform_creator_id, canonical_profile_url,
      first_observed_at, last_observed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      workspaceId,
      observation.platform,
      observation.platformCreatorId,
      profileUrl,
      new Date(observation.observedAt),
      new Date(observation.observedAt),
    ],
  );
  return id;
}

async function findOrCreatePost(
  connection: PoolConnection,
  workspaceId: string,
  creatorId: string,
  post: CreatorObservation['posts'][number],
  postUrl: string,
): Promise<string> {
  const [rows] = await connection.query<IdRow[]>(
    `SELECT id FROM posts
     WHERE workspace_id = ? AND platform = 'douyin' AND platform_post_id = ?
     LIMIT 1 FOR UPDATE`,
    [workspaceId, post.platformPostId],
  );
  const existing = rows[0];
  if (existing) {
    await connection.execute(
      `UPDATE posts
       SET canonical_post_url = ?,
           first_observed_at = LEAST(first_observed_at, ?),
           last_observed_at = GREATEST(last_observed_at, ?)
       WHERE id = ?`,
      [postUrl, new Date(post.observedAt), new Date(post.observedAt), existing.id],
    );
    return existing.id;
  }

  const id = randomUUID();
  await connection.execute(
    `INSERT INTO posts
     (id, workspace_id, creator_id, platform, platform_post_id, canonical_post_url,
      first_observed_at, last_observed_at)
     VALUES (?, ?, ?, 'douyin', ?, ?, ?, ?)`,
    [
      id,
      workspaceId,
      creatorId,
      post.platformPostId,
      postUrl,
      new Date(post.observedAt),
      new Date(post.observedAt),
    ],
  );
  return id;
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
