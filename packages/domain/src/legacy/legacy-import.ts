import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

import type { Pool, RowDataPacket } from 'mysql2/promise';

import { COLLECTOR_PROTOCOL_VERSION, createDefaultCampaignRuleSet } from '@douyin/contracts';
import { normalizeDouyinProfileUrl } from '@douyin/platform-douyin';

import type { DevicePrincipal } from '../auth/devices.js';
import { createCampaign } from '../campaigns/campaign-service.js';
import {
  claimCollectionRun,
  createCollectionRun,
  startClaimedCollectionRun,
} from '../campaigns/run-service.js';
import { ingestCollectorBatch } from '../ingestion/collector-ingestion.js';

export interface LegacyCreatorRecord {
  collectedAt: string | null;
  followerCount: number | null;
  followerCountRaw: string | null;
  nickname: string;
  profileUrl: string;
  screenshotPath: string | null;
}

export interface LegacyImportReport {
  duplicateInputRecords: number;
  existingImport: boolean;
  importedObservations: number;
  invalidRecords: number;
  runId: string;
  skippedScreenshots: number;
  sourceRecords: number;
  uniqueCreators: number;
}

interface IdRow extends RowDataPacket {
  id: string;
}

export function parseLegacyExport(contents: string, extension: '.csv' | '.json') {
  let rawRecords: unknown[];
  if (extension === '.json') {
    const parsed = JSON.parse(contents) as unknown;
    if (!Array.isArray(parsed)) throw new Error('Legacy JSON export must contain an array.');
    rawRecords = parsed;
  } else {
    const rows = csvRows(contents);
    const headers = rows.shift() ?? [];
    rawRecords = rows.map((values) =>
      Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ''])),
    );
  }

  return rawRecords.map(normalizeLegacyRecord);
}

