import { createHash } from 'node:crypto';

import { validateMediaUpload } from '@douyin/domain/collector';
import type { EvidenceImageMimeType, MediaPurpose } from '@douyin/domain/collector';

import type { DeviceTokenStore } from './device-identity.js';

type FetchPort = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Pick<Response, 'json' | 'ok' | 'status'>>;

type ObservationAssociation =
  | { creatorObservationId: string; postObservationId?: never }
  | { creatorObservationId?: never; postObservationId: string };

export interface UploadScreenshotInput {
  apiBaseUrl: string;
  bytes: Buffer;
  mimeType: string;
  observation: ObservationAssociation;
  purpose: MediaPurpose;
  runId: string;
}

export interface UploadedScreenshot {
  confirmedAt: string;
  id: string;
  objectKey: string;
  status: 'confirmed';
}

export class CollectorMediaUploadError extends Error {
  public constructor(
    public readonly code:
      'api_request_failed' | 'invalid_signed_upload' | 'object_upload_failed' | 'unpaired_device',
  ) {
    super(`Collector media upload failed: ${code}.`);
    this.name = 'CollectorMediaUploadError';
  }
}

export async function uploadScreenshotEvidence(
  input: UploadScreenshotInput,
  tokenStore: DeviceTokenStore,
  fetcher: FetchPort = fetch,
): Promise<UploadedScreenshot> {
  const mimeType = validateMediaUpload({
    byteSize: input.bytes.byteLength,
    mimeType: input.mimeType,
  });
  const checksumSha256 = createHash('sha256').update(input.bytes).digest('hex');
  const token = await tokenStore.load();
  if (!token) throw new CollectorMediaUploadError('unpaired_device');
  const apiOrigin = new URL(input.apiBaseUrl).origin;
  const uploadGrantResponse = await fetcher(
    new URL(`/collector/runs/${encodeURIComponent(input.runId)}/media/uploads`, input.apiBaseUrl),
    {
      body: JSON.stringify({
        byteSize: input.bytes.byteLength,
        checksumSha256,
        ...input.observation,
        mimeType,
        purpose: input.purpose,
      }),
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      method: 'POST',
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!uploadGrantResponse.ok) throw new CollectorMediaUploadError('api_request_failed');
  const grant = (await uploadGrantResponse.json()) as Record<string, unknown>;
  if (
    typeof grant.id !== 'string' ||
    typeof grant.objectKey !== 'string' ||
    typeof grant.uploadUrl !== 'string'
  ) {
    throw new CollectorMediaUploadError('invalid_signed_upload');
  }
  const uploadUrl = new URL(grant.uploadUrl);
  if (uploadUrl.protocol !== 'https:' || uploadUrl.origin === apiOrigin) {
    throw new CollectorMediaUploadError('invalid_signed_upload');
  }

  const uploadResponse = await fetcher(uploadUrl, {
    body: new Uint8Array(input.bytes),
    headers: expectedUploadHeaders(input.bytes.byteLength, mimeType, checksumSha256),
    method: 'PUT',
    signal: AbortSignal.timeout(30_000),
  });
  if (!uploadResponse.ok) throw new CollectorMediaUploadError('object_upload_failed');

  const confirmationResponse = await fetcher(
    new URL(
      `/collector/runs/${encodeURIComponent(input.runId)}/media/${encodeURIComponent(grant.id)}/confirm`,
      input.apiBaseUrl,
    ),
    {
      body: JSON.stringify({
        byteSize: input.bytes.byteLength,
        checksumSha256,
        ...input.observation,
      }),
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      method: 'POST',
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!confirmationResponse.ok) throw new CollectorMediaUploadError('api_request_failed');
  const confirmation = (await confirmationResponse.json()) as Record<string, unknown>;
  if (
    confirmation.id !== grant.id ||
    confirmation.status !== 'confirmed' ||
    typeof confirmation.confirmedAt !== 'string'
  ) {
    throw new CollectorMediaUploadError('api_request_failed');
  }
  return {
    confirmedAt: confirmation.confirmedAt,
    id: grant.id,
    objectKey: grant.objectKey,
    status: 'confirmed',
  };
}

function expectedUploadHeaders(
  byteSize: number,
  mimeType: EvidenceImageMimeType,
  checksumSha256: string,
): Record<string, string> {
  return {
    'content-length': String(byteSize),
    'content-type': mimeType,
    'x-oss-meta-sha256': checksumSha256,
  };
}
