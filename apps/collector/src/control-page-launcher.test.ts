import type { spawn } from 'node:child_process';

import { describe, expect, it, vi } from 'vitest';

import { openCollectorControlPage } from './control-page-launcher.js';

describe('本机控制页启动', () => {
  it.each([
    ['win32', 'explorer.exe'],
    ['darwin', 'open'],
  ] as const)('服务监听后在 %s 打开默认浏览器', (platform, expectedCommand) => {
    const child = {
      once: vi.fn().mockReturnThis(),
      unref: vi.fn(),
    };
    const spawnProcess = vi.fn().mockReturnValue(child) as unknown as typeof spawn;

    expect(openCollectorControlPage('http://127.0.0.1:43127', platform, spawnProcess)).toBe(true);
    expect(spawnProcess).toHaveBeenCalledWith(expectedCommand, ['http://127.0.0.1:43127'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    expect(child.once).toHaveBeenCalledWith('error', expect.any(Function));
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it('不在未支持的平台尝试打开浏览器', () => {
    const spawnProcess = vi.fn() as unknown as typeof spawn;

    expect(openCollectorControlPage('http://127.0.0.1:43127', 'linux', spawnProcess)).toBe(false);
    expect(spawnProcess).not.toHaveBeenCalled();
  });
});
