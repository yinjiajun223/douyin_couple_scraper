import { randomUUID } from 'node:crypto';

import type { Pool, RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';

import type { DevicePrincipal } from '../auth/devices.js';
import {
  candidateVisibilityPredicate,
  resolveCandidateScope,
} from '../candidates/candidate-access.js';
import type { CandidateAccessContext } from '../candidates/candidate-access.js';
import {
  buildMediaObjectKey,
  EVIDENCE_IMAGE_MIME_TYPES,
  MEDIA_PURPOSES,
  MAX_EVIDENCE_IMAGE_BYTES,
  validateMediaUpload,
} from './object-storage.js';
import type { ObjectStorageClient } from './object-storage.js';

export const SIGNED_UPLOAD_TTL_SECONDS = 5 * 60;
export const SIGNED_DOWNLOAD_TTL_SECONDS = 2 * 60;
export const PENDING_UPLOAD_TTL_MINUTES = 30;

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

const mediaUploadRequestSchema = z
  .object({
    byteSize: z.number().int().positive().max(MAX_EVIDENCE_IMAGE_BYTES),
    checksumSha256: sha256Schema,
    creatorObservationId: z.uuid().optional(),
    mimeType: z.enum(EVIDENCE_IMAGE_MIME_TYPES),
    postObservationId: z.uuid().optional(),
    purpose: z.enum(MEDIA_PURPOSES),
  })
  .strict()
  .superRefine((input, context) => {
    const associationCount =
      Number(Boolean(input.creatorObservationId)) + Number(Boolean(input.postObservationId));
    if (associationCount !== 1) {
      context.addIssue({
        code: 'custom',
        message: 'Exactly one observation association is required.',
        path: ['creatorObservationId'],
      });
    }
    if (input.purpose === 'profile_screenshot' && !input.creatorObservationId) {
      context.addIssue({
        code: 'custom',
        message: 'Profile screenshots must reference a creator observation.',
        path: ['creatorObservationId'],
      });
    }
    if (input.purpose === 'post_screenshot' && !input.postObservationId) {
      context.addIssue({
        code: 'custom',
        message: 'Post screenshots must reference a post observation.',
        path: ['postObservationId'],
      });
    }
  });

const mediaUploadConfirmationSchema = z
  .object({
    byteSize: z.number().int().positive().max(MAX_EVIDENCE_IMAGE_BYTES),
    checksumSha256: sha256Schema,
    creatorObservationId: z.uuid().optional(),
    postObservationId: z.uuid().optional(),
  })
  .strict()
  .superRefine((input, context) => {
    const associationCount =
      Number(Boolean(input.creatorObservationId)) + Number(Boolean(input.postObservationId));
    if (associationCount !== 1) {
      context.addIssue({
        code: 'custom',
        message: 'Exactly one observation association is required.',
        path: ['creatorObservationId'],
      });
    }
  });

type MediaUploadRequest = z.infer<typeof mediaUploadRequestSchema>;

interface RunOwnershipRow extends RowDataPacket {
  status: string;
}

interface ObservationScopeRow extends RowDataPacket {
  id: string;
}

interface PendingMediaRow extends RowDataPacket {
  byte_size: number;
  checksum_sha256: string;
  confirmed_at: Date | null;
  creator_observation_id: string | null;
  device_id: string;
  expires_at: Date | null;
  mime_type: string;
  object_key: string;
  post_observation_id: string | null;
  run_id: string;
  status: 'confirmed' | 'deleted' | 'expired' | 'pending';
}

interface ConfirmedMediaRow extends RowDataPacket {
  object_key: string;
}

export class MediaRunAccessDeniedError extends Error {
  public constructor() {
    super('The current device does not own this collection run.');
    this.name = 'MediaRunAccessDeniedError';
  }
}

export class MediaRunNotAcceptingUploadError extends Error {
  public constructor(public readonly status: string) {
    super(`The collection run does not accept uploads in status ${status}.`);
    this.name = 'MediaRunNotAcceptingUploadError';
  }
}

export class MediaObservationAccessDeniedError extends Error {
  public constructor() {
    super('The observation is outside the current device and run scope.');
    this.name = 'MediaObservationAccessDeniedError';
  }
}

export class MediaObjectNotFoundError extends Error {
  public constructor() {
    super('The media object does not exist in the current run scope.');
    this.name = 'MediaObjectNotFoundError';
  }
}

export class MediaStoredObjectUnavailableError extends Error {
  public constructor() {
    super('The expected object is not available in object storage.');
    this.name = 'MediaStoredObjectUnavailableError';
  }
}

export class MediaConfirmationMismatchError extends Error {
  public constructor(public readonly fields: string[]) {
    super(`Uploaded object metadata does not match: ${fields.join(', ')}`);
    this.name = 'MediaConfirmationMismatchError';
  }
}

export class MediaUploadExpiredError extends Error {
  public constructor() {
    super('The pending media upload has expired.');
    this.name = 'MediaUploadExpiredError';
  }
}

export interface IssuedMediaUpload {
  expiresAt: Date;
  id: string;
  maxByteSize: number;
  objectKey: string;
  requiredHeaders: Record<string, string>;
  uploadUrl: string;
}

export interface ConfirmedMediaUpload {
  confirmedAt: Date;
  id: string;
  status: 'confirmed';
}

export interface IssuedMediaAccess {
  downloadUrl: string;
  expiresAt: Date;
  id: string;
}

export async function issueMediaUpload(
  pool: Pool,
  storage: ObjectStorageClient,
  device: DevicePrincipal,
  runId: string,
  rawRequest: unknown,
  now = new Date(),
): Promise<IssuedMediaUpload> {
  const request = mediaUploadRequestSchema.parse(rawRequest);
  validateMediaUpload(request);
  await assertUploadScope(pool, device, runId, request);

  const id = randomUUID();
  const objectKey = buildMediaObjectKey({
    mediaId: id,
    mimeType: request.mimeType,
    purpose: request.purpose,
    runId,
    workspaceId: device.workspaceId,
  });
  const expiresAt = new Date(now.getTime() + SIGNED_UPLOAD_TTL_SECONDS * 1_000);
  const pendingExpiresAt = new Date(now.getTime() + PENDING_UPLOAD_TTL_MINUTES * 60_000);

  await pool.execute(
    `INSERT INTO media_objects
     (id, workspace_id, creator_observation_id, post_observation_id, object_key, purpose,
      mime_type, byte_size, checksum_sha256, status, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    [
      id,
      device.workspaceId,
      request.creatorObservationId ?? null,
      request.postObservationId ?? null,
      objectKey,
      request.purpose,
      request.mimeType,
      request.byteSize,
      request.checksumSha256,
      pendingExpiresAt,
      now,
    ],
  );

  const requiredHeaders = {
    'content-length': String(request.byteSize),
    'content-type': request.mimeType,
    'x-oss-meta-sha256': request.checksumSha256,
  };
  const uploadUrl = await storage.createSignedPutUrl({
    byteSize: request.byteSize,
    checksumSha256: request.checksumSha256,
    contentType: request.mimeType,
    expiresInSeconds: SIGNED_UPLOAD_TTL_SECONDS,
    objectKey,
  });

  return {
    expiresAt,
    id,
    maxByteSize: MAX_EVIDENCE_IMAGE_BYTES,
    objectKey,
    requiredHeaders,
    uploadUrl,
  };
}

export async function confirmMediaUpload(
  pool: Pool,
  storage: ObjectStorageClient,
  device: DevicePrincipal,
  runId: string,
  mediaId: string,
  rawConfirmation: unknown,
  now = new Date(),
): Promise<ConfirmedMediaUpload> {
  const confirmation = mediaUploadConfirmationSchema.parse(rawConfirmation);
  const media = await findPendingMedia(pool, device, runId, mediaId);
  if (!media) throw new MediaObjectNotFoundError();
  if (
    media.creator_observation_id !== (confirmation.creatorObservationId ?? null) ||
    media.post_observation_id !== (confirmation.postObservationId ?? null)
  ) {
    throw new MediaObservationAccessDeniedError();
  }
  if (media.status === 'confirmed' && media.confirmed_at) {
    return { confirmedAt: media.confirmed_at, id: mediaId, status: 'confirmed' };
  }
  if (
    media.status !== 'pending' ||
    !media.expires_at ||
    media.expires_at.getTime() <= now.getTime()
  ) {
    throw new MediaUploadExpiredError();
  }

  const requestMismatches: string[] = [];
  if (confirmation.byteSize !== media.byte_size) requestMismatches.push('byteSize');
  if (confirmation.checksumSha256 !== media.checksum_sha256) {
    requestMismatches.push('checksumSha256');
  }
  if (requestMismatches.length > 0) throw new MediaConfirmationMismatchError(requestMismatches);

  let storedObject;
  try {
    storedObject = await storage.headObject(media.object_key);
  } catch {
    throw new MediaStoredObjectUnavailableError();
  }
  const objectMismatches: string[] = [];
  if (storedObject.byteSize !== media.byte_size) objectMismatches.push('storedByteSize');
  if (storedObject.contentType !== media.mime_type) objectMismatches.push('storedContentType');
  if (storedObject.checksumSha256 !== media.checksum_sha256) {
    objectMismatches.push('storedChecksumSha256');
  }
  if (objectMismatches.length > 0) throw new MediaConfirmationMismatchError(objectMismatches);

  const [result] = await pool.execute(
    `UPDATE media_objects
     SET status = 'confirmed', confirmed_at = ?, expires_at = NULL
     WHERE workspace_id = ? AND id = ? AND status = 'pending'`,
    [now, device.workspaceId, mediaId],
  );
  if ('affectedRows' in result && result.affectedRows !== 1) throw new MediaObjectNotFoundError();

  return { confirmedAt: now, id: mediaId, status: 'confirmed' };
}

export async function issueMediaAccessUrl(
  pool: Pool,
  storage: ObjectStorageClient,
  access: CandidateAccessContext,
  mediaId: string,
  now = new Date(),
): Promise<IssuedMediaAccess> {
  const scope = resolveCandidateScope(access);
  if (!scope.targetUserId) {
    const [adminRows] = await pool.query<ConfirmedMediaRow[]>(
      `SELECT object_key FROM media_objects
       WHERE workspace_id = ? AND id = ? AND status = 'confirmed' LIMIT 1`,
      [access.workspaceId, mediaId],
    );
    const adminMedia = adminRows[0];
    if (!adminMedia) throw new MediaObjectNotFoundError();
    return {
      downloadUrl: await storage.createSignedGetUrl({
        expiresInSeconds: SIGNED_DOWNLOAD_TTL_SECONDS,
        objectKey: adminMedia.object_key,
      }),
      expiresAt: new Date(now.getTime() + SIGNED_DOWNLOAD_TTL_SECONDS * 1_000),
      id: mediaId,
    };
  }
  const visibility = candidateVisibilityPredicate('candidates', scope.targetUserId);
  const mediaScope = scope.targetUserId
    ? `AND (
        creator_devices.owner_user_id = ? OR post_devices.owner_user_id = ?
        OR ((candidates.assignee_user_id = ? OR outreach.owner_user_id = ?)
          AND (creator_observations.id = candidates.latest_creator_observation_id
            OR post_observations.creator_observation_id = candidates.latest_creator_observation_id))
      )`
    : '';
  const [rows] = await pool.query<ConfirmedMediaRow[]>(
    `SELECT DISTINCT media.object_key
     FROM media_objects media
     LEFT JOIN creator_observations
       ON creator_observations.id = media.creator_observation_id
     LEFT JOIN devices creator_devices ON creator_devices.id = creator_observations.device_id
     LEFT JOIN post_observations ON post_observations.id = media.post_observation_id
     LEFT JOIN devices post_devices ON post_devices.id = post_observations.device_id
     LEFT JOIN posts ON posts.id = post_observations.post_id
     JOIN campaign_candidates candidates
       ON candidates.workspace_id = media.workspace_id
      AND candidates.creator_id = COALESCE(creator_observations.creator_id, posts.creator_id)
     LEFT JOIN outreach_records outreach ON outreach.candidate_id = candidates.id
     WHERE media.workspace_id = ? AND media.id = ? AND media.status = 'confirmed'
       AND ${visibility.sql}
       ${mediaScope}
     LIMIT 1`,
    [
      access.workspaceId,
      mediaId,
      ...visibility.parameters,
      ...(scope.targetUserId
        ? [scope.targetUserId, scope.targetUserId, scope.targetUserId, scope.targetUserId]
        : []),
    ],
  );
  const media = rows[0];
  if (!media) throw new MediaObjectNotFoundError();

  return {
    downloadUrl: await storage.createSignedGetUrl({
      expiresInSeconds: SIGNED_DOWNLOAD_TTL_SECONDS,
      objectKey: media.object_key,
    }),
    expiresAt: new Date(now.getTime() + SIGNED_DOWNLOAD_TTL_SECONDS * 1_000),
    id: mediaId,
  };
}

async function assertUploadScope(
  pool: Pool,
  device: DevicePrincipal,
  runId: string,
  request: MediaUploadRequest,
): Promise<void> {
  const [runRows] = await pool.query<RunOwnershipRow[]>(
    `SELECT runs.status
     FROM collection_runs runs
     JOIN run_devices
       ON run_devices.workspace_id = runs.workspace_id
      AND run_devices.run_id = runs.id
     WHERE runs.workspace_id = ? AND runs.id = ? AND run_devices.device_id = ?
     LIMIT 1`,
    [device.workspaceId, runId, device.deviceId],
  );
  const run = runRows[0];
  if (!run) throw new MediaRunAccessDeniedError();
  if (run.status !== 'running') throw new MediaRunNotAcceptingUploadError(run.status);

  const table = request.creatorObservationId ? 'creator_observations' : 'post_observations';
  const observationId = request.creatorObservationId ?? request.postObservationId!;
  const [observationRows] = await pool.query<ObservationScopeRow[]>(
    `SELECT id FROM ${table}
     WHERE workspace_id = ? AND id = ? AND run_id = ? AND device_id = ?
     LIMIT 1`,
    [device.workspaceId, observationId, runId, device.deviceId],
  );
  if (!observationRows[0]) throw new MediaObservationAccessDeniedError();
}

async function findPendingMedia(
  pool: Pool,
  device: DevicePrincipal,
  runId: string,
  mediaId: string,
): Promise<PendingMediaRow | null> {
  const [rows] = await pool.query<PendingMediaRow[]>(
    `SELECT media.object_key, media.mime_type, media.byte_size, media.checksum_sha256,
            media.status, media.expires_at, media.confirmed_at,
            media.creator_observation_id, media.post_observation_id,
            COALESCE(creator.run_id, post.run_id) AS run_id,
            COALESCE(creator.device_id, post.device_id) AS device_id
     FROM media_objects media
     LEFT JOIN creator_observations creator
       ON creator.workspace_id = media.workspace_id
      AND creator.id = media.creator_observation_id
     LEFT JOIN post_observations post
       ON post.workspace_id = media.workspace_id
      AND post.id = media.post_observation_id
     WHERE media.workspace_id = ? AND media.id = ?
       AND COALESCE(creator.run_id, post.run_id) = ?
       AND COALESCE(creator.device_id, post.device_id) = ?
     LIMIT 1`,
    [device.workspaceId, mediaId, runId, device.deviceId],
  );
  return rows[0] ?? null;
}