export async function importLegacyExport(
  pool: Pool,
  input: { actorUserId: string; filePath: string; workspaceId: string },
): Promise<LegacyImportReport> {
  const extension = extname(input.filePath).toLowerCase();
  if (extension !== '.json' && extension !== '.csv') {
    throw new Error('Legacy import only supports JSON or CSV files.');
  }
  const contents = await readFile(input.filePath, 'utf8');
  const fingerprint = createHash('sha256').update(contents).digest('hex');
  const sourceRecords = parseLegacyExport(contents, extension);
  const validRecords = sourceRecords.filter(isValidLegacyRecord);
  const uniqueByCreator = new Map<string, LegacyCreatorRecord>();
  for (const record of validRecords)
    uniqueByCreator.set(platformCreatorId(record.profileUrl), record);
  const records = [...uniqueByCreator.entries()];
  const campaignMarker = `legacy-import:${fingerprint}`;

  const [existingRuns] = await pool.query<IdRow[]>(
    `SELECT runs.id FROM collection_runs runs
     JOIN campaigns ON campaigns.id = runs.campaign_id
     WHERE campaigns.workspace_id = ? AND campaigns.recommendation_profile_description = ?
       AND runs.stop_reason = 'legacy_import'
     LIMIT 1`,
    [input.workspaceId, campaignMarker],
  );
  if (existingRuns[0]) {
    return {
      duplicateInputRecords: validRecords.length - records.length,
      existingImport: true,
      importedObservations: 0,
      invalidRecords: sourceRecords.length - validRecords.length,
      runId: existingRuns[0].id,
      skippedScreenshots: validRecords.filter((record) => Boolean(record.screenshotPath)).length,
      sourceRecords: sourceRecords.length,
      uniqueCreators: records.length,
    };
  }

  const device = await findOrCreateLegacyDevice(pool, input.workspaceId, input.actorUserId);
  const campaign = await createCampaign(pool, {
    actorUserId: input.actorUserId,
    name: `Legacy import ${fingerprint.slice(0, 12)}`,
    recommendationProfileDescription: campaignMarker,
    rules: createDefaultCampaignRuleSet(),
    workspaceId: input.workspaceId,
  });
  const run = await createCollectionRun(pool, {
    actorUserId: input.actorUserId,
    campaignId: campaign.id,
    workspaceId: input.workspaceId,
  });
  await claimCollectionRun(pool, {
    deviceId: device.deviceId,
    runId: run.id,
    workspaceId: input.workspaceId,
  });
  await startClaimedCollectionRun(pool, {
    deviceId: device.deviceId,
    runId: run.id,
    workspaceId: input.workspaceId,
  });

  let importedObservations = 0;
  for (let offset = 0; offset < records.length; offset += 100) {
    const chunk = records.slice(offset, offset + 100);
    const acknowledgement = await ingestCollectorBatch(pool, device, {
      collectorVersion: '0.0.0',
      deviceId: device.deviceId,
      idempotencyKey: `legacy-${fingerprint}-${String(offset).padStart(8, '0')}`,
      observations: chunk.map(([creatorId, record]) => ({
        biography: null,
        followerCount: record.followerCount,
        followerCountRaw: record.followerCountRaw,
        nickname: record.nickname,
        observationId: uuidFromText(`${fingerprint}:${creatorId}`),
        observedAt: validDate(record.collectedAt).toISOString(),
        parserConfidence: 0.5,
        platform: 'douyin' as const,
        platformCreatorId: creatorId,
        posts: [],
        profileUrl: normalizeDouyinProfileUrl(record.profileUrl),
      })),
      parserVersion: '0.0.0',
      protocolVersion: COLLECTOR_PROTOCOL_VERSION,
      runId: run.id,
    });
    await preserveMissingLegacyPostEvidence(
      pool,
      input.workspaceId,
      run.id,
      chunk.map(([creatorId]) => uuidFromText(`${fingerprint}:${creatorId}`)),
    );
    importedObservations += acknowledgement.results.filter(
      (result) => result.status === 'accepted',
    ).length;
  }

  await pool.execute(
    `UPDATE collection_runs
     SET status = 'completed', stop_reason = 'legacy_import', ended_at = CURRENT_TIMESTAMP(3),
         progress_json = ?
     WHERE workspace_id = ? AND id = ?`,
    [
      JSON.stringify({
        candidatesFound: importedObservations,
        creatorProfilesSeen: importedObservations,
        elapsedSeconds: 0,
        feedItemsSeen: 0,
        legacyImport: true,
      }),
      input.workspaceId,
      run.id,
    ],
  );

  return {
    duplicateInputRecords: validRecords.length - records.length,
    existingImport: false,
    importedObservations,
    invalidRecords: sourceRecords.length - validRecords.length,
    runId: run.id,
    skippedScreenshots: validRecords.filter((record) => Boolean(record.screenshotPath)).length,
    sourceRecords: sourceRecords.length,
    uniqueCreators: records.length,
  };
}

async function preserveMissingLegacyPostEvidence(
  pool: Pool,
  workspaceId: string,
  runId: string,
  creatorObservationIds: string[],
) {
  if (creatorObservationIds.length === 0) return;
  const placeholders = creatorObservationIds.map(() => '?').join(', ');
  await pool.execute(
    `UPDATE rule_evaluations
     SET outcome = 'unknown', matched_post_observation_id = NULL,
         evidence_json = JSON_OBJECT(
           'reason', 'legacy_missing_post_evidence',
           'source', 'legacy_import',
           'matchedPosts', JSON_ARRAY(),
           'unknownPosts', JSON_ARRAY()
         )
     WHERE workspace_id = ? AND run_id = ? AND rule_key = 'recent-viral-post'
       AND creator_observation_id IN (${placeholders})`,
    [workspaceId, runId, ...creatorObservationIds],
  );
  await pool.execute(
    `UPDATE campaign_candidates candidates
     SET hard_filter_status = (
       SELECT CASE
         WHEN SUM(evaluations.outcome = 'fail') > 0 THEN 'fail'
         WHEN SUM(evaluations.outcome = 'unknown') > 0 THEN 'unknown'
         ELSE 'pass'
       END
       FROM rule_evaluations evaluations
       WHERE evaluations.workspace_id = candidates.workspace_id
         AND evaluations.candidate_id = candidates.id
         AND evaluations.run_id = ?
     )
     WHERE candidates.workspace_id = ? AND candidates.latest_run_id = ?
       AND candidates.latest_creator_observation_id IN (${placeholders})`,
    [runId, workspaceId, runId, ...creatorObservationIds],
  );
}

