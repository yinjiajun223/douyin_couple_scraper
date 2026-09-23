import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  COLLECTOR_PROTOCOL_VERSION,
  collectorBatchSchema,
  parseCampaignRuleSet,
} from '@douyin/contracts';
import type { CollectorBatch, CollectorRunProgress } from '@douyin/contracts';
import { determineRunStopReason, evaluateHardFilters } from '@douyin/domain/collector';
import {
  DOUYIN_FEED_CARD_SELECTORS,
  DOUYIN_PARSER_VERSION,
  extractDouyinFeedItemsFromModuleFeed,
} from '@douyin/platform-douyin';
import type { DouyinFeedItem } from '@douyin/platform-douyin';
import type { BrowserContext, Page, Response as PlaywrightResponse } from 'playwright';

import { launchSelectedCollectorProfile } from './browser-profiles.js';
import type { CollectorBrowserProfileStore } from './browser-profiles.js';
import type { CollectorControlApiClient, RemoteRun } from './control-server.js';
import { PersistentIngestionQueue } from './ingestion-queue.js';
import type { UploadScreenshotInput } from './media-upload.js';
import { inspectDouyinCreatorProfile } from './profile-inspection.js';
import { DouyinProfileSafetyError } from './profile-inspection.js';
import type { DouyinProfileInspection } from './profile-inspection.js';
import { collectVisibleRecommendationFeed } from './recommendation-feed.js';
import {
  createIdleRecoveryCheckpoint,
  normalizeRecoveryCheckpoint,
  RECOVERY_STEPS,
  recordContextRestart,
  recoveryDelayMs,
  recoveryStartIndex,
} from './recovery-controller.js';
import type { RecoveryCheckpoint } from './recovery-controller.js';
import { RecoveryEventLog } from './recovery-log.js';
import {
  decideLowConfidenceAction,
  DEFAULT_LOW_CONFIDENCE_POLICY,
  detectCollectionSafetyIssue,
  parseLowConfidencePolicy,
  updateLowConfidenceConsecutiveFailures,
} from './safety-gate.js';
import type { CollectionSafetyIssue, LowConfidencePolicy } from './safety-gate.js';
import { COLLECTOR_VERSION } from './version.js';

const EMPTY_FEED_RECOVERY_INITIAL_PASSES = 8;
const EMPTY_FEED_RECOVERY_MAX_INTERVAL = 64;

interface Checkpoint {
  runId: string;
  profileId: string;
  progress: CollectorRunProgress;
  seenPosts: string[];
  seenCreators: string[];
  pendingBatch: CollectorBatch | null;
  screenshot: string | null;
  message: string;
  lowConfidence: {
    consecutiveFailures: number;
    lastIssue: {
      detectedAt: string;
      missingFields: string[];
      parserConfidence: number;
      profileUrl: string;
    } | null;
    skippedTotal: number;
  };
  recovery?: RecoveryCheckpoint;
}

type RuntimeApi = Pick<
  CollectorControlApiClient,
  'syncRuns' | 'startRun' | 'changeRunStatus' | 'getDevice' | 'sendBatch' | 'reportProgress'
>;

export interface CollectorRuntimeOptions {
  apiClient: RuntimeApi;
  profileStore: CollectorBrowserProfileStore;
  uploadScreenshot: (input: Omit<UploadScreenshotInput, 'apiBaseUrl'>) => Promise<unknown>;
  launchProfile?: typeof launchSelectedCollectorProfile;
  now?: () => number;
  random?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
}

/** One visible browser and one locally authorized run at a time. No polling starts browsing. */
export class CollectorRuntime {
  private context: BrowserContext | null = null;
  private feedPage: Page | null = null;
  private profilePage: Page | null = null;
  private activeRunId: string | null = null;
  private busy = false;
  private lastErrorCode: string | null = null;
  private stopped = false;
  private work: Promise<void> | null = null;
  private checkpoint: Checkpoint | null = null;
  private readonly queue: PersistentIngestionQueue;
  private readonly directory: string;
  private readonly settingsPath: string;
  private readonly moduleFeedItems = new Map<string, DouyinFeedItem>();
  private lowConfidencePolicy: LowConfidencePolicy = { ...DEFAULT_LOW_CONFIDENCE_POLICY };
  private restoring: Promise<void> | null = null;
  private contextGeneration = 0;
  private readonly plannedContextClosures = new Set<number>();
  private readonly recoveryLog: RecoveryEventLog;
  private lastRecoveryLogFingerprint: string | null = null;

  public constructor(private readonly options: CollectorRuntimeOptions) {
    this.directory = path.join(options.profileStore.dataRoot, 'runs');
    this.settingsPath = path.join(options.profileStore.dataRoot, 'collector-settings.json');
    this.queue = new PersistentIngestionQueue(options.profileStore.dataRoot);
    this.recoveryLog = new RecoveryEventLog(options.profileStore.dataRoot);
  }

  public assertIdle(): void {
    if (this.busy || this.activeRunId) throw new Error('已有运行在执行，请先暂停或终止后再操作。');
    if (this.checkpoint?.pendingBatch)
      throw new Error('有待同步证据，请先继续原运行完成同步，再切换画像或设备。');
  }

  public restore(): Promise<void> {
    this.restoring ??= this.restorePendingCheckpoint();
    return this.restoring;
  }

  private async restorePendingCheckpoint(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await this.restoreSettings();
    for (const name of await readdir(this.directory)) {
      if (!/^[a-f0-9]{64}\.json$/u.test(name)) continue;
      const state = JSON.parse(
        await readFile(path.join(this.directory, name), 'utf8'),
      ) as Checkpoint;
      if (state.pendingBatch) {
        collectorBatchSchema.parse(state.pendingBatch);
        this.checkpoint = this.normalizeCheckpoint(state);
        return;
      }
    }
  }

  public async status() {
    return {
      lastErrorCode: this.lastErrorCode,
      activeRunId: this.activeRunId,
      busy: this.busy,
      browserOpen: Boolean(this.context),
      message: this.checkpoint?.message ?? '',
      lowConfidencePolicy: this.lowConfidencePolicy,
      recovery: this.checkpoint?.recovery ?? createIdleRecoveryCheckpoint(),
      pendingBatches: (await this.queue.listPending()).length,
      pendingEvidence: Boolean(this.checkpoint?.screenshot),
    };
  }

