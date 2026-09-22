import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createDefaultCampaignRuleSet } from '@douyin/contracts';
import type { CollectorBatch } from '@douyin/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { UploadScreenshotInput } from './media-upload.js';
import { CollectorRuntime } from './runtime.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('本地采集运行设置', () => {
  it('默认永不因低可信度暂停，并持久保存用户选择', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'douyin-runtime-settings-'));
    temporaryDirectories.push(dataRoot);
    const createRuntime = () =>
      new CollectorRuntime({
        apiClient: {} as never,
        profileStore: { dataRoot } as never,
        uploadScreenshot: async () => undefined,
      });

    const firstRuntime = createRuntime();
    await firstRuntime.restore();
    await expect(firstRuntime.status()).resolves.toMatchObject({
      lowConfidencePolicy: { mode: 'never_pause' },
    });
    Reflect.set(firstRuntime, 'activeRunId', '00000000-0000-4000-8000-000000000099');
    await firstRuntime.configureLowConfidencePolicy({
      consecutiveLimit: 5,
      mode: 'pause_after_consecutive',
    });

    const restoredRuntime = createRuntime();
    await restoredRuntime.restore();
    await expect(restoredRuntime.status()).resolves.toMatchObject({
      lowConfidencePolicy: { consecutiveLimit: 5, mode: 'pause_after_consecutive' },
    });
  });

  it('连续作者复用同一核验页并自动置前，人工关闭后才重建', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'douyin-runtime-skip-'));
    temporaryDirectories.push(dataRoot);
    const runId = '00000000-0000-4000-8000-000000000001';
    const rules = createDefaultCampaignRuleSet();
    let remoteStatus = 'ready';
    let profileUrl = 'https://www.douyin.com/user/creator-low';
    const feedHtml = `<article>
        <a href="/video/1234567890" aria-label="低可信度样例一">作品一</a>
        <a href="/user/creator-low-one">样例作者一</a>
        <span data-e2e="video-like-count">2.3万</span>
      </article>
      <article>
        <a href="/video/1234567891" aria-label="低可信度样例二">作品二</a>
        <a href="/user/creator-low-two">样例作者二</a>
        <span data-e2e="video-like-count">2.1万</span>
      </article>
      <article>
        <a href="/video/1234567892" aria-label="低可信度样例三">作品三</a>
        <a href="/user/creator-low-three">样例作者三</a>
        <span data-e2e="video-like-count">2万</span>
      </article>`;
    const feedPage = {
      bringToFront: vi.fn().mockResolvedValue(undefined),
      goto: vi.fn().mockResolvedValue(undefined),
      isClosed: () => false,
      locator: (selector: string) =>
        selector === 'body'
          ? { innerText: async () => '抖音推荐流正常页面' }
          : { evaluateAll: async () => feedHtml },
      mouse: { wheel: vi.fn().mockResolvedValue(undefined) },
      title: async () => '抖音精选',
      url: () => 'https://www.douyin.com/',
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    };
    const createProfilePage = () => ({
      bringToFront: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      content: async () => '<html><body><main>公开主页内容尚未完整加载</main></body></html>',
      goto: vi.fn().mockImplementation(async (url: string) => {
        profileUrl = url;
      }),
      isClosed: vi.fn().mockReturnValue(false),
      locator: () => ({ innerText: async () => '公开主页内容尚未完整加载' }),
      off: vi.fn(),
      on: vi.fn(),
      screenshot: vi.fn(),
      title: async () => '作者主页',
      url: () => profileUrl,
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    });
    const profilePage = createProfilePage();
    profilePage.isClosed
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const replacementProfilePage = createProfilePage();
    const browserContext = {
      close: vi.fn().mockResolvedValue(undefined),
      newPage: vi
        .fn()
        .mockResolvedValueOnce(profilePage)
        .mockResolvedValueOnce(replacementProfilePage),
      on: vi.fn(),
      once: vi.fn(),
      pages: () => [feedPage],
    };
    let progressReports = 0;
    const sendBatch = vi.fn();
    const reportProgress = vi.fn().mockImplementation(async () => {
      progressReports += 1;
      if (progressReports > 3) remoteStatus = 'completed';
      return { id: runId, status: remoteStatus };
    });
    const apiClient = {
      changeRunStatus: vi.fn().mockImplementation(async (_id: string, action: string) => {
        remoteStatus = action === 'resume' ? 'running' : action;
        return { id: runId, status: remoteStatus };
      }),
      getDevice: vi.fn().mockResolvedValue({ deviceId: 'device-1', name: '测试设备' }),
      reportProgress,
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
    const uploadScreenshot = vi.fn();
    const runtime = new CollectorRuntime({
      apiClient,
      launchProfile: vi.fn().mockResolvedValue(browserContext) as never,
      profileStore: {
        dataRoot,
        getSelectedProfile: vi.fn().mockResolvedValue({ id: 'profile-1', label: '校园圈层' }),
      } as never,
      uploadScreenshot,
    });
    await runtime.configureLowConfidencePolicy({ mode: 'never_pause' });

    await runtime.start(runId);
    await vi.waitFor(() => expect(reportProgress).toHaveBeenCalledTimes(4), { timeout: 4_000 });

    expect(sendBatch).not.toHaveBeenCalled();
    expect(uploadScreenshot).not.toHaveBeenCalled();
    expect(profilePage.screenshot).not.toHaveBeenCalled();
    expect(replacementProfilePage.screenshot).not.toHaveBeenCalled();
    expect(browserContext.newPage).toHaveBeenCalledTimes(2);
    expect(profilePage.goto.mock.calls.map(([url]) => url)).toEqual([
      'https://www.douyin.com/user/creator-low-one',
      'https://www.douyin.com/user/creator-low-two',
    ]);
    expect(profilePage.bringToFront).toHaveBeenCalledTimes(2);
    expect(profilePage.close).not.toHaveBeenCalled();
    expect(replacementProfilePage.goto.mock.calls.map(([url]) => url)).toEqual([
      'https://www.douyin.com/user/creator-low-three',
    ]);
    expect(replacementProfilePage.bringToFront).toHaveBeenCalledOnce();
    expect(replacementProfilePage.close).not.toHaveBeenCalled();
    expect(runtime.decorateRuns([{ id: runId, status: 'completed' }])).toMatchObject([
      {
        lowConfidenceDiagnostics: {
          consecutiveFailures: 3,
          skippedTotal: 3,
        },
        progress: {
          candidatesFound: 0,
          creatorProfilesSeen: 3,
          feedItemsSeen: 3,
        },
      },
    ]);
  });

  it('永不暂停模式连续未识别新作品时自动恢复并继续到服务端停止条件', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'douyin-runtime-empty-feed-'));
    temporaryDirectories.push(dataRoot);
    const runId = '00000000-0000-4000-8000-000000000002';
    const rules = createDefaultCampaignRuleSet();
    let remoteStatus = 'ready';
    const feedPage = {
      bringToFront: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockResolvedValue({ moved: false, target: 'document' }),
      goto: vi.fn().mockResolvedValue(undefined),
      isClosed: () => false,
      locator: (selector: string) =>
        selector === 'body'
          ? { innerText: async () => '抖音推荐流正常页面' }
          : { evaluateAll: async () => '' },
      mouse: { wheel: vi.fn().mockResolvedValue(undefined) },
      reload: vi.fn().mockResolvedValue(undefined),
      title: async () => '抖音精选',
      url: () => 'https://www.douyin.com/',
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    };
    const browserContext = {
      close: vi.fn().mockResolvedValue(undefined),
      newPage: vi.fn().mockResolvedValue({ isClosed: () => false }),
      on: vi.fn(),
      once: vi.fn(),
      pages: () => [feedPage],
    };
    let progressReports = 0;
    const reportProgress = vi.fn().mockImplementation(async () => {
      progressReports += 1;
      if (progressReports >= 58) remoteStatus = 'completed';
      return { id: runId, status: remoteStatus };
    });
    const changeRunStatus = vi.fn().mockImplementation(async (_id: string, action: string) => {
      remoteStatus = action === 'resume' ? 'running' : action;
      return { id: runId, status: remoteStatus };
    });
    const runtime = new CollectorRuntime({
      apiClient: {
        changeRunStatus,
        getDevice: vi.fn().mockResolvedValue({ deviceId: 'device-1', name: '测试设备' }),
        reportProgress,
        sendBatch: vi.fn(),
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
      },
      launchProfile: vi.fn().mockResolvedValue(browserContext) as never,
      profileStore: {
        dataRoot,
        getSelectedProfile: vi.fn().mockResolvedValue({ id: 'profile-1', label: '校园圈层' }),
      } as never,
      uploadScreenshot: vi.fn(),
    });
    await runtime.configureLowConfidencePolicy({ mode: 'never_pause' });

    await runtime.start(runId);
    await vi.waitFor(() => expect(reportProgress).toHaveBeenCalledTimes(58));
    await vi.waitFor(() => expect(runtime.status()).resolves.toMatchObject({ activeRunId: null }));

    expect(changeRunStatus).not.toHaveBeenCalledWith(runId, 'pause');
    expect(feedPage.evaluate).toHaveBeenCalledTimes(57);
    expect(feedPage.reload).toHaveBeenCalledTimes(3);
    expect(feedPage.reload).toHaveBeenLastCalledWith({
      timeout: 30_000,
      waitUntil: 'domcontentloaded',
    });
    await expect(runtime.status()).resolves.toMatchObject({
      message: expect.stringContaining('已达到停止条件'),
    });
  });

  it('只有硬筛通过的达人才采集截图，fail 与 unknown 的观测照常入队', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'douyin-runtime-evidence-'));
    temporaryDirectories.push(dataRoot);
    const runId = '00000000-0000-4000-8000-000000000003';
    const rules = createDefaultCampaignRuleSet();
    let remoteStatus = 'ready';
    // 三个达人分别落在硬筛的三种结论上：粉丝在范围内且近 15 天有达标作品是 pass，
    // 粉丝超出 0–5000 是 fail，粉丝在范围内但没有达标作品是 unknown
    // （采集端 postsWindowComplete 恒为 false，证据不足只会判 unknown，不会判 fail）。
    // 三者都带粉丝数，解析可信度均为 1.0，不会走低可信度跳过分支。
    const publishedRecently = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const creators = [
      {
        followers: '1200',
        likeCount: '1.2万',
        nickname: '证据样例一',
        slug: 'creator-evidence-pass',
        videoId: '7700000000000000001',
      },
      {
        followers: '7000',
        likeCount: '1.5万',
        nickname: '证据样例二',
        slug: 'creator-evidence-fail',
        videoId: '7700000000000000002',
      },
      {
        followers: '1300',
        likeCount: '2000',
        nickname: '证据样例三',
        slug: 'creator-evidence-quiet',
        videoId: '7700000000000000003',
      },
    ];
    const feedHtml = creators
      .map(
        (creator) => `<article>
        <a href="/video/${creator.videoId}" aria-label="${creator.nickname}的作品">作品</a>
        <a href="/user/${creator.slug}">${creator.nickname}</a>
        <span data-e2e="video-like-count">${creator.likeCount}</span>
      </article>`,
      )
      .join('\n');
    const profileHtmlBySlug = new Map(
      creators.map((creator) => [
        creator.slug,
        `<!doctype html>
      <html lang="zh-CN">
        <head><title>${creator.nickname}的抖音主页</title></head>
        <body>
          <h1 data-e2e="user-title">${creator.nickname}</h1>
          <p data-e2e="user-desc">校园日常</p>
          <span data-e2e="user-info-fans">粉丝 ${creator.followers}</span>
          <article data-e2e="user-post-item">
            <a href="/video/${creator.videoId}" aria-label="${creator.nickname}的作品">公开作品</a>
            <span data-e2e="video-like-count">${creator.likeCount}</span>
            <time datetime="${publishedRecently}"></time>
          </article>
        </body>
      </html>`,
      ]),
    );
    const feedPage = {
      bringToFront: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockResolvedValue({ moved: false, target: 'document' }),
      goto: vi.fn().mockResolvedValue(undefined),
      isClosed: () => false,
      locator: (selector: string) =>
        selector === 'body'
          ? { innerText: async () => '抖音推荐流正常页面' }
          : { evaluateAll: async () => feedHtml },
      mouse: { wheel: vi.fn().mockResolvedValue(undefined) },
      reload: vi.fn().mockResolvedValue(undefined),
      title: async () => '抖音精选',
      url: () => 'https://www.douyin.com/',
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    };
    let profileUrl = 'https://www.douyin.com/';
    let currentProfileHtml = '';
    const profilePage = {
      bringToFront: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      content: vi.fn().mockImplementation(async () => currentProfileHtml),
      goto: vi.fn().mockImplementation(async (url: string) => {
        profileUrl = url;
        currentProfileHtml = profileHtmlBySlug.get(url.split('/').at(-1) ?? '') ?? '';
      }),
      isClosed: () => false,
      locator: () => ({ innerText: async () => '公开主页内容完整' }),
      off: vi.fn(),
      on: vi.fn(),
      screenshot: vi.fn().mockResolvedValue(Buffer.from('只有通过的达人才需要证据')),
      title: async () => '作者主页',
      url: () => profileUrl,
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    };
    const browserContext = {
      close: vi.fn().mockResolvedValue(undefined),
      newPage: vi.fn().mockResolvedValue(profilePage),
      on: vi.fn(),
      once: vi.fn(),
      pages: () => [feedPage],
    };
    let progressReports = 0;
    const sendBatch = vi.fn().mockImplementation(async (batch: CollectorBatch) => ({
      duplicateBatch: false,
      idempotencyKey: batch.idempotencyKey,
      results: batch.observations.map((observation) => ({
        observationId: observation.observationId,
        status: 'accepted' as const,
      })),
    }));
    const reportProgress = vi.fn().mockImplementation(async () => {
      progressReports += 1;
      if (progressReports > 3) remoteStatus = 'completed';
      return { id: runId, status: remoteStatus };
    });
    const uploads: Array<Omit<UploadScreenshotInput, 'apiBaseUrl'>> = [];
    const uploadScreenshot = vi
      .fn()
      .mockImplementation(async (input: Omit<UploadScreenshotInput, 'apiBaseUrl'>) => {
        uploads.push(input);
      });
    const runtime = new CollectorRuntime({
      apiClient: {
        changeRunStatus: vi.fn().mockImplementation(async (_id: string, action: string) => {
          remoteStatus = action === 'resume' ? 'running' : action;
          return { id: runId, status: remoteStatus };
        }),
        getDevice: vi.fn().mockResolvedValue({
          deviceId: '71000000-0000-4000-8000-000000000010',
          name: '测试设备',
        }),
        reportProgress,
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
      },
      launchProfile: vi.fn().mockResolvedValue(browserContext) as never,
      profileStore: {
        dataRoot,
        getSelectedProfile: vi.fn().mockResolvedValue({ id: 'profile-1', label: '校园圈层' }),
      } as never,
      uploadScreenshot,
    });
    await runtime.configureLowConfidencePolicy({ mode: 'never_pause' });

    await runtime.start(runId);
    await vi.waitFor(() => expect(reportProgress).toHaveBeenCalledTimes(4), { timeout: 4_000 });

    const batches = sendBatch.mock.calls.map(([batch]) => batch);
    expect(batches.map((batch) => batch.observations[0]?.followerCount)).toEqual([
      1200, 7000, 1300,
    ]);
    const passObservationId = batches.find((batch) => batch.observations[0]?.followerCount === 1200)
      ?.observations[0]?.observationId;
    expect(passObservationId).toBeDefined();
    expect(profilePage.screenshot).toHaveBeenCalledOnce();
    expect(profilePage.screenshot).toHaveBeenCalledWith({
      fullPage: false,
      quality: 75,
      type: 'jpeg',
    });
    expect(uploads.map((upload) => upload.observation.creatorObservationId)).toEqual([
      passObservationId,
    ]);
    expect(uploads[0]).toMatchObject({
      mimeType: 'image/jpeg',
      purpose: 'profile_screenshot',
      runId,
    });
    expect(uploads[0]?.bytes.toString('utf8')).toBe('只有通过的达人才需要证据');
    expect(runtime.decorateRuns([{ id: runId, status: 'completed' }])).toMatchObject([
      {
        lowConfidenceDiagnostics: {
          consecutiveFailures: 0,
          skippedTotal: 0,
        },
        progress: {
          candidatesFound: 1,
          creatorProfilesSeen: 3,
          feedItemsSeen: 3,
        },
      },
    ]);
  });
});
