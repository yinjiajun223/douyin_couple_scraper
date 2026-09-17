import { describe, expect, it, vi } from 'vitest';

import {
  AliyunObjectStorageClient,
  buildMediaObjectKey,
  InvalidMediaUploadError,
  MAX_EVIDENCE_IMAGE_BYTES,
  validateMediaUpload,
} from './object-storage.js';

const workspaceId = '10000000-0000-4000-8000-000000000001';
const runId = '20000000-0000-4000-8000-000000000001';
const mediaId = '30000000-0000-4000-8000-000000000001';

describe('OSS 素材策略', () => {
  it('只用不透明标识、固定目录和固定用途生成对象 key', () => {
    expect(
      buildMediaObjectKey({
        mediaId,
        mimeType: 'image/webp',
        purpose: 'profile_screenshot',
        runId,
        workspaceId,
      }),
    ).toBe(`workspaces/${workspaceId}/runs/${runId}/media/${mediaId}-profile_screenshot.webp`);
  });

  it.each([
    ['../../../secret', runId, mediaId],
    [workspaceId, 'alice/爆款文案', mediaId],
    [workspaceId, runId, 'access-key-secret'],
  ])('拒绝把用户名、文案、密钥或路径片段混入 key', (badWorkspaceId, badRunId, badMediaId) => {
    expect(() =>
      buildMediaObjectKey({
        mediaId: badMediaId,
        mimeType: 'image/png',
        purpose: 'post_screenshot',
        runId: badRunId,
        workspaceId: badWorkspaceId,
      }),
    ).toThrowError(InvalidMediaUploadError);
  });

  it.each(['video/mp4', 'image/svg+xml', 'application/octet-stream'])(
    '拒绝 MIME %s',
    (mimeType) => {
      expect(() => validateMediaUpload({ byteSize: 1_024, mimeType })).toThrowError(
        expect.objectContaining({ code: 'unsupported_mime_type' }),
      );
    },
  );

  it('接受上限大小并拒绝空文件、非整数和超限图片', () => {
    expect(
      validateMediaUpload({ byteSize: MAX_EVIDENCE_IMAGE_BYTES, mimeType: 'image/jpeg' }),
    ).toBe('image/jpeg');

    for (const byteSize of [0, 1.5, MAX_EVIDENCE_IMAGE_BYTES + 1]) {
      expect(() => validateMediaUpload({ byteSize, mimeType: 'image/jpeg' })).toThrowError(
        expect.objectContaining({ code: 'invalid_byte_size' }),
      );
    }
  });

  it('通过 V4 PUT 签名固定 Content-Type 和 Content-Length', async () => {
    const signatureUrlV4 = vi.fn().mockResolvedValue('https://private.example/signed');
    const client = new AliyunObjectStorageClient(
      {
        accessKeyId: 'unused-in-test',
        accessKeySecret: 'unused-in-test',
        bucket: 'private-bucket',
        endpoint: 'https://oss-cn-example.aliyuncs.com',
        region: 'oss-cn-example',
      },
      {
        delete: vi.fn(),
        head: vi.fn(),
        signatureUrlV4,
      },
    );
    const objectKey = buildMediaObjectKey({
      mediaId,
      mimeType: 'image/png',
      purpose: 'diagnostic',
      runId,
      workspaceId,
    });

    await expect(
      client.createSignedPutUrl({
        byteSize: 4_096,
        checksumSha256: 'a'.repeat(64),
        contentType: 'image/png',
        expiresInSeconds: 300,
        objectKey,
      }),
    ).resolves.toBe('https://private.example/signed');
    expect(signatureUrlV4).toHaveBeenCalledWith(
      'PUT',
      300,
      {
        headers: {
          'content-length': '4096',
          'content-type': 'image/png',
          'x-oss-meta-sha256': 'a'.repeat(64),
        },
      },
      objectKey,
    );
  });
});
