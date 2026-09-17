import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { DeviceTokenStore } from './device-identity.js';
import type { SecretProtector } from './device-identity.js';
import { uploadScreenshotEvidence } from './media-upload.js';

const temporaryDirectories: string[] = [];
const passthroughProtector: SecretProtector = {
  protect: async (value) => value,
  unprotect: async (value) => value,
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('截图直传 OSS', () => {
  it('API 只签发和确认元数据，图片字节仅发送到独立 OSS 域名', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'douyin-media-upload-'));
    temporaryDirectories.push(dataRoot);
    const tokenStore = new DeviceTokenStore(dataRoot, passthroughProtector);
    await tokenStore.save('collector-media-device-token-value');
    const bytes = Buffer.from('fake-png-image-bytes');
    const checksumSha256 = createHash('sha256').update(bytes).digest('hex');
    const calls: Array<{
      body: BodyInit | null | undefined;
      headers: HeadersInit | undefined;
      method: string;
      url: URL;
    }> = [];
    const fetcher = vi.fn().mockImplementation(async (rawUrl: URL, init: RequestInit) => {
      const url = new URL(rawUrl);
      calls.push({ body: init.body, headers: init.headers, method: init.method ?? 'GET', url });
      if (url.pathname.endsWith('/media/uploads')) {
        return {
          json: async () => ({
            id: 'media-1',
            objectKey: 'workspaces/w/runs/r/media/media-1-profile_screenshot.png',
            uploadUrl:
              'https://private-bucket.oss-cn-hangzhou.aliyuncs.com/signed-object?signature=1',
          }),
          ok: true,
          status: 201,
        };
      }
      if (url.hostname.endsWith('.aliyuncs.com')) {
        return { json: async () => ({}), ok: true, status: 200 };
      }
      return {
        json: async () => ({
          id: 'media-1',
          status: 'confirmed',
          confirmedAt: '2026-09-15T00:00:00.000Z',
        }),
        ok: true,
        status: 200,
      };
    });

    await expect(
      uploadScreenshotEvidence(
        {
          apiBaseUrl: 'https://ops.example.test',
          bytes,
          mimeType: 'image/png',
          observation: { creatorObservationId: '72000000-0000-4000-8000-000000000001' },
          purpose: 'profile_screenshot',
          runId: '72000000-0000-4000-8000-000000000002',
        },
        tokenStore,
        fetcher,
      ),
    ).resolves.toMatchObject({ id: 'media-1', status: 'confirmed' });

    expect(calls.map((call) => [call.method, call.url.hostname])).toEqual([
      ['POST', 'ops.example.test'],
      ['PUT', 'private-bucket.oss-cn-hangzhou.aliyuncs.com'],
      ['POST', 'ops.example.test'],
    ]);
    expect(calls[0]?.body).not.toBeInstanceOf(Uint8Array);
    expect(calls[1]?.body).toBeInstanceOf(Uint8Array);
    expect(calls[2]?.body).not.toBeInstanceOf(Uint8Array);
    expect(calls[1]?.headers).toEqual({
      'content-length': String(bytes.byteLength),
      'content-type': 'image/png',
      'x-oss-meta-sha256': checksumSha256,
    });
    expect(JSON.stringify(calls[0]?.body)).not.toContain(bytes.toString('utf8'));
  });

  it.each(['video/mp4', 'video/webm', 'application/octet-stream'])(
    '默认路径拒绝完整视频 MIME %s',
    async (mimeType) => {
      const dataRoot = await mkdtemp(path.join(tmpdir(), 'douyin-media-video-'));
      temporaryDirectories.push(dataRoot);
      const fetcher = vi.fn();

      await expect(
        uploadScreenshotEvidence(
          {
            apiBaseUrl: 'https://ops.example.test',
            bytes: Buffer.from('video'),
            mimeType,
            observation: { postObservationId: '72000000-0000-4000-8000-000000000003' },
            purpose: 'post_screenshot',
            runId: '72000000-0000-4000-8000-000000000002',
          },
          new DeviceTokenStore(dataRoot, passthroughProtector),
          fetcher,
        ),
      ).rejects.toThrow('Only JPEG, PNG, and WebP');
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
});
