import OSS from 'ali-oss';

export const EVIDENCE_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export const MAX_EVIDENCE_IMAGE_BYTES = 8 * 1024 * 1024;

export const MEDIA_PURPOSES = ['profile_screenshot', 'post_screenshot', 'diagnostic'] as const;

export type EvidenceImageMimeType = (typeof EVIDENCE_IMAGE_MIME_TYPES)[number];
export type MediaPurpose = (typeof MEDIA_PURPOSES)[number];

const MIME_EXTENSIONS: Record<EvidenceImageMimeType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

const OPAQUE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class InvalidMediaUploadError extends Error {
  public constructor(
    public readonly code: 'invalid_byte_size' | 'invalid_identifier' | 'unsupported_mime_type',
    message: string,
  ) {
    super(message);
    this.name = 'InvalidMediaUploadError';
  }
}

export interface MediaUploadPolicyInput {
  byteSize: number;
  mimeType: string;
}

export interface MediaObjectKeyInput {
  mediaId: string;
  mimeType: string;
  purpose: MediaPurpose;
  runId: string;
  workspaceId: string;
}

export interface SignedPutRequest {
  byteSize: number;
  checksumSha256: string;
  contentType: EvidenceImageMimeType;
  expiresInSeconds: number;
  objectKey: string;
}

export interface SignedGetRequest {
  expiresInSeconds: number;
  objectKey: string;
}

export interface StoredObjectMetadata {
  byteSize: number;
  checksumSha256: string | null;
  contentType: string | null;
  etag: string | null;
}

export interface ObjectStorageClient {
  checkConnectivity?(): Promise<void>;
  createSignedGetUrl(input: SignedGetRequest): Promise<string>;
  createSignedPutUrl(input: SignedPutRequest): Promise<string>;
  deleteObject(objectKey: string): Promise<void>;
  headObject(objectKey: string): Promise<StoredObjectMetadata>;
}

export interface AliyunObjectStorageConfig {
  accessKeyId: string;
  accessKeySecret: string;
  bucket: string;
  endpoint: string;
  region: string;
}

interface AliyunClientPort {
  delete(name: string): Promise<unknown>;
  head(name: string): Promise<{
    res: { headers: object };
  }>;
  signatureUrlV4(
    method: 'GET' | 'PUT',
    expires: number,
    request: { headers?: Record<string, string> },
    objectName: string,
  ): Promise<string>;
}

export function validateMediaUpload(input: MediaUploadPolicyInput): EvidenceImageMimeType {
  if (!EVIDENCE_IMAGE_MIME_TYPES.includes(input.mimeType as EvidenceImageMimeType)) {
    throw new InvalidMediaUploadError(
      'unsupported_mime_type',
      'Only JPEG, PNG, and WebP screenshots are allowed.',
    );
  }

  if (!Number.isSafeInteger(input.byteSize) || input.byteSize <= 0) {
    throw new InvalidMediaUploadError(
      'invalid_byte_size',
      'Screenshot byte size must be a positive integer.',
    );
  }

  if (input.byteSize > MAX_EVIDENCE_IMAGE_BYTES) {
    throw new InvalidMediaUploadError(
      'invalid_byte_size',
      `Screenshot byte size must not exceed ${MAX_EVIDENCE_IMAGE_BYTES} bytes.`,
    );
  }

  return input.mimeType as EvidenceImageMimeType;
}

export function buildMediaObjectKey(input: MediaObjectKeyInput): string {
  const mimeType = validateMediaUpload({ byteSize: 1, mimeType: input.mimeType });
  assertOpaqueId('workspaceId', input.workspaceId);
  assertOpaqueId('runId', input.runId);
  assertOpaqueId('mediaId', input.mediaId);

  return [
    'workspaces',
    input.workspaceId,
    'runs',
    input.runId,
    'media',
    `${input.mediaId}-${input.purpose}.${MIME_EXTENSIONS[mimeType]}`,
  ].join('/');
}

export function isMediaObjectKeyInScope(
  objectKey: string,
  scope: Pick<MediaObjectKeyInput, 'runId' | 'workspaceId'>,
): boolean {
  try {
    assertOpaqueId('workspaceId', scope.workspaceId);
    assertOpaqueId('runId', scope.runId);
  } catch {
    return false;
  }

  return objectKey.startsWith(`workspaces/${scope.workspaceId}/runs/${scope.runId}/media/`);
}

export class AliyunObjectStorageClient implements ObjectStorageClient {
  private readonly client: AliyunClientPort;

  public constructor(config: AliyunObjectStorageConfig, client?: AliyunClientPort) {
    this.client =
      client ??
      new OSS({
        accessKeyId: config.accessKeyId,
        accessKeySecret: config.accessKeySecret,
        authorizationV4: true,
        bucket: config.bucket,
        endpoint: config.endpoint,
        region: config.region,
        secure: true,
      });
  }

  public async createSignedPutUrl(input: SignedPutRequest): Promise<string> {
    validateMediaUpload({ byteSize: input.byteSize, mimeType: input.contentType });

    return this.client.signatureUrlV4(
      'PUT',
      input.expiresInSeconds,
      {
        headers: {
          'content-length': String(input.byteSize),
          'content-type': input.contentType,
          'x-oss-meta-sha256': input.checksumSha256,
        },
      },
      input.objectKey,
    );
  }

  public async checkConnectivity(): Promise<void> {
    try {
      await this.client.head('__healthcheck__/readiness');
    } catch (error) {
      if (isObjectNotFoundError(error)) return;
      throw error;
    }
  }

  public async createSignedGetUrl(input: SignedGetRequest): Promise<string> {
    return this.client.signatureUrlV4('GET', input.expiresInSeconds, {}, input.objectKey);
  }

  public async headObject(objectKey: string): Promise<StoredObjectMetadata> {
    const result = await this.client.head(objectKey);
    const headers = normalizeHeaders(result.res.headers);

    return {
      byteSize: Number(headers['content-length'] ?? 0),
      checksumSha256: headers['x-oss-meta-sha256'] ?? null,
      contentType: headers['content-type'] ?? null,
      etag: headers.etag?.replaceAll('"', '') ?? null,
    };
  }

  public async deleteObject(objectKey: string): Promise<void> {
    await this.client.delete(objectKey);
  }
}

function isObjectNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; status?: unknown; statusCode?: unknown };
  return (
    candidate.status === 404 ||
    candidate.statusCode === 404 ||
    candidate.code === 'NoSuchKey' ||
    candidate.code === 'NoSuchObject'
  );
}

function assertOpaqueId(label: string, value: string): void {
  if (!OPAQUE_ID_PATTERN.test(value)) {
    throw new InvalidMediaUploadError(
      'invalid_identifier',
      `${label} must be a lowercase UUID and cannot contain user-controlled path text.`,
    );
  }
}

function normalizeHeaders(headers: object): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]),
  );
}
