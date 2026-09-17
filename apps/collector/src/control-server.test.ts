import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CollectorControlApiClient,
  CollectorUpgradeRequiredError,
  createCollectorControlServer,
} from './control-server.js';
import { COLLECTOR_CONTROL_HTML } from './control-page.js';
import { DeviceTokenStore } from './device-identity.js';
import type { SecretProtector } from './device-identity.js';

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

describe('本地控制页中心 API 客户端', () => {
  it('保存低可信度策略到本机运行时', async () => {
    const configureLowConfidencePolicy = vi.fn().mockResolvedValue({ mode: 'never_pause' });
    const server = createCollectorControlServer({
      apiClient: {} as CollectorControlApiClient,
      profileStore: {} as never,
      runtime: {
        configureLowConfidencePolicy,
        restore: vi.fn().mockResolvedValue(undefined),
      } as never,
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });

    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('测试服务未监听 TCP 端口。');
      const response = await fetch(
        `http://127.0.0.1:${address.port}/control/api/settings/low-confidence`,
        {
          body: JSON.stringify({ mode: 'never_pause' }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        },
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        lowConfidencePolicy: { mode: 'never_pause' },
      });
      expect(configureLowConfidencePolicy).toHaveBeenCalledWith({ mode: 'never_pause' });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it('单字设备名称在本机拦截并显示准确提示', async () => {
    const pair = vi.fn().mockResolvedValue({ deviceId: 'device-1' });
    const server = createCollectorControlServer({
      apiClient: { pair } as unknown as CollectorControlApiClient,
      profileStore: {} as never,
      runtime: {
        assertIdle: vi.fn(),
        restore: vi.fn().mockResolvedValue(undefined),
      } as never,
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });

    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('测试服务未监听 TCP 端口。');
      const response = await fetch(`http://127.0.0.1:${address.port}/control/api/pair`, {
        body: JSON.stringify({ deviceName: '小', pairingCode: 'ABCD-EFGH-IJKL' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        code: 'INVALID_DEVICE_NAME',
        message: '设备名称至少需要 2 个字符。',
      });
      expect(pair).not.toHaveBeenCalled();
      expect(COLLECTOR_CONTROL_HTML).toContain('id="device-name" required minlength="2"');
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it('同步任务不会自动领取或开始，只有显式 start 才依次调用 claim/start', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'douyin-control-client-'));
    temporaryDirectories.push(dataRoot);
    const tokenStore = new DeviceTokenStore(dataRoot, passthroughProtector);
    await tokenStore.save('local-control-device-token-value');
    const requests: Array<{ method: string; url: string }> = [];
    const fetcher = vi.fn().mockImplementation(async (input: URL, init: RequestInit) => {
      requests.push({ method: init.method ?? 'GET', url: input.toString() });
      if (input.pathname.endsWith('/runs')) {
        return {
          json: async () => ({ runs: [{ id: 'run-1', status: 'ready' }] }),
          ok: true,
          status: 200,
        };
      }
      return {
        json: async () => ({
          id: 'run-1',
          status: input.pathname.endsWith('/start') ? 'running' : 'claimed',
        }),
        ok: true,
        status: 200,
      };
    });
    const client = new CollectorControlApiClient('https://ops.example.test', tokenStore, fetcher);

    await expect(client.syncRuns()).resolves.toEqual([{ id: 'run-1', status: 'ready' }]);
    expect(requests).toEqual([{ method: 'GET', url: 'https://ops.example.test/collector/runs' }]);
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({
      'x-collector-protocol-version': '1.0.0',
      'x-collector-version': '0.1.0',
      'x-parser-version': '0.5.0',
    });

    await expect(client.startRun('run-1')).resolves.toMatchObject({ status: 'running' });
    expect(requests.slice(1)).toEqual([
      { method: 'POST', url: 'https://ops.example.test/collector/runs/run-1/claim' },
      { method: 'POST', url: 'https://ops.example.test/collector/runs/run-1/start' },
    ]);
  });

  it('服务端返回 426 后显示最低版本且不再领取任务', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'douyin-control-upgrade-'));
    temporaryDirectories.push(dataRoot);
    const tokenStore = new DeviceTokenStore(dataRoot, passthroughProtector);
    await tokenStore.save('local-control-device-token-value');
    const fetcher = vi.fn().mockResolvedValue({
      json: async () => ({
        code: 'COLLECTOR_UPGRADE_REQUIRED',
        minimumCollectorVersion: '2.4.0',
      }),
      ok: false,
      status: 426,
    });
    const client = new CollectorControlApiClient('https://ops.example.test', tokenStore, fetcher);

    const error = await client.syncRuns().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CollectorUpgradeRequiredError);
    expect(String(error)).toContain('2.4.0');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
