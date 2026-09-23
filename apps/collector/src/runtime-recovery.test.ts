import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createDefaultCampaignRuleSet } from '@douyin/contracts';
import type { CampaignRuleSet, CollectorBatch, CollectorRunProgress } from '@douyin/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CollectorRuntime } from './runtime.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

type ProfileOutcome = 'transient' | 'trusted';

function createFeedPage(options?: { transientAfterFirstSafetyCheck?: boolean }) {
  const html = `<article>
    <a href="/video/7800000000000000001" aria-label="恢复测试作品">作品</a>
    <a href="/user/runtime-recovery-creator">恢复测试作者</a>
    <span data-e2e="video-like-count">1.5万</span>
  </article>`;
  let bodyReads = 0;
  let closed = false;
  let recovered = false;
  return {
    bringToFront: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockImplementation(async () => {
      closed = true;
    }),
    evaluate: vi.fn().mockResolvedValue({ moved: false, target: 'document' }),
    goto: vi.fn().mockResolvedValue(undefined),
    isClosed: () => closed,
    locator: (selector: string) =>
      selector === 'body'
        ? {
            innerText: async () => {
              bodyReads += 1;
              return options?.transientAfterFirstSafetyCheck && bodyReads > 1 && !recovered
                ? '服务异常，重新刷新获取数据'
                : '抖音推荐流正常页面';
            },
          }
        : { evaluateAll: async () => html },
    mouse: { wheel: vi.fn().mockResolvedValue(undefined) },
    reload: vi.fn().mockImplementation(async () => {
      recovered = true;
    }),
    title: async () => '抖音精选',
    url: () => 'https://www.douyin.com/',
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
  };
}

function createProfilePage(outcomes: ProfileOutcome[], onTrusted?: () => void) {
  const profileUrl = 'https://www.douyin.com/user/runtime-recovery-creator';
  const profileHtml = `<!doctype html>
    <html lang="zh-CN"><head><title>恢复测试作者的抖音主页</title></head><body>
      <h1 data-e2e="user-title">恢复测试作者</h1>
      <span data-e2e="user-info-fans">粉丝 1200</span>
      <article data-e2e="user-post-item">
        <a href="/video/7800000000000000001">公开作品</a>
        <span data-e2e="video-like-count">1.5万</span>
        <time datetime="2026-09-22T00:00:00.000Z"></time>
      </article>
    </body></html>`;
  let closed = false;
  let current: ProfileOutcome = outcomes[0] ?? 'trusted';
  let navigation = 0;
  return {
    bringToFront: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockImplementation(async () => {
      closed = true;
    }),
    content: vi
      .fn()
      .mockImplementation(async () =>
        current === 'transient'
          ? '<html><body>服务异常，重新刷新获取数据</body></html>'
          : profileHtml,
      ),
    goto: vi.fn().mockImplementation(async () => {
      current = outcomes[Math.min(navigation, outcomes.length - 1)] ?? 'trusted';
      navigation += 1;
      if (current === 'trusted') onTrusted?.();
      return { status: () => (current === 'transient' ? 503 : 200) };
    }),
    isClosed: () => closed,
    locator: () => ({
      innerText: async () =>
        current === 'transient' ? '服务异常，重新刷新获取数据' : '恢复测试作者 粉丝 1200 公开作品',
    }),
    off: vi.fn(),
    on: vi.fn(),
    screenshot: vi.fn().mockResolvedValue(Buffer.from('恢复测试截图')),
    title: async () => (current === 'transient' ? '抖音' : '恢复测试作者的抖音主页'),
    url: () => profileUrl,
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
  };
}

function createContext(
  profilePages: ReturnType<typeof createProfilePage>[],
  feedPage = createFeedPage(),
) {
  let closeListener: (() => void) | undefined;
  const context = {
    close: vi.fn().mockImplementation(async () => {
      closeListener?.();
    }),
    newPage: vi.fn().mockImplementation(async () => {
      const page = profilePages.shift();
      if (!page) throw new Error('测试上下文没有可用的作者页。');
      return page;
    }),
    on: vi.fn(),
    once: vi.fn().mockImplementation((event: string, listener: () => void) => {
      if (event === 'close') closeListener = listener;
    }),
    pages: () => [feedPage],
  };
  return { context, fireUnexpectedClose: () => closeListener?.(), feedPage };
}

