import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CollectorBrowserProfileStore,
  launchSelectedCollectorProfile,
  UnsafeCollectorDataDirectoryError,
} from './browser-profiles.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('独立持久浏览器画像', () => {
  it('两次采集助手启动复用同一个已选画像目录', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'douyin-collector-profiles-'));
    temporaryDirectories.push(dataRoot);
    const firstStore = new CollectorBrowserProfileStore(dataRoot);
    const created = await firstStore.createProfile('校园兴趣画像');
    const launchPersistentContext = vi.fn().mockResolvedValue({ close: vi.fn() });

    await launchSelectedCollectorProfile(firstStore, { launchPersistentContext });
    const secondStore = new CollectorBrowserProfileStore(dataRoot);
    await launchSelectedCollectorProfile(secondStore, { launchPersistentContext });

    expect(launchPersistentContext).toHaveBeenCalledTimes(2);
    expect(launchPersistentContext.mock.calls[0]?.[0]).toBe(created.userDataDir);
    expect(launchPersistentContext.mock.calls[1]?.[0]).toBe(created.userDataDir);
    expect(created.userDataDir).toBe(path.join(dataRoot, 'browser-profiles', created.id));
  });

  it('持久保存画像选择而不是依赖最后创建顺序', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'douyin-collector-selection-'));
    temporaryDirectories.push(dataRoot);
    const store = new CollectorBrowserProfileStore(dataRoot);
    const first = await store.createProfile('圈层 A');
    await store.createProfile('圈层 B');
    await store.selectProfile(first.id);

    expect(await new CollectorBrowserProfileStore(dataRoot).getSelectedProfile()).toEqual(first);
  });

  it.each([
    'C:\\Users\\operator\\AppData\\Local\\Google\\Chrome\\User Data',
    'C:\\Users\\operator\\AppData\\Local\\Microsoft\\Edge\\User Data\\Default',
  ])('拒绝直接读取系统日常浏览器目录 %s', (dailyBrowserDirectory) => {
    expect(() => new CollectorBrowserProfileStore(dailyBrowserDirectory)).toThrowError(
      UnsafeCollectorDataDirectoryError,
    );
  });
});