  public decorateRuns(runs: RemoteRun[]) {
    return runs.map((run) => ({
      ...run,
      ...(this.checkpoint?.runId === run.id
        ? {
            progress: this.checkpoint.progress,
            localMessage: this.checkpoint.message,
            lowConfidenceDiagnostics: this.checkpoint.lowConfidence,
            recoveryDiagnostics: this.checkpoint.recovery ?? createIdleRecoveryCheckpoint(),
            localPaused: this.activeRunId !== run.id && run.status === 'running',
          }
        : {}),
    }));
  }

  public async configureLowConfidencePolicy(input: unknown): Promise<LowConfidencePolicy> {
    await this.restore();
    if (this.busy) throw new Error('正在执行其他本机操作，请稍后再保存策略。');
    const policy = parseLowConfidencePolicy(input);
    await mkdir(path.dirname(this.settingsPath), { recursive: true });
    await writeFile(`${this.settingsPath}.tmp`, JSON.stringify({ lowConfidencePolicy: policy }), {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(`${this.settingsPath}.tmp`, this.settingsPath);
    this.lowConfidencePolicy = policy;
    return policy;
  }

  public async openBrowser(): Promise<void> {
    if (this.context && this.feedPage && !this.feedPage.isClosed()) {
      await this.feedPage.bringToFront();
      return;
    }
    if (this.context) await this.closeCurrentContextForReplacement();
    if (!(await this.options.profileStore.getSelectedProfile()))
      throw new Error('请先创建并选择一个独立浏览器画像。');
    const context = await (this.options.launchProfile ?? launchSelectedCollectorProfile)(
      this.options.profileStore,
    );
    const generation = ++this.contextGeneration;
    this.moduleFeedItems.clear();
    this.context = context;
    context.on('response', (response) => {
      if (generation !== this.contextGeneration) return;
      void this.captureModuleFeedResponse(response);
    });
    context.once('close', () => {
      if (this.plannedContextClosures.delete(generation)) return;
      if (generation !== this.contextGeneration) return;
      this.context = null;
      this.feedPage = null;
      this.profilePage = null;
      this.moduleFeedItems.clear();
      this.stopped = true;
    });
    this.feedPage = context.pages()[0] ?? (await context.newPage());
    await this.feedPage.goto('https://www.douyin.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
  }

  public async closeBrowser(): Promise<void> {
    this.assertIdle();
    await this.closeCurrentContextForReplacement();
    this.context = null;
    this.feedPage = null;
    this.profilePage = null;
    this.moduleFeedItems.clear();
  }

  public async start(runId: string): Promise<void> {
    await this.restore();
    if (this.busy || this.activeRunId) throw new Error('当前已有采集运行，请先暂停。');
    this.busy = true;
    let remoteRunning = false;
    try {
      if (!/^[0-9a-f-]{36}$/iu.test(runId)) throw new Error('运行标识无效。');
      const run = (await this.options.apiClient.syncRuns()).find((entry) => entry.id === runId);
      if (!run || !['ready', 'claimed', 'running', 'paused'].includes(run.status))
        throw new Error('运行已结束或被其他设备领取，请刷新任务。');
      const rules = parseCampaignRuleSet(run.rules);
      const profile = await this.options.profileStore.getSelectedProfile();
      if (!profile) throw new Error('请先创建并选择一个浏览器画像。');
      const pending = await this.queue.listPending();
      if (
        pending.some((entry) => entry.batch.runId !== runId) ||
        (this.checkpoint?.pendingBatch && this.checkpoint.runId !== runId)
      ) {
        throw new Error('请先继续原运行，完成待同步数据后再启动新运行。');
      }
      this.checkpoint = await this.loadCheckpoint(runId, profile.id, run.progress);
      if (this.checkpoint.profileId !== profile.id)
        throw new Error('这次运行绑定了另一个画像，请切回原画像后继续。');
      await this.openBrowser();
      if (!this.feedPage || !this.context) throw new Error('浏览器未打开，请重试。');
      await this.assertSafe(this.feedPage);
      await this.options.apiClient.getDevice();
      if (run.status === 'ready' || run.status === 'claimed') {
        await this.options.apiClient.startRun(runId, run.status === 'ready');
      } else if (run.status === 'paused') {
        await this.options.apiClient.changeRunStatus(runId, 'resume');
      }
      remoteRunning = true;
      await this.ensureProfilePage();
      this.lastErrorCode = null;
      this.stopped = false;
      this.checkpoint.message = '正在读取推荐流；你可以随时暂停。';
      await this.saveCheckpoint();
      this.activeRunId = runId;
      this.work = this.collect({ ...run, rules })
        .catch(async (error: unknown) => {
          if (error instanceof RecoveryCancelledError) return;
          this.lastErrorCode = error instanceof Error ? error.name : 'UnknownError';
          if (this.checkpoint) {
            this.checkpoint.message =
              error instanceof CollectionPausedError
                ? error.message
                : '发生未能安全归类的错误，采集已安全暂停且进度保存在本机。请人工检查浏览器、网络和本机诊断后再继续。';
            await this.saveCheckpoint().catch(() => {
              this.lastErrorCode = 'CheckpointWriteError';
              this.checkpoint!.message =
                '本地进度写入失败，采集已停止。请先检查磁盘空间和数据目录权限。';
            });
          }
          await this.options.apiClient.changeRunStatus(runId, 'pause').catch(() => undefined);
        })
        .finally(() => {
          this.activeRunId = null;
          this.work = null;
        });
    } catch (error) {
      if (remoteRunning)
        await this.options.apiClient.changeRunStatus(runId, 'pause').catch(() => undefined);
      throw error;
    } finally {
      this.busy = false;
    }
  }

  public async control(runId: string, action: 'pause' | 'resume' | 'terminate'): Promise<void> {
    if (action === 'resume') return this.start(runId);
    if (this.busy) throw new Error('正在执行操作，请稍后重试。');
    if (this.activeRunId && this.activeRunId !== runId) throw new Error('请先处理正在执行的运行。');
    this.busy = true;
    this.stopped = true;
    try {
      await this.work;
      const run = (await this.options.apiClient.syncRuns()).find((entry) => entry.id === runId);
      if (!run) throw new Error('找不到当前设备的运行。');
      if (
        action === 'terminate' &&
        this.checkpoint?.runId === runId &&
        this.checkpoint.pendingBatch
      ) {
        throw new Error('采集已停止，但证据尚未同步。请先继续完成同步，再终止，避免丢失数据。');
      }
      if (
        ['completed', 'terminated', 'failed'].includes(run.status) ||
        (action === 'pause' && run.status === 'paused')
      )
        return;
      await this.options.apiClient.changeRunStatus(runId, action);
      if (this.checkpoint?.runId === runId) {
        this.checkpoint.message =
          action === 'pause'
            ? '已暂停。处理好浏览器后，点击继续。'
            : '已终止。已同步的数据仍可在达人库查看。';
        await this.saveCheckpoint();
      }
    } finally {
      this.busy = false;
    }
  }

  private async collect(run: RemoteRun): Promise<void> {
    const rules = parseCampaignRuleSet(run.rules);
    const state = this.checkpoint!;
    const device = await this.options.apiClient.getDevice();
    const started = this.now();
    const previousElapsed = state.progress.elapsedSeconds;
    const delay = () =>
      Math.max(1_000, rules.pacing.minimumDelayMs) +
      Math.floor(
        Math.random() * Math.max(0, rules.pacing.maximumDelayMs - rules.pacing.minimumDelayMs),
      );
    let emptyPasses = 0;
    let recoveryInterval = EMPTY_FEED_RECOVERY_INITIAL_PASSES;
    let nextRecoveryPass = EMPTY_FEED_RECOVERY_INITIAL_PASSES;
    while (!this.stopped) {
      state.progress.elapsedSeconds = previousElapsed + Math.floor((this.now() - started) / 1000);
      if (state.pendingBatch) {
        await this.flushPending();
        if (this.stopped) break;
      }
      // Server state is authoritative; a server resume never starts a local loop.
      const remote = (await this.options.apiClient.syncRuns()).find((entry) => entry.id === run.id);
      if (!remote || remote.status !== 'running') break;
      const reported = await this.options.apiClient.reportProgress(run.id, state.progress);
      if (reported.status === 'completed') {
        state.message = '已达到停止条件。请到达人库复核本次结果。';
        await this.saveCheckpoint();
        break;
      }
      let page = this.feedPage;
      if (!page || page.isClosed()) {
        throw new CollectionPausedError(
          '推荐页已关闭，采集已安全暂停。请人工检查可见浏览器后再继续。',
        );
      }
      page = await this.ensureFeedSafetyWithRecovery(page, run.id);
      await page.bringToFront();
      const { items: domItems } = await collectVisibleRecommendationFeed(
        {
          content: () =>
            page.locator(DOUYIN_FEED_CARD_SELECTORS.join(',')).evaluateAll((cards) =>
              cards
                .filter((card) => {
                  const rect = card.getBoundingClientRect();
                  const style = getComputedStyle(card);
                  return (
                    rect.width > 0 &&
                    rect.height > 0 &&
                    rect.bottom > 0 &&
                    rect.top < innerHeight &&
                    rect.right > 0 &&
                    rect.left < innerWidth &&
                    style.visibility !== 'hidden' &&
                    style.display !== 'none'
                  );
                })
                .map((card) => card.outerHTML)
                .join('\n'),
            ),
          mouse: page.mouse,
          waitForTimeout: (milliseconds) => page.waitForTimeout(milliseconds),
        },
        {
          maxFeedItems: 100,
          maxScrolls: 0,
        },
      );
      const availableItems = new Map<string, DouyinFeedItem>();
      for (const entry of this.moduleFeedItems.values()) availableItems.set(entry.postUrl, entry);
      for (const entry of domItems) availableItems.set(entry.postUrl, entry);
      const item = [...availableItems.values()].find(
        (entry) => !state.seenPosts.includes(entry.platformPostId) && entry.authorProfileUrl,
      );
      if (!item) {
        emptyPasses += 1;
        const action = decideLowConfidenceAction(this.lowConfidencePolicy, emptyPasses);
        if (action === 'pause')
          throw new CollectionPausedError(
            `连续 ${emptyPasses} 次未识别到新的作品与作者，已按当前策略暂停。请确认推荐页已加载；页面结构可能变化，不会猜测数据。`,
          );
        state.message =
          this.lowConfidencePolicy.mode === 'never_pause'
            ? `连续 ${emptyPasses} 次暂未识别到新的作品与作者；当前设置为永不因此暂停，正在继续滚动和检查。`
            : `暂未识别到新的作品与作者，连续 ${emptyPasses}/${this.lowConfidencePolicy.consecutiveLimit} 次；正在继续尝试。`;
        const scroll = await this.scrollRecommendationFeed(page, 760);
        if (!scroll.moved) await page.mouse.wheel(0, 760);

        if (this.lowConfidencePolicy.mode === 'never_pause' && emptyPasses >= nextRecoveryPass) {
          state.message = `连续 ${emptyPasses} 次未发现新作品，正在重新加载当前抖音推荐页恢复采集；已有作品不会重复写入。`;
          await this.saveCheckpoint();
          const reloaded = await this.reloadRecommendationFeed(page);
          state.message = reloaded
            ? `已自动重新加载推荐页；连续无新作品 ${emptyPasses} 次，正在等待新内容。`
            : `推荐页自动重载暂未成功；连续无新作品 ${emptyPasses} 次，将继续滚动并按退避策略重试。`;
          recoveryInterval = Math.min(recoveryInterval * 2, EMPTY_FEED_RECOVERY_MAX_INTERVAL);
          nextRecoveryPass += recoveryInterval;
        }
        await this.saveCheckpoint();
        await page.waitForTimeout(delay());
        continue;
      }
      emptyPasses = 0;
      recoveryInterval = EMPTY_FEED_RECOVERY_INITIAL_PASSES;
      nextRecoveryPass = EMPTY_FEED_RECOVERY_INITIAL_PASSES;
      if (state.seenCreators.includes(item.authorProfileUrl!)) {
        state.seenPosts.push(item.platformPostId);
        state.progress.feedItemsSeen += 1;
        await this.saveCheckpoint();
        continue;
      }
      const rollingDays = Math.max(
        1,
        ...rules.hardRules.map((rule) => (rule.type === 'recent-post-likes' ? rule.windowDays : 1)),
      );
      const inspection = await this.inspectProfileWithRecovery({
        profileUrl: item.authorProfileUrl!,
        rollingDays,
        settleMs: delay(),
      });
      const profilePage = this.profilePage;
      if (!profilePage) throw new Error('作者核验页不可用，请重试。');
      const safetyIssue = await this.findSafetyIssue(
        profilePage,
        inspection.profile.parserConfidence,
      );
      if (safetyIssue?.code === 'low_parser_confidence') {
        const missingFields = [
          ...(inspection.profile.nickname ? [] : ['昵称']),
          ...(inspection.profile.followerCount === null ? ['粉丝数'] : []),
        ];
        state.lowConfidence.consecutiveFailures = updateLowConfidenceConsecutiveFailures(
          state.lowConfidence.consecutiveFailures,
          'low_confidence',
        );
        state.lowConfidence.skippedTotal += 1;
        state.lowConfidence.lastIssue = {
          detectedAt: new Date().toISOString(),
          missingFields,
          parserConfidence: inspection.profile.parserConfidence,
          profileUrl: item.authorProfileUrl!,
        };
        state.seenPosts.push(item.platformPostId);
        state.seenCreators.push(item.authorProfileUrl!);
        state.progress.feedItemsSeen += 1;
        state.progress.creatorProfilesSeen += 1;
        const action = decideLowConfidenceAction(
          this.lowConfidencePolicy,
          state.lowConfidence.consecutiveFailures,
        );
        const detail = `可信度 ${inspection.profile.parserConfidence.toFixed(2)}，缺少${missingFields.join('、') || '关键主页字段'}`;
        state.message =
          action === 'pause'
            ? `连续 ${state.lowConfidence.consecutiveFailures} 条页面解析可信度过低，已暂停；累计跳过 ${state.lowConfidence.skippedTotal} 条。最近一次：${detail}。这些数据均未写入。`
            : this.lowConfidencePolicy.mode === 'never_pause'
              ? `已跳过低可信度作者且未写入；连续 ${state.lowConfidence.consecutiveFailures} 条，累计 ${state.lowConfidence.skippedTotal} 条。最近一次：${detail}。当前设置为永不因低可信度暂停。`
              : `已跳过低可信度作者且未写入；连续 ${state.lowConfidence.consecutiveFailures}/${this.lowConfidencePolicy.consecutiveLimit} 条，累计 ${state.lowConfidence.skippedTotal} 条。最近一次：${detail}。`;
        await this.saveCheckpoint();
        if (action === 'pause') throw new CollectionPausedError(state.message);
        if (!determineRunStopReason(rules, state.progress)) await page.waitForTimeout(delay());
        continue;
      }
      if (safetyIssue) throw new CollectionPausedError(safetyIssue.humanMessage);
      if (this.stopped) break;
      state.lowConfidence.consecutiveFailures = updateLowConfidenceConsecutiveFailures(
        state.lowConfidence.consecutiveFailures,
        'trusted',
      );
      const observationId = randomUUID();
      const posts = inspection.posts.slice(0, 199);
      // The feed itself is evidence even when the profile does not expose dates.
      if (!posts.some((post) => post.platformPostId === item.platformPostId))
        posts.push({ ...item, publishedAt: null });
      const observation = {
        observationId,
        platform: 'douyin' as const,
        platformCreatorId: inspection.profile.platformCreatorId!,
        profileUrl: item.authorProfileUrl!,
        nickname: inspection.profile.nickname ?? item.authorNickname ?? '昵称未知',
        biography: inspection.profile.biography,
        followerCount: inspection.profile.followerCount,
        followerCountRaw: inspection.profile.followerCountRaw,
        observedAt: inspection.observedAt,
        parserConfidence: inspection.profile.parserConfidence,
        postsWindowComplete: false,
        posts: posts.map((post) => ({
          platformPostId: post.platformPostId,
          postUrl: post.postUrl,
          caption: post.caption,
          likeCount: post.likeCount,
          likeCountRaw: post.likeCountRaw,
          publishedAt: post.publishedAt,
          observedAt: inspection.observedAt,
          screenshotLocalId: null,
        })),
      };
      const filter = evaluateHardFilters(rules, {
        ...observation,
        creatorObservationId: observationId,
        evaluatedAt: inspection.observedAt,
        posts: observation.posts.map((post) => ({
          ...post,
          postId: post.platformPostId,
          postObservationId: post.platformPostId,
        })),
      });
      // 只有取得入库资格的达人才需要证据。fail 与 unknown 都不会产生候选行，
      // 截图在服务端没有消费者，采下来只会留下等 worker 回收的孤儿对象。
      state.screenshot =
        filter.outcome !== 'pass'
          ? null
          : (await profilePage.screenshot({ type: 'jpeg', quality: 75, fullPage: false })).toString(
              'base64',
            );
      state.pendingBatch = collectorBatchSchema.parse({
        protocolVersion: COLLECTOR_PROTOCOL_VERSION,
        collectorVersion: COLLECTOR_VERSION,
        parserVersion: DOUYIN_PARSER_VERSION,
        deviceId: device.deviceId,
        runId: run.id,
        idempotencyKey: `observation-${observationId}`,
        observations: [observation],
      });
      state.seenPosts.push(item.platformPostId);
      state.seenCreators.push(item.authorProfileUrl!);
      state.progress.feedItemsSeen += 1;
      state.progress.creatorProfilesSeen += 1;
      if (filter.outcome === 'pass') state.progress.candidatesFound += 1;
      await this.saveCheckpoint();
      await this.flushPending();
      if (!this.stopped && !determineRunStopReason(rules, state.progress))
        await this.feedPage?.waitForTimeout(delay());
    }
    if (this.stopped) {
      state.message = this.context
        ? '已暂停。处理好浏览器后，点击继续。'
        : '浏览器已关闭，采集已暂停。点击继续可重新打开原画像。';
      await this.options.apiClient.changeRunStatus(run.id, 'pause').catch(() => undefined);
    }
    await this.saveCheckpoint();
  }

  private async ensureProfilePage(): Promise<Page> {
    if (!this.context) throw new Error('浏览器未打开，请重试。');
    if (this.profilePage && !this.profilePage.isClosed()) return this.profilePage;
    this.profilePage = await this.context.newPage();
    return this.profilePage;
  }

  private async inspectProfileWithRecovery(input: {
    profileUrl: string;
    rollingDays: number;
    settleMs: number;
  }): Promise<DouyinProfileInspection> {
    try {
      return await inspectDouyinCreatorProfile(await this.ensureProfilePage(), input);
    } catch (error) {
      if (!(error instanceof DouyinProfileSafetyError)) throw error;
      if (error.issue.code !== 'transient_page_failure') {
        throw new CollectionPausedError(error.issue.humanMessage);
      }
      return this.recoverProfileInspection(input, error.issue);
    }
  }

  private async ensureFeedSafetyWithRecovery(page: Page, runId: string): Promise<Page> {
    const initialIssue = await this.findSafetyIssue(page);
    if (!initialIssue) return page;
    if (initialIssue.code !== 'transient_page_failure') {
      throw new CollectionPausedError(initialIssue.humanMessage);
    }
    return this.recoverFeedPage(runId, initialIssue);
  }

  private async recoverFeedPage(runId: string, initialIssue: CollectionSafetyIssue): Promise<Page> {
    const state = this.checkpoint!;
    const previousRecovery = normalizeRecoveryCheckpoint(state.recovery);
    const startIndex = recoveryStartIndex(previousRecovery, this.now());
    const eventStartedAt = new Date(this.now()).toISOString();
    let issue = initialIssue;
    for (let index = startIndex; index < RECOVERY_STEPS.length; index += 1) {
      const step = RECOVERY_STEPS[index]!;
      if (step.stage === 'restart_browser') {
        const circuit = recordContextRestart(previousRecovery, this.now());
        previousRecovery.contextRestartTimestamps = circuit.timestamps;
        previousRecovery.circuitBreakerCount = circuit.timestamps.length;
        if (circuit.circuitOpen) {
          state.recovery = {
            ...previousRecovery,
            attemptCount: index - startIndex + 1,
            eventStartedAt,
            ...recoveryIssueEvidence(issue),
            lastResult: 'exhausted',
            nextAttemptAt: null,
            pageType: 'feed',
            stage: 'circuit_open',
          };
          state.message =
            '一小时内已达到 3 次浏览器恢复上限，采集已暂停。请人工检查网络、账号与抖音页面后再继续。';
          await this.saveCheckpoint();
          throw new CollectionPausedError(state.message);
        }
      }
      const waitMs = recoveryDelayMs(step, this.options.random?.() ?? Math.random());
      const attemptCount = index - startIndex + 1;
      state.recovery = {
        ...previousRecovery,
        attemptCount,
        eventStartedAt,
        ...recoveryIssueEvidence(issue),
        lastResult: 'waiting',
        nextAttemptAt: new Date(this.now() + waitMs).toISOString(),
        pageType: 'feed',
        stage: step.stage,
      };
      state.message = `推荐页暂时不可用，正在自动恢复（${recoveryStageLabel(step.stage)}，第 ${attemptCount} 次）；可随时人工暂停或终止。`;
      await this.saveCheckpoint();
      if (!(await this.waitForRecovery(waitMs, runId))) {
        state.recovery = {
          ...state.recovery,
          lastResult: 'cancelled',
          nextAttemptAt: null,
        };
        state.message = '推荐页自动恢复已按人工操作取消，当前进度已保存。';
        await this.saveCheckpoint();
        throw new RecoveryCancelledError();
      }
      state.recovery = { ...state.recovery, lastResult: 'attempting', nextAttemptAt: null };
      await this.saveCheckpoint();
      try {
        const recoveredPage = await this.prepareFeedRecoveryStage(step.stage);
        const nextIssue = await this.findSafetyIssue(recoveredPage);
        if (!nextIssue) {
          state.recovery = {
            ...state.recovery,
            contextRestartTimestamps: previousRecovery.contextRestartTimestamps,
            circuitBreakerCount: previousRecovery.circuitBreakerCount,
            lastRecoveredAt: new Date(this.now()).toISOString(),
            lastResult: 'recovered',
          };
          state.message = `推荐页已通过${recoveryStageLabel(step.stage)}恢复，正在继续采集；已见数据不会重复写入。`;
          await this.saveCheckpoint();
          return recoveredPage;
        }
        if (nextIssue.code !== 'transient_page_failure') {
          throw new CollectionPausedError(nextIssue.humanMessage);
        }
        issue = nextIssue;
      } catch (error) {
        if (error instanceof CollectionPausedError) throw error;
        if (!isTransientNavigationFailure(error)) throw error;
        issue = {
          code: 'transient_page_failure',
          humanMessage: '抖音推荐页导航暂时失败，正在低频自动恢复。',
          navigationErrorCode: normalizeRuntimeNavigationError(error),
        };
      }
    }
    state.recovery = {
      ...normalizeRecoveryCheckpoint(state.recovery),
      ...recoveryIssueEvidence(issue),
      lastResult: 'exhausted',
      nextAttemptAt: null,
    };
    state.message =
      '推荐页故障在刷新、重建页面和重启浏览器后仍未恢复，恢复预算已耗尽。进度已保存，请人工检查后继续。';
    await this.saveCheckpoint();
    throw new CollectionPausedError(state.message);
  }

  private async prepareFeedRecoveryStage(
    stage: 'recreate_profile_page' | 'reload_page' | 'restart_browser',
  ): Promise<Page> {
    if (stage === 'reload_page') {
      if (!this.feedPage || this.feedPage.isClosed()) {
        throw new CollectionPausedError('推荐页已关闭，采集已安全暂停，请人工检查浏览器。');
      }
      await this.feedPage.reload({ timeout: 30_000, waitUntil: 'domcontentloaded' });
      return this.feedPage;
    }
    if (stage === 'recreate_profile_page') {
      if (!this.context) throw new CollectionPausedError('浏览器已关闭，采集已安全暂停。');
      const oldPage = this.feedPage;
      this.feedPage = null;
      if (oldPage && !oldPage.isClosed()) await oldPage.close().catch(() => undefined);
      const replacement = await this.context.newPage();
      this.feedPage = replacement;
      await replacement.goto('https://www.douyin.com/', {
        timeout: 30_000,
        waitUntil: 'domcontentloaded',
      });
      return replacement;
    }
    await this.restartBrowserForRecovery();
    if (!this.feedPage) throw new CollectionPausedError('浏览器推荐页恢复失败，采集已暂停。');
    return this.feedPage;
  }

  private async recoverProfileInspection(
    input: { profileUrl: string; rollingDays: number; settleMs: number },
    initialIssue: CollectionSafetyIssue,
  ): Promise<DouyinProfileInspection> {
    const state = this.checkpoint!;
    const previousRecovery = normalizeRecoveryCheckpoint(state.recovery);
    const startIndex = recoveryStartIndex(previousRecovery, this.now());
    const eventStartedAt = new Date(this.now()).toISOString();
    let issue = initialIssue;
    for (let index = startIndex; index < RECOVERY_STEPS.length; index += 1) {
      const step = RECOVERY_STEPS[index]!;
      if (step.stage === 'restart_browser') {
        const circuit = recordContextRestart(previousRecovery, this.now());
        previousRecovery.contextRestartTimestamps = circuit.timestamps;
        previousRecovery.circuitBreakerCount = circuit.timestamps.length;
        if (circuit.circuitOpen) {
          state.recovery = {
            ...previousRecovery,
            attemptCount: index - startIndex + 1,
            eventStartedAt,
            ...recoveryIssueEvidence(issue),
            lastResult: 'exhausted',
            nextAttemptAt: null,
            pageType: 'profile',
            stage: 'circuit_open',
          };
          state.message =
            '一小时内已达到 3 次浏览器恢复上限，采集已暂停。请人工检查网络、账号与抖音页面后再继续。';
          await this.saveCheckpoint();
          throw new CollectionPausedError(state.message);
        }
      }
      const waitMs = recoveryDelayMs(step, this.options.random?.() ?? Math.random());
      const attemptCount = index - startIndex + 1;
      state.recovery = {
        ...previousRecovery,
        attemptCount,
        eventStartedAt,
        ...recoveryIssueEvidence(issue),
        lastResult: 'waiting',
        nextAttemptAt: new Date(this.now() + waitMs).toISOString(),
        pageType: 'profile',
        stage: step.stage,
      };
      state.message = `抖音页面暂时不可用，正在自动恢复（${recoveryStageLabel(step.stage)}，第 ${attemptCount} 次）；可随时人工暂停或终止。`;
      await this.saveCheckpoint();
      if (!(await this.waitForRecovery(waitMs, state.runId))) {
        state.recovery = {
          ...state.recovery,
          lastResult: 'cancelled',
          nextAttemptAt: null,
        };
        state.message = '自动恢复已按人工操作取消，当前进度已保存。';
        await this.saveCheckpoint();
        throw new RecoveryCancelledError();
      }
      state.recovery = {
        ...state.recovery,
        lastResult: 'attempting',
        nextAttemptAt: null,
      };
      await this.saveCheckpoint();
      try {
        const profilePage = await this.prepareRecoveryStage(step.stage);
        const inspection = await inspectDouyinCreatorProfile(profilePage, input);
        const recoveredAt = new Date(this.now()).toISOString();
        state.recovery = {
          ...state.recovery,
          contextRestartTimestamps: previousRecovery.contextRestartTimestamps,
          circuitBreakerCount: previousRecovery.circuitBreakerCount,
          lastRecoveredAt: recoveredAt,
          lastResult: 'recovered',
        };
        state.message = `页面已通过${recoveryStageLabel(step.stage)}恢复，正在继续当前作者；已见数据不会重复写入。`;
        await this.saveCheckpoint();
        return inspection;
      } catch (error) {
        if (!(error instanceof DouyinProfileSafetyError)) throw error;
        if (error.issue.code !== 'transient_page_failure') {
          throw new CollectionPausedError(error.issue.humanMessage);
        }
        issue = error.issue;
      }
    }
    state.recovery = {
      ...normalizeRecoveryCheckpoint(state.recovery),
      ...recoveryIssueEvidence(issue),
      lastResult: 'exhausted',
      nextAttemptAt: null,
    };
    state.message =
      '暂时性页面故障在刷新、重建核验页和重启浏览器后仍未恢复，恢复预算已耗尽。进度已保存，请人工检查后继续。';
    await this.saveCheckpoint();
    throw new CollectionPausedError(state.message);
  }

  private async prepareRecoveryStage(
    stage: 'recreate_profile_page' | 'reload_page' | 'restart_browser',
  ): Promise<Page> {
    if (stage === 'reload_page') return this.ensureProfilePage();
    if (stage === 'recreate_profile_page') {
      const oldPage = this.profilePage;
      this.profilePage = null;
      if (oldPage && !oldPage.isClosed()) await oldPage.close().catch(() => undefined);
      return this.ensureProfilePage();
    }
    await this.restartBrowserForRecovery();
    return this.ensureProfilePage();
  }

  private async restartBrowserForRecovery(): Promise<void> {
    await this.closeCurrentContextForReplacement();
    this.context = null;
    this.feedPage = null;
    this.profilePage = null;
    this.moduleFeedItems.clear();
    await this.openBrowser();
  }

  private async closeCurrentContextForReplacement(): Promise<void> {
    const context = this.context;
    if (!context) return;
    const generation = this.contextGeneration;
    this.plannedContextClosures.add(generation);
    try {
      await context.close();
    } catch (error) {
      this.plannedContextClosures.delete(generation);
      throw error;
    }
  }

  private async waitForRecovery(milliseconds: number, runId: string): Promise<boolean> {
    let remaining = milliseconds;
    while (remaining > 0) {
      if (this.stopped || !this.context) return false;
      const remote = (await this.options.apiClient.syncRuns()).find((entry) => entry.id === runId);
      if (!remote || remote.status !== 'running') {
        this.stopped = true;
        return false;
      }
      const slice = Math.min(1_000, remaining);
      await (this.options.wait ?? defaultWait)(slice);
      remaining -= slice;
    }
    return !this.stopped && Boolean(this.context);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private async captureModuleFeedResponse(response: PlaywrightResponse): Promise<void> {
    try {
      const url = new URL(response.url());
      if (
        response.status() !== 200 ||
        url.origin !== 'https://www.douyin.com' ||
        url.pathname !== '/aweme/v2/web/module/feed/'
      )
        return;
      for (const item of extractDouyinFeedItemsFromModuleFeed(await response.json())) {
        this.moduleFeedItems.set(item.postUrl, item);
      }
      while (this.moduleFeedItems.size > 500) {
        const oldestPostUrl = this.moduleFeedItems.keys().next().value;
        if (!oldestPostUrl) break;
        this.moduleFeedItems.delete(oldestPostUrl);
      }
    } catch {
      // A malformed or cancelled response is ignored; DOM parsing and safety limits remain active.
    }
  }

  private async scrollRecommendationFeed(
    page: Page,
    deltaY: number,
  ): Promise<{ moved: boolean; target: 'container' | 'document' | 'none' }> {
    return page.evaluate(
      ({ cardSelector, scrollDelta }) => {
        const visibleCards = [...document.querySelectorAll<HTMLElement>(cardSelector)].filter(
          (card) => {
            const rect = card.getBoundingClientRect();
            const style = getComputedStyle(card);
            return (
              rect.width > 0 &&
              rect.height > 0 &&
              rect.bottom > 0 &&
              rect.top < innerHeight &&
              style.display !== 'none' &&
              style.visibility !== 'hidden'
            );
          },
        );
        const candidates = new Set<HTMLElement>();
        for (const card of visibleCards) {
          let ancestor = card.parentElement;
          while (ancestor && ancestor !== document.body && ancestor !== document.documentElement) {
            const overflowY = getComputedStyle(ancestor).overflowY;
            if (
              /^(?:auto|overlay|scroll)$/u.test(overflowY) &&
              ancestor.scrollHeight > ancestor.clientHeight + 8
            ) {
              candidates.add(ancestor);
            }
            ancestor = ancestor.parentElement;
          }
        }

        const documentScroller =
          document.scrollingElement instanceof HTMLElement ? document.scrollingElement : null;
        const target =
          [...candidates].sort((left, right) => {
            const leftRemaining = left.scrollHeight - left.clientHeight - left.scrollTop;
            const rightRemaining = right.scrollHeight - right.clientHeight - right.scrollTop;
            return rightRemaining - leftRemaining;
          })[0] ?? documentScroller;
        if (!target) return { moved: false, target: 'none' as const };

        const before = target.scrollTop;
        const maximum = Math.max(0, target.scrollHeight - target.clientHeight);
        target.scrollTop = Math.min(maximum, before + scrollDelta);
        target.dispatchEvent(new Event('scroll', { bubbles: true }));
        if (target === documentScroller) window.dispatchEvent(new Event('scroll'));
        return {
          moved: target.scrollTop > before,
          target: target === documentScroller ? ('document' as const) : ('container' as const),
        };
      },
      { cardSelector: DOUYIN_FEED_CARD_SELECTORS.join(','), scrollDelta: deltaY },
    );
  }

  private async reloadRecommendationFeed(page: Page): Promise<boolean> {
    let currentUrl: URL;
    try {
      currentUrl = new URL(page.url());
    } catch {
      throw new CollectionPausedError(
        '当前浏览器地址无法识别，已暂停自动恢复。请人工打开抖音推荐页后继续。',
      );
    }
    if (
      currentUrl.origin !== 'https://www.douyin.com' ||
      (currentUrl.pathname !== '/' && !currentUrl.pathname.startsWith('/jingxuan'))
    ) {
      throw new CollectionPausedError(
        '当前页面不是抖音推荐页，已暂停自动恢复。请人工打开抖音推荐页后继续。',
      );
    }

    this.moduleFeedItems.clear();
    try {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
      const issue = await this.findSafetyIssue(page);
      if (issue?.code === 'transient_page_failure') return false;
      if (issue) throw new CollectionPausedError(issue.humanMessage);
      return true;
    } catch (error) {
      if (error instanceof CollectionPausedError) throw error;
      return false;
    }
  }

  private async flushPending(): Promise<void> {
    const state = this.checkpoint!;
    if (!state.pendingBatch) return;
    await this.queue.enqueue(state.pendingBatch);
    while (!this.stopped) {
      const result = await this.queue.processNext(this.options.apiClient);
      if (result.status === 'completed') {
        if (result.acknowledgement.results.some((entry) => entry.status === 'rejected'))
          throw new CollectionPausedError(
            '服务端拒绝了观察数据，请检查采集助手版本。原始批次仍保留在本机。',
          );
        break;
      }
      if (result.status === 'retry_scheduled' && result.attemptCount >= 3)
        throw new CollectionPausedError(
          '同步连续失败，批次已保存在本机。请检查网络与设备授权，再点击继续重试。',
        );
      if (result.status === 'empty') break;
      state.message = '网络暂时不可用，正在重试已保存的批次；不会继续翻页。';
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (this.stopped) return;
    if (state.screenshot) {
      await this.options.uploadScreenshot({
        bytes: Buffer.from(state.screenshot, 'base64'),
        mimeType: 'image/jpeg',
        observation: { creatorObservationId: state.pendingBatch.observations[0]!.observationId },
        purpose: 'profile_screenshot',
        runId: state.runId,
      });
    }
    state.pendingBatch = null;
    state.screenshot = null;
    state.message = '数据与证据已同步，正在继续发现。';
    await this.saveCheckpoint();
  }

  private async findSafetyIssue(
    page: Page,
    parserConfidence?: number,
  ): Promise<CollectionSafetyIssue | null> {
    return detectCollectionSafetyIssue({
      url: page.url(),
      title: await page.title(),
      bodyText: await page.locator('body').innerText({ timeout: 5000 }),
      ...(parserConfidence === undefined ? {} : { parserConfidence }),
    });
  }

  private async assertSafe(page: Page, parserConfidence?: number) {
    const issue = await this.findSafetyIssue(page, parserConfidence);
    if (issue) throw new CollectionPausedError(issue.humanMessage);
  }

  private async loadCheckpoint(
    runId: string,
    profileId: string,
    progress?: CollectorRunProgress,
  ): Promise<Checkpoint> {
    try {
      const state = JSON.parse(await readFile(this.checkpointPath(runId), 'utf8')) as Checkpoint;
      if (state.runId !== runId) throw new Error('本地进度文件损坏。');
      if (state.pendingBatch) collectorBatchSchema.parse(state.pendingBatch);
      return this.normalizeCheckpoint(state);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return {
        runId,
        profileId,
        progress: progress ?? {
          feedItemsSeen: 0,
          creatorProfilesSeen: 0,
          candidatesFound: 0,
          elapsedSeconds: 0,
        },
        seenPosts: [],
        seenCreators: [],
        pendingBatch: null,
        screenshot: null,
        message: '',
        lowConfidence: {
          consecutiveFailures: 0,
          lastIssue: null,
          skippedTotal: 0,
        },
        recovery: createIdleRecoveryCheckpoint(),
      };
    }
  }

  private checkpointPath(runId: string) {
    return path.join(this.directory, `${createHash('sha256').update(runId).digest('hex')}.json`);
  }

  private normalizeCheckpoint(state: Checkpoint): Checkpoint {
    const lowConfidence = state.lowConfidence;
    return {
      ...state,
      lowConfidence: {
        consecutiveFailures: Number.isInteger(lowConfidence?.consecutiveFailures)
          ? Math.max(0, lowConfidence.consecutiveFailures)
          : 0,
        lastIssue: lowConfidence?.lastIssue ?? null,
        skippedTotal: Number.isInteger(lowConfidence?.skippedTotal)
          ? Math.max(0, lowConfidence.skippedTotal)
          : 0,
      },
      recovery: normalizeRecoveryCheckpoint(state.recovery),
    };
  }

  private async restoreSettings(): Promise<void> {
    try {
      const settings = JSON.parse(await readFile(this.settingsPath, 'utf8')) as {
        lowConfidencePolicy?: unknown;
      };
      this.lowConfidencePolicy = parseLowConfidencePolicy(settings.lowConfidencePolicy);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private async saveCheckpoint() {
    if (!this.checkpoint) return;
    await mkdir(this.directory, { recursive: true });
    const target = this.checkpointPath(this.checkpoint.runId);
    await writeFile(`${target}.tmp`, JSON.stringify(this.checkpoint), {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(`${target}.tmp`, target);
    await this.writeRecoveryEventIfChanged();
  }

  private async writeRecoveryEventIfChanged(): Promise<void> {
    const state = this.checkpoint;
    const recovery = state?.recovery;
    if (!state || !recovery || !recovery.issueCode || !recovery.pageType) return;
    const fingerprint = JSON.stringify(recovery);
    if (fingerprint === this.lastRecoveryLogFingerprint) return;
    this.lastRecoveryLogFingerprint = fingerprint;
    await this.recoveryLog
      .append({
        at: new Date(this.now()).toISOString(),
        browserGeneration: this.contextGeneration,
        issueCode: recovery.issueCode,
        ...(recovery.navigationErrorCode
          ? { navigationErrorCode: recovery.navigationErrorCode }
          : {}),
        pageType: recovery.pageType,
        progress: state.progress,
        result: recovery.lastResult,
        runId: state.runId,
        stage: recovery.stage,
        ...(recovery.statusCode === null ? {} : { statusCode: recovery.statusCode }),
      })
      .catch(() => {
        this.lastErrorCode = 'RecoveryLogWriteError';
      });
  }
}

class CollectionPausedError extends Error {}
class RecoveryCancelledError extends Error {}

function recoveryStageLabel(
  stage: 'recreate_profile_page' | 'reload_page' | 'restart_browser',
): string {
  if (stage === 'reload_page') return '重新加载当前作者页';
  if (stage === 'recreate_profile_page') return '重建作者核验页';
  return '使用同一画像重启可见浏览器';
}

function defaultWait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isTransientNavigationFailure(error: unknown): boolean {
  return normalizeRuntimeNavigationError(error) !== 'UNCLASSIFIED_NAVIGATION_ERROR';
}

function normalizeRuntimeNavigationError(error: unknown): string {
  if (error instanceof Error && error.name === 'TimeoutError') return 'NAVIGATION_TIMEOUT';
  const message = error instanceof Error ? error.message : '';
  for (const code of ['ERR_CONNECTION_CLOSED', 'ERR_CONNECTION_RESET', 'ERR_TIMED_OUT']) {
    if (message.includes(code)) return code;
  }
  return 'UNCLASSIFIED_NAVIGATION_ERROR';
}

function recoveryIssueEvidence(
  issue: CollectionSafetyIssue,
): Pick<RecoveryCheckpoint, 'issueCode' | 'navigationErrorCode' | 'statusCode'> {
  const navigationErrorCode = isAllowedNavigationErrorCode(issue.navigationErrorCode)
    ? issue.navigationErrorCode
    : null;
  return {
    issueCode: issue.code,
    navigationErrorCode,
    statusCode: Number.isInteger(issue.statusCode) ? issue.statusCode! : null,
  };
}

function isAllowedNavigationErrorCode(
  value: string | undefined,
): value is NonNullable<RecoveryCheckpoint['navigationErrorCode']> {
  return (
    value === 'ERR_CONNECTION_CLOSED' ||
    value === 'ERR_CONNECTION_RESET' ||
    value === 'ERR_TIMED_OUT' ||
    value === 'NAVIGATION_TIMEOUT'
  );
}