function normalizeLegacyRecord(value: unknown): LegacyCreatorRecord {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const followerValue = record.followerCount ?? record['粉丝数'];
  const parsedFollower =
    typeof followerValue === 'number'
      ? followerValue
      : typeof followerValue === 'string' && followerValue.trim()
        ? Number(followerValue)
        : Number.NaN;
  return {
    collectedAt: stringValue(record.collectedAt ?? record['采集时间']),
    followerCount:
      Number.isSafeInteger(parsedFollower) && parsedFollower >= 0 ? parsedFollower : null,
    followerCountRaw: stringValue(record.followerRaw ?? record['粉丝数原文']),
    nickname: stringValue(record.nickname ?? record['昵称']) ?? 'Legacy creator',
    profileUrl: stringValue(record.profileUrl ?? record['主页链接']) ?? '',
    screenshotPath: stringValue(record.screenshot ?? record['主页截图']),
  };
}

function isValidLegacyRecord(record: LegacyCreatorRecord) {
  try {
    normalizeDouyinProfileUrl(record.profileUrl);
    return record.nickname.length <= 200;
  } catch {
    return false;
  }
}

function platformCreatorId(profileUrl: string) {
  const url = new URL(normalizeDouyinProfileUrl(profileUrl));
  const identifier = url.pathname.split('/').filter(Boolean).at(-1) ?? '';
  return identifier === 'self' || !identifier
    ? `legacy-${createHash('sha256').update(url.href).digest('hex').slice(0, 32)}`
    : identifier.slice(0, 200);
}

function validDate(value: string | null) {
  // MySQL TIMESTAMP starts at 1970-01-01 00:00:01 UTC. Legacy rows without a
  // timestamp use that first representable instant instead of the Unix epoch.
  const fallback = new Date(1_000);
  const date = value ? new Date(value) : fallback;
  return Number.isNaN(date.getTime()) || date < fallback ? fallback : date;
}

function stringValue(value: unknown) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

function uuidFromText(value: string) {
  const hash = createHash('sha256').update(value).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

async function findOrCreateLegacyDevice(pool: Pool, workspaceId: string, actorUserId: string) {
  const [rows] = await pool.query<IdRow[]>(
    "SELECT id FROM devices WHERE workspace_id = ? AND name = 'Legacy import' LIMIT 1",
    [workspaceId],
  );
  const deviceId = rows[0]?.id ?? randomUUID();
  if (!rows[0]) {
    await pool.execute(
      `INSERT INTO devices
       (id, workspace_id, owner_user_id, name, token_hash, collector_version, parser_version)
       VALUES (?, ?, ?, 'Legacy import', ?, '0.0.0', '0.0.0')`,
      [
        deviceId,
        workspaceId,
        actorUserId,
        createHash('sha256').update(`legacy-import:${workspaceId}`).digest('hex'),
      ],
    );
  }
  return {
    collectorVersion: '0.0.0',
    deviceId,
    name: 'Legacy import',
    ownerUserId: actorUserId,
    parserVersion: '0.0.0',
    workspaceId,
  } satisfies DevicePrincipal;
}

function csvRows(contents: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < contents.length; index += 1) {
    const character = contents[index]!;
    if (character === '"') {
      if (quoted && contents[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === ',' && !quoted) {
      row.push(field);
      field = '';
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && contents[index + 1] === '\n') index += 1;
      row.push(field);
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      field = '';
    } else {
      field += character;
    }
  }
  row.push(field);
  if (row.some((value) => value.length > 0)) rows.push(row);
  return rows;
}
