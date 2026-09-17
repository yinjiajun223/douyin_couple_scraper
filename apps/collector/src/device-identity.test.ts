import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CollectorPairingError,
  DeviceTokenStore,
  pairAndStoreCollectorDevice,
  redactCollectorSecrets,
  WindowsDpapiProtector,
} from './device-identity.js';
import type { SecretProtector } from './device-identity.js';

const temporaryDirectories: string[] = [];

const testProtector: SecretProtector = {
  protect: async (plaintext) => Buffer.from(`protected:${plaintext.toString('base64')}`, 'utf8'),
  unprotect: async (ciphertext) => {
    const encoded = ciphertext.toString('utf8').replace(/^protected:/u, '');
    return Buffer.from(encoded, 'base64');
  },
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('采集器设备身份', () => {
  it.runIf(process.platform === 'win32')('使用 Windows 当前用户 DPAPI 往返加解密', async () => {
    const protector = new WindowsDpapiProtector();
    const plaintext = Buffer.from('local-device-token-round-trip', 'utf8');
    const ciphertext = await protector.protect(plaintext);

    expect(ciphertext.equals(plaintext)).toBe(false);
    await expect(protector.unprotect(ciphertext)).resolves.toEqual(plaintext);
  });

  it('配对后只返回设备 ID，并加密保存令牌', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'douyin-device-token-'));
    temporaryDirectories.push(dataRoot);
    const tokenStore = new DeviceTokenStore(dataRoot, testProtector);
    const secretToken = 'device-secret-token-that-must-never-leak';
    const fetcher = vi.fn().mockResolvedValue({
      json: async () => ({ deviceId: 'device-1', token: secretToken }),
      ok: true,
      status: 201,
    });

    await expect(
      pairAndStoreCollectorDevice(
        {
          apiBaseUrl: 'https://ops.example.test',
          collectorVersion: '1.0.0',
          deviceName: '运营电脑',
          pairingCode: 'PAIR-1234',
          parserVersion: '1.0.0',
        },
        tokenStore,
        fetcher,
      ),
    ).resolves.toEqual({ deviceId: 'device-1' });
    expect(await tokenStore.load()).toBe(secretToken);
    expect(
      (await readFile(path.join(dataRoot, 'secrets', 'device-token.dpapi'))).toString('utf8'),
    ).not.toContain(secretToken);
  });

  it('错误对象和普通诊断输出不会出现完整令牌、配对码或授权头', () => {
    const secretToken = 'device-secret-token-that-must-never-leak';
    const diagnostic = redactCollectorSecrets(
      {
        authorization: `Bearer ${secretToken}`,
        error: `request failed for ${secretToken}`,
        nested: { pairingCode: 'PAIR-1234', reason: 'timeout' },
      },
      [secretToken],
    );

    expect(JSON.stringify(diagnostic)).not.toContain(secretToken);
    expect(JSON.stringify(diagnostic)).not.toContain('PAIR-1234');
    expect(diagnostic).toMatchObject({
      authorization: '[REDACTED]',
      error: 'request failed for [REDACTED]',
      nested: { pairingCode: '[REDACTED]', reason: 'timeout' },
    });
  });

  it('配对失败只暴露状态码，不复制可能含秘密的响应体', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'douyin-device-error-'));
    temporaryDirectories.push(dataRoot);
    const fetcher = vi.fn().mockResolvedValue({
      json: async () => ({ message: 'server accidentally returned secret-token' }),
      ok: false,
      status: 401,
    });

    const error = await pairAndStoreCollectorDevice(
      {
        apiBaseUrl: 'https://ops.example.test',
        collectorVersion: '1.0.0',
        deviceName: '运营电脑',
        pairingCode: 'PAIR-SECRET',
        parserVersion: '1.0.0',
      },
      new DeviceTokenStore(dataRoot, testProtector),
      fetcher,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CollectorPairingError);
    expect(String(error)).toBe(
      'CollectorPairingError: Collector pairing failed with HTTP status 401.',
    );
    expect(String(error)).not.toContain('secret-token');
    expect(String(error)).not.toContain('PAIR-SECRET');
  });
});