async function createRecoveryRuntime(
  contexts: Array<ReturnType<typeof createContext>>,
  options?: {
    recovery?: Record<string, unknown>;
    now?: () => number;
    completeWhen?: (progress: CollectorRunProgress) => boolean;
    onBatch?: () => void;
    rules?: CampaignRuleSet;
    wait?: (milliseconds: number) => Promise<void>;
  },
) {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'douyin-runtime-recovery-'));
  temporaryDirectories.push(dataRoot);
  const runId = '00000000-0000-4000-8000-000000000020';
  if (options?.recovery) {
    const directory = path.join(dataRoot, 'runs');
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, `${createHash('sha256').update(runId).digest('hex')}.json`),
      JSON.stringify({
        runId,
        profileId: 'profile-1',
        progress: {
          candidatesFound: 0,
          creatorProfilesSeen: 0,
          elapsedSeconds: 0,
          feedItemsSeen: 0,
        },
        seenPosts: [],
        seenCreators: [],
        pendingBatch: null,
        screenshot: null,
        message: '',
        lowConfidence: { consecutiveFailures: 0, lastIssue: null, skippedTotal: 0 },
        recovery: options.recovery,
      }),
      'utf8',
    );
  }
  let remoteStatus = 'ready';
  let progressReports = 0;
  const rules = options?.rules ?? createDefaultCampaignRuleSet();
  const changeRunStatus = vi.fn().mockImplementation(async (_id: string, action: string) => {
    remoteStatus = action === 'resume' ? 'running' : action;
    return { id: runId, status: remoteStatus };
  });
  const sendBatch = vi.fn().mockImplementation(async (batch: CollectorBatch) => {
    options?.onBatch?.();
    return {
      duplicateBatch: false,
      idempotencyKey: batch.idempotencyKey,
      results: batch.observations.map((observation) => ({
        observationId: observation.observationId,
        status: 'accepted' as const,
      })),
    };
  });
  const apiClient = {
    changeRunStatus,
    getDevice: vi.fn().mockResolvedValue({
      deviceId: '71000000-0000-4000-8000-000000000020',
      name: '恢复测试设备',
    }),
    reportProgress: vi
      .fn()
      .mockImplementation(async (_id: string, progress: CollectorRunProgress) => {
        progressReports += 1;
        if (options?.completeWhen ? options.completeWhen(progress) : progressReports > 1) {
          remoteStatus = 'completed';
        }
        return { id: runId, status: remoteStatus };
      }),
    sendBatch,
    startRun: vi.fn().mockImplementation(async () => {
      remoteStatus = 'running';
      return { id: runId, status: remoteStatus };
    }),
    syncRuns: vi.fn().mockImplementation(async () => [
      {
        id: runId,
        progress: {
          candidatesFound: 0,
          creatorProfilesSeen: 0,
          elapsedSeconds: 0,
          feedItemsSeen: 0,
        },
        rules,
        status: remoteStatus,
      },
    ]),
  };
  let contextIndex = 0;
  const uploadScreenshot = vi.fn().mockResolvedValue(undefined);
  const runtime = new CollectorRuntime({
    apiClient,
    launchProfile: vi.fn().mockImplementation(async () => {
      const selected = contexts[contextIndex]?.context;
      contextIndex += 1;
      if (!selected) throw new Error('测试没有下一个浏览器上下文。');
      return selected;
    }) as never,
    profileStore: {
      dataRoot,
      getSelectedProfile: vi.fn().mockResolvedValue({ id: 'profile-1', label: '恢复测试画像' }),
    } as never,
    ...(options?.now ? { now: options.now } : {}),
    random: () => 0,
    uploadScreenshot,
    wait: options?.wait ?? (async () => undefined),
  });
  await runtime.configureLowConfidencePolicy({ mode: 'never_pause' });
  return { apiClient, changeRunStatus, dataRoot, runId, runtime, sendBatch, uploadScreenshot };
}

describe('长运行暂时性故障恢复', () => {
  it('假时钟加速 24 小时运行时可跨多次暂时故障且资源有界', async () => {
    let now = Date.parse('2026-09-23T00:00:00.000Z');
    const feedPage = createFeedPage();
    const originalLocator = feedPage.locator;
    let safetyChecks = 0;
    const transientChecks = new Set([3, 8, 13]);
    feedPage.locator = vi.fn((selector: string) => {
      if (selector !== 'body') return originalLocator(selector);
      return {
        innerText: async () => {
          safetyChecks += 1;
          return transientChecks.has(safetyChecks)
            ? '服务异常，重新刷新获取数据'
            : '抖音推荐流正常页面';
        },
      };
    });
    feedPage.waitForTimeout.mockImplementation(async () => {
      now += 3_600_000;
    });
    const context = createContext([createProfilePage(['trusted'])], feedPage);
    const rules = {
      ...createDefaultCampaignRuleSet(),
      stopConditions: { maxDurationMinutes: 1_440 },
    };
    const harness = await createRecoveryRuntime([context], {
      completeWhen: (progress) => progress.elapsedSeconds >= 86_400,
      now: () => now,
      rules,
      wait: async (milliseconds) => {
        now += milliseconds;
      },
    });

    await harness.runtime.start(harness.runId);
    await vi.waitFor(
      () => expect(harness.runtime.status()).resolves.toMatchObject({ activeRunId: null }),
      { timeout: 4_000 },
    );

    await expect(harness.runtime.status()).resolves.toMatchObject({
      lastErrorCode: null,
      message: '已达到停止条件。请到达人库复核本次结果。',
    });
    expect(harness.changeRunStatus).not.toHaveBeenCalledWith(harness.runId, 'pause');
    expect(harness.sendBatch).toHaveBeenCalledOnce();
    expect(harness.uploadScreenshot).toHaveBeenCalledOnce();
    expect(harness.apiClient.startRun).toHaveBeenCalledOnce();
    expect(feedPage.reload).toHaveBeenCalledTimes(3);
    expect(context.context.newPage).toHaveBeenCalledOnce();
    expect(
      harness.runtime.decorateRuns([{ id: harness.runId, status: 'completed' }]),
    ).toMatchObject([
      {
        progress: {
          candidatesFound: 1,
          creatorProfilesSeen: 1,
          elapsedSeconds: expect.any(Number),
          feedItemsSeen: 1,
        },
      },
    ]);
    const decorated = harness.runtime.decorateRuns([{ id: harness.runId, status: 'completed' }]);
    expect(decorated[0]?.progress?.elapsedSeconds).toBeGreaterThanOrEqual(86_400);
    const checkpointFiles = await readdir(path.join(harness.dataRoot, 'runs'));
    expect(checkpointFiles).toHaveLength(1);
    expect(
      (await stat(path.join(harness.dataRoot, 'runs', checkpointFiles[0]!))).size,
    ).toBeLessThan(1_024 * 1_024);
    const diagnosticFiles = await readdir(path.join(harness.dataRoot, 'diagnostics'));
    expect(diagnosticFiles.length).toBeLessThanOrEqual(3);
    for (const file of diagnosticFiles) {
      expect(
        (await stat(path.join(harness.dataRoot, 'diagnostics', file))).size,
      ).toBeLessThanOrEqual(1_024 * 1_024);
    }
  });

  it('推荐页首次服务异常通过重载恢复且不重复同步', async () => {
    const feedPage = createFeedPage({ transientAfterFirstSafetyCheck: true });
    const context = createContext([createProfilePage(['trusted'])], feedPage);
    const harness = await createRecoveryRuntime([context]);

    await harness.runtime.start(harness.runId);
    await vi.waitFor(() =>
      expect(harness.runtime.status()).resolves.toMatchObject({ activeRunId: null }),
    );

    expect(feedPage.reload).toHaveBeenCalledOnce();
    expect(harness.sendBatch).toHaveBeenCalledOnce();
    expect(harness.changeRunStatus).not.toHaveBeenCalledWith(harness.runId, 'pause');
    await expect(harness.runtime.status()).resolves.toMatchObject({
      recovery: { lastResult: 'recovered', pageType: 'feed', stage: 'reload_page' },
    });
  });

  it.each([
    {
      contexts: () => [createContext([createProfilePage(['transient', 'trusted'])])],
      expectedContexts: 1,
      stage: 'reload_page',
    },
    {
      contexts: () => [
        createContext([
          createProfilePage(['transient', 'transient']),
          createProfilePage(['trusted']),
        ]),
      ],
      expectedContexts: 1,
      stage: 'recreate_profile_page',
    },
    {
      contexts: () => [
        createContext([
          createProfilePage(['transient', 'transient']),
          createProfilePage(['transient']),
        ]),
        createContext([createProfilePage(['trusted'])]),
      ],
      expectedContexts: 2,
      stage: 'restart_browser',
    },
  ])('在 $stage 首次成功后继续同一作者且不暂停', async (example) => {
    const contexts = example.contexts();
    const { changeRunStatus, runId, runtime, sendBatch, uploadScreenshot } =
      await createRecoveryRuntime(contexts);

    await runtime.start(runId);
    await vi.waitFor(() => expect(runtime.status()).resolves.toMatchObject({ activeRunId: null }));

    expect(changeRunStatus).not.toHaveBeenCalledWith(runId, 'pause');
    expect(sendBatch).toHaveBeenCalledOnce();
    expect(uploadScreenshot).toHaveBeenCalledOnce();
    expect(contexts.filter((entry) => entry.context.newPage.mock.calls.length > 0)).toHaveLength(
      example.expectedContexts,
    );
    await expect(runtime.status()).resolves.toMatchObject({
      recovery: { lastResult: 'recovered', stage: example.stage },
    });
    expect(runtime.decorateRuns([{ id: runId, status: 'completed' }])).toMatchObject([
      {
        progress: { candidatesFound: 1, creatorProfilesSeen: 1, feedItemsSeen: 1 },
      },
    ]);
  });

  it('人工暂停会取消五分钟退避且只发送一次暂停', async () => {
    const now = Date.parse('2026-09-23T03:00:00.000Z');
    const context = createContext([
      createProfilePage(['transient', 'transient']),
      createProfilePage(['transient']),
    ]);
    const runtimeReference: { current?: CollectorRuntime } = {};
    let pausePromise: Promise<void> | undefined;
    let waits = 0;
    const harness = await createRecoveryRuntime([context], {
      now: () => now,
      recovery: {
        attemptCount: 2,
        circuitBreakerCount: 0,
        contextRestartTimestamps: [],
        eventStartedAt: new Date(now - 30_000).toISOString(),
        issueCode: 'transient_page_failure',
        lastRecoveredAt: new Date(now - 10_000).toISOString(),
        lastResult: 'recovered',
        nextAttemptAt: null,
        pageType: 'profile',
        stage: 'recreate_profile_page',
      },
      wait: async () => {
        waits += 1;
        if (waits === 1) pausePromise = runtimeReference.current!.control(harness.runId, 'pause');
      },
    });
    const runtime = harness.runtime;
    runtimeReference.current = runtime;

    await runtime.start(harness.runId);
    await vi.waitFor(() => expect(pausePromise).toBeDefined());
    await pausePromise;

    expect(waits).toBe(1);
    expect(
      harness.changeRunStatus.mock.calls.filter(([, action]) => action === 'pause'),
    ).toHaveLength(1);
    await expect(runtime.status()).resolves.toMatchObject({
      activeRunId: null,
      recovery: { lastResult: 'cancelled', nextAttemptAt: null, stage: 'restart_browser' },
    });
  });

  it('计划内上下文重启及旧代际迟到 close 不会停止新代际', async () => {
    const oldContext = createContext([
      createProfilePage(['transient', 'transient']),
      createProfilePage(['transient']),
    ]);
    oldContext.context.close.mockImplementation(async () => undefined);
    const newProfilePage = createProfilePage(['trusted'], () => oldContext.fireUnexpectedClose());
    const newContext = createContext([newProfilePage]);
    const harness = await createRecoveryRuntime([oldContext, newContext]);

    await harness.runtime.start(harness.runId);
    await vi.waitFor(() =>
      expect(harness.runtime.status()).resolves.toMatchObject({ activeRunId: null }),
    );

    expect(harness.sendBatch).toHaveBeenCalledOnce();
    expect(harness.changeRunStatus).not.toHaveBeenCalledWith(harness.runId, 'pause');
    expect(oldContext.context.close).toHaveBeenCalledOnce();
    expect(newContext.context.close).not.toHaveBeenCalled();
  });

  it('运营人员关闭当前浏览器会暂停运行', async () => {
    const context = createContext([createProfilePage(['trusted'])]);
    const harness = await createRecoveryRuntime([context], {
      onBatch: () => context.fireUnexpectedClose(),
    });

    await harness.runtime.start(harness.runId);
    await vi.waitFor(() =>
      expect(harness.changeRunStatus).toHaveBeenCalledWith(harness.runId, 'pause'),
    );

    await expect(harness.runtime.status()).resolves.toMatchObject({
      activeRunId: null,
      browserOpen: false,
    });
    expect(harness.sendBatch).toHaveBeenCalledOnce();
  });

  it('两分钟内复发直接升级且一小时第三次上下文恢复只暂停一次', async () => {
    const now = Date.parse('2026-09-23T02:00:00.000Z');
    const context = createContext([createProfilePage(['transient'])]);
    const harness = await createRecoveryRuntime([context], {
      now: () => now,
      recovery: {
        attemptCount: 3,
        circuitBreakerCount: 2,
        contextRestartTimestamps: [
          new Date(now - 60_000).toISOString(),
          new Date(now - 30_000).toISOString(),
        ],
        eventStartedAt: new Date(now - 40_000).toISOString(),
        issueCode: 'transient_page_failure',
        lastRecoveredAt: new Date(now - 10_000).toISOString(),
        lastResult: 'recovered',
        nextAttemptAt: null,
        pageType: 'profile',
        stage: 'restart_browser',
      },
    });

    await harness.runtime.start(harness.runId);
    await vi.waitFor(() =>
      expect(harness.changeRunStatus).toHaveBeenCalledWith(harness.runId, 'pause'),
    );

    expect(
      harness.changeRunStatus.mock.calls.filter(([, action]) => action === 'pause'),
    ).toHaveLength(1);
    expect(harness.sendBatch).not.toHaveBeenCalled();
    expect(context.context.close).not.toHaveBeenCalled();
    await expect(harness.runtime.status()).resolves.toMatchObject({
      recovery: {
        circuitBreakerCount: 3,
        lastResult: 'exhausted',
        stage: 'circuit_open',
      },
    });
  });

  it('三级恢复都失败后以可理解消息暂停且不写入观察', async () => {
    const firstContext = createContext([
      createProfilePage(['transient', 'transient']),
      createProfilePage(['transient']),
    ]);
    const secondContext = createContext([createProfilePage(['transient'])]);
    const harness = await createRecoveryRuntime([firstContext, secondContext]);

    await harness.runtime.start(harness.runId);
    await vi.waitFor(() =>
      expect(harness.changeRunStatus).toHaveBeenCalledWith(harness.runId, 'pause'),
    );

    expect(harness.sendBatch).not.toHaveBeenCalled();
    await expect(harness.runtime.status()).resolves.toMatchObject({
      message: expect.stringContaining('恢复预算已耗尽'),
      recovery: { lastResult: 'exhausted', stage: 'restart_browser' },
    });
  });
});
