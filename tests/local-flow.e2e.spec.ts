import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test } from '@playwright/test';
import type { BrowserContext } from '@playwright/test';
import type { RowDataPacket } from 'mysql2/promise';
import {
  bootstrapFirstAdmin,
  createMysqlPool,
  runMigrations,
  seedInitialWorkspace,
} from '@douyin/domain';
import type { ObjectStorageClient } from '@douyin/domain';

import { CollectorBrowserProfileStore } from '../apps/collector/src/browser-profiles.js';
import {
  CollectorControlApiClient,
  createCollectorControlServer,
  listenCollectorControlServer,
} from '../apps/collector/src/control-server.js';
import { DeviceTokenStore } from '../apps/collector/src/device-identity.js';
import { uploadScreenshotEvidence } from '../apps/collector/src/media-upload.js';
import { CollectorRuntime } from '../apps/collector/src/runtime.js';
import type { CollectorRuntimeOptions } from '../apps/collector/src/runtime.js';

test('真实本地 API + MySQL + 浏览器走通创建、配对、采集、截图与人工复核', async ({
  page,
  browser,
}, testInfo) => {
  test.skip(!process.env.MYSQL_TEST_URL, 'Requires the isolated MySQL test database.');
  test.setTimeout(90_000);
  process.env.NODE_ENV = 'test';
  const { buildServer } = await import('../apps/api/src/server.js');
  const workspaceId = randomUUID();
  const pool = createMysqlPool(process.env.MYSQL_TEST_URL!);
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'douyin-flow-'));
  const uploads = new Map<string, Awaited<ReturnType<ObjectStorageClient['headObject']>>>();
  const storage: ObjectStorageClient = {
    createSignedGetUrl: async ({ objectKey }) => `https://evidence.test/${objectKey}`,
    createSignedPutUrl: async ({ objectKey }) => `https://evidence.test/${objectKey}`,
    headObject: async (key) => {
      const metadata = uploads.get(key);
      if (!metadata) throw new Error('Missing fixture object');
      return metadata;
    },
    deleteObject: async (key) => {
      uploads.delete(key);
    },
  };
  const api = buildServer({ pool, secureCookies: false, logger: false, objectStorage: storage });
  let sourceBrowser: BrowserContext | undefined;
  let collector: ReturnType<typeof createCollectorControlServer> | undefined;
  try {
    await runMigrations(pool);
    await seedInitialWorkspace(pool, {
      workspaceId,
      workspaceName: '流程验收',
      workspaceSlug: `flow-${workspaceId}`,
    });
    const email = `flow-${workspaceId}@example.test`;
    const password = 'LocalFlowTest2026';
    await bootstrapFirstAdmin(pool, { workspaceId, email, password, displayName: '流程验收员' });
    const apiUrl = await api.listen({ host: '127.0.0.1', port: 0 });
    const apiPaths =
      /^\/(auth|campaigns|campaign-templates|candidates|runs|devices|members|dashboard|audit-events|media)(\/|$)/u;
    await page.route('http://127.0.0.1:4187/**', async (route) => {
      const url = new URL(route.request().url());
      if (!apiPaths.test(url.pathname)) return route.continue();
      const options =
        url.pathname === '/auth/login'
          ? { postData: JSON.stringify({ ...route.request().postDataJSON(), workspaceId }) }
          : {};
      const response = await route.fetch({ url: apiUrl + url.pathname + url.search, ...options });
      await route.fulfill({ response });
    });
    const tokenStore = new DeviceTokenStore(dataRoot, {
      protect: async (value) => value,
      unprotect: async (value) => value,
    });
    const profileStore = new CollectorBrowserProfileStore(dataRoot);
    let ingestionRequests = 0;
    const client = new CollectorControlApiClient(apiUrl, tokenStore, async (url, init) => {
      if (
        new URL(String(url)).pathname === '/collector/ingestion/batches' &&
        ingestionRequests++ === 0
      )
        throw new TypeError('Fixture offline');
      return fetch(url, init);
    });
    let launchCount = 0;
    let failUpload = true;
    const runtimeOptions: CollectorRuntimeOptions = {
      apiClient: client,
      profileStore,
      launchProfile: async () => {
        launchCount += 1;
        sourceBrowser = await browser.newContext();
        await sourceBrowser.route('https://www.douyin.com/**', (route) => {
          const pathname = new URL(route.request().url()).pathname;
          const publishedAt = new Date(Date.now() - 86_400_000).toISOString();
          // 两位达人通过硬筛（分别走「复核通过」与「复核不通过」两条分区路径），
          // 第三位粉丝数超出默认规则上限，用于验证未入库达人同样能在运行详情看到判定依据。
          const creators = [
            {
              followers: '1200',
              nickname: '流程测试同学',
              slug: 'flow-creator',
              videoId: '7600000000000000001',
            },
            {
              followers: '1500',
              nickname: '二号同学',
              slug: 'second-classmate',
              videoId: '7600000000000000003',
            },
            {
              followers: '7000',
              nickname: '超范围同学',
              slug: 'overflow-classmate',
              videoId: '7600000000000000002',
            },
          ] as const;
          const profile = (creator: (typeof creators)[number]) =>
            `<h1 data-e2e="user-title">${creator.nickname}</h1><p data-e2e="user-desc">校园日常</p><p>粉丝 ${creator.followers}</p><article data-e2e="user-post-item"><a href="/video/${creator.videoId}">公开作品</a><span data-e2e="video-like-count">1.2万</span><time datetime="${publishedAt}"></time></article>`;
          const feedItem = (creator: (typeof creators)[number]) =>
            `<article data-e2e="feed-item"><a href="/video/${creator.videoId}">公开作品</a><a href="/user/${creator.slug}">${creator.nickname}</a><span data-e2e="video-like-count">1.2万</span></article>`;
          const matched = creators.find((creator) => pathname.includes(creator.slug));
          const body =
            pathname.startsWith('/user/') && matched
              ? profile(matched)
              : creators.map(feedItem).join('');
          return route.fulfill({
            contentType: 'text/html',
            body: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>抖音</title></head><body>${body}</body></html>`,
          });
        });
        return sourceBrowser;
      },
      uploadScreenshot: (input) =>
        uploadScreenshotEvidence(
          { ...input, apiBaseUrl: apiUrl },
          tokenStore,
          async (url, init) => {
            const parsed = new URL(String(url));
            if (parsed.hostname !== 'evidence.test') return fetch(url, init);
            if (failUpload) {
              failUpload = false;
              return { ok: false, status: 503, json: async () => ({}) };
            }
            expect(init?.method).toBe('PUT');
            const headers = new Headers(init?.headers);
            expect(headers.has('authorization')).toBe(false);
            uploads.set(parsed.pathname.slice(1), {
              byteSize: Number(headers.get('content-length')),
              checksumSha256: headers.get('x-oss-meta-sha256'),
              contentType: headers.get('content-type'),
              etag: 'fixture',
            });
            return { ok: true, status: 200, json: async () => ({}) };
          },
        ),
    };
    let runtime = new CollectorRuntime(runtimeOptions);
    const controlOptions = { apiClient: client, profileStore, runtime };
    collector = createCollectorControlServer(controlOptions);
    await listenCollectorControlServer(collector, 0);
    const address = collector.address();
    if (!address || typeof address === 'string') throw new Error('Collector did not listen');
    const collectorUrl = `http://127.0.0.1:${address.port}`;
    const rejected = await fetch(`${collectorUrl}/control/api/profiles`, {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'forbidden' }),
    });
    expect(rejected.status).toBe(403);

    await page.goto('/');
    await page.getByLabel('工作邮箱').fill(email);
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录工作台' }).click();
    await expect(page.getByRole('heading', { name: /把值得联系的人/ })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('workspace-desktop.png'), fullPage: true });
    // Losing tab storage must not leave a logged-in tab unable to write.
    await page.evaluate(() => sessionStorage.clear());
    await page.reload();
    await page.getByRole('button', { name: '采集设备', exact: true }).click();
    await page.getByRole('button', { name: '生成配对码' }).click();
    const code = await page.locator('.pairing-strip strong').innerText();
    const localPage = await page.context().newPage();
    await localPage.goto(collectorUrl);
    await localPage.getByLabel('设备名称').fill('流程测试电脑');
    await localPage.getByLabel('配对码', { exact: true }).fill(code);
    await localPage.getByRole('button', { name: '完成配对' }).click();
    await expect(localPage.locator('#connection')).toHaveText('已连接团队');
    await localPage.getByLabel('新画像名称').fill('校园测试画像');
    await localPage.getByRole('button', { name: '创建画像' }).click();
    await expect(localPage.getByLabel('当前画像')).toContainText('校园测试画像');
    expect(launchCount).toBe(0);
    await page.getByRole('button', { name: '筛选任务', exact: true }).click();
    await page.getByRole('button', { name: '新建筛选任务' }).click();
    await page.getByLabel('任务名称').fill('流程验收任务');
    await page.getByLabel('最多浏览作品').fill('3');
    await page.getByRole('button', { name: '保存筛选任务' }).click();
    await page.getByRole('button', { name: '创建运行', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('人工开始');
    await page.screenshot({ path: testInfo.outputPath('campaign-created.png'), fullPage: true });
    await localPage.getByRole('button', { name: '刷新任务' }).click();
    await localPage.getByRole('button', { name: '人工开始' }).click();
    await expect(localPage.getByText('状态：已暂停')).toBeVisible({ timeout: 20_000 });
    expect((await runtime.status()).pendingEvidence).toBe(true);
    // Recreate the process coordinator from disk; polling must never resume browsing.
    await sourceBrowser?.close();
    runtime = new CollectorRuntime(runtimeOptions);
    controlOptions.runtime = runtime;
    await localPage.reload();
    await expect(localPage.getByRole('button', { name: '继续', exact: true })).toBeVisible();
    expect(launchCount).toBe(1);
    await localPage.getByRole('button', { name: '继续', exact: true }).click();
    await expect
      .poll(
        async () => ({
          ...(await runtime.status()),
          runStatus: (await client.syncRuns())[0]?.status,
        }),
        { timeout: 20_000 },
      )
      .toMatchObject({ runStatus: 'completed' });
    await expect(localPage.getByText('状态：已完成')).toBeVisible({ timeout: 35_000 });
    expect(launchCount).toBe(2);
    expect(ingestionRequests).toBeGreaterThanOrEqual(3);
    expect(uploads.size).toBe(2);
    const [counts] = await pool.query<RowDataPacket[]>(
      `SELECT
         (SELECT COUNT(*) FROM creator_observations WHERE workspace_id = ?) AS observations,
         (SELECT COUNT(*) FROM campaign_candidates WHERE workspace_id = ?) AS candidates,
         (SELECT COUNT(*) FROM media_objects WHERE workspace_id = ? AND status = 'confirmed') AS evidence`,
      [workspaceId, workspaceId, workspaceId],
    );
    expect(counts[0]).toMatchObject({ observations: 3, candidates: 2, evidence: 2 });
    await localPage.screenshot({
      path: testInfo.outputPath('collector-completed.png'),
      fullPage: true,
    });
    // 未入库达人没有候选行，运营只能靠运行详情里重算出的判定依据判断为什么没进复核队列。
    await page.getByRole('button', { name: '运行监控', exact: true }).click();
    await expect(page.getByRole('heading', { name: '本次运行观察到的达人' })).toBeVisible();
    await expect(
      page.locator('.detail-section-heading').filter({ hasText: '本次运行观察到的达人' }),
    ).toContainText('共 3 位 · 已入库 2 位');
    const admittedCard = page.locator('.evaluation-card').filter({ hasText: '流程测试同学' });
    await expect(admittedCard).toContainText('已入库 · 待复核');
    await expect(admittedCard).toContainText('粉丝 1,200（1200）');
    await expect(admittedCard).toContainText('命中 12,000 赞');
    const rejectedCard = page.locator('.evaluation-card').filter({ hasText: '超范围同学' });
    await expect(rejectedCard).toContainText('未入库 · 不进入复核队列');
    await expect(rejectedCard).toContainText('粉丝 7,000（7000）');
    await expect(rejectedCard).toContainText('粉丝范围 · 不通过 · 范围 0–5000');
    await expect(rejectedCard.locator('.evidence-outcome')).toHaveText('不通过');
    await page.screenshot({
      path: testInfo.outputPath('run-observed-creators.png'),
      fullPage: true,
    });
    await page.getByRole('button', { name: '达人库', exact: true }).click();
    // 分区轴默认「全部」：只有取得入库资格的两位达人在列，粉丝超范围的同学根本没有候选行。
    await expect(page.getByRole('button', { name: '全部', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByRole('button', { name: /超范围同学/ })).toHaveCount(0);
    await expect(page.locator('.library-count')).toHaveText('2 位达人');
    await page.getByRole('button', { name: '待复核', exact: true }).click();
    await expect(page.locator('.library-count')).toHaveText('2 位待复核');
    await page.getByRole('button', { name: /流程测试同学/ }).click();
    await expect(page.getByRole('heading', { name: '私有证据截图' })).toBeVisible();
    // 截图必须在打开详情时自动取到签名地址，运营不该再为每张图点一次「查看截图」。
    await expect(page.getByRole('img', { name: /证据截图/u }).first()).toBeVisible();
    // 快速复核路径默认只显示结论下拉与保存按钮，理由收在可选折叠里。
    await page.getByText('补充理由（可选）').click();
    await page.getByLabel('理由', { exact: true }).fill('已人工核验公开内容，适合进一步沟通');
    await page.getByRole('button', { name: '保存人工结论' }).click();
    await expect(page.getByText(/最新人工结论：通过/)).toBeVisible();
    // 复核通过在同一次请求内推进阶段；面板必须自行刷新，否则运营的下一次操作会带着过期版本撞 409。
    await expect(
      page.locator('.detail-section-heading').filter({ hasText: '人工复核与合作跟进' }),
    ).toContainText('待联系');
    await expect(page.locator('input[name="nextStatus"]')).toHaveValue('to_contact');
    // 阶段已在服务端推进，列表跟着离开「待复核」分区，运营不需要手工刷新。
    await expect(page.locator('.library-count')).toHaveText('1 位待复核');
    await expect(page.getByRole('button', { name: /流程测试同学/ })).toHaveCount(0);
    // 联系资料与沟通记录收在跟进用的折叠区里，复核阶段不占屏。
    await page.getByText('联系资料与沟通记录（跟进阶段再填）').click();
    await page.getByRole('button', { name: /负责人/ }).click();
    await page.getByRole('option', { name: '流程验收员', exact: true }).click();
    await page.getByLabel('联系渠道', { exact: true }).fill('抖音');
    await page.getByLabel('下一步', { exact: true }).fill('人工联系确认合作意愿');
    await page.getByRole('button', { name: '保存联系资料' }).click();
    await expect(page.getByText(/当前负责人：流程验收员/)).toBeVisible();
    await expect(page.locator('input[name="ownerUserId"]')).toHaveValue(/.+/u);
    await page.getByLabel('联系渠道', { exact: true }).fill('人工抖音联系');
    const savedDetail = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        /^\/candidates\/[^/]+$/u.test(new URL(response.url()).pathname),
    );
    await page.getByRole('button', { name: '保存联系资料' }).click();
    const updatedDetail = await (await savedDetail).json();
    expect(updatedDetail.workflow.outreach).toMatchObject({
      ownerDisplayName: '流程验收员',
      contactChannel: '人工抖音联系',
    });
    await expect(page.getByLabel('联系渠道', { exact: true })).toHaveValue('人工抖音联系');
    await expect(page.getByText(/当前负责人：流程验收员/)).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('candidate-reviewed.png'), fullPage: true });
    // 另一条腿：复核不通过把阶段推到「不符合」，达人从「待复核」分区落到「不合适」分区。
    await page.getByRole('button', { name: /二号同学/ }).click();
    const reviewForm = page.locator('form.workflow-form').filter({ hasText: '复核结论' });
    await reviewForm.getByRole('button', { name: /^结论/u }).click();
    await reviewForm.getByRole('option', { name: '不符合', exact: true }).click();
    await reviewForm.getByText('补充理由（可选）').click();
    await reviewForm.getByLabel('理由', { exact: true }).fill('人设与校园情侣定位不符');
    await page.getByRole('button', { name: '保存人工结论' }).click();
    await expect(page.getByText(/最新人工结论：不符合/)).toBeVisible();
    await expect(
      page.locator('.detail-section-heading').filter({ hasText: '人工复核与合作跟进' }),
    ).toContainText('不符合');
    await expect(page.locator('.library-count')).toHaveText('0 位待复核');
    await page.getByRole('button', { name: '不合适', exact: true }).click();
    await expect(page.locator('.library-count')).toHaveText('1 位不合适');
    await expect(page.getByRole('button', { name: /二号同学/ })).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath('library-unsuitable-section.png'),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: '今日工作', exact: true }).click();
    // 工作台三个计数器必须与达人库分区同口径：待复核清零，待联系与「我负责的」各剩 1 位。
    for (const [label, expected] of [
      ['待复核', '0'],
      ['待联系', '1'],
      ['我负责的', '1'],
    ] as const) {
      await expect(
        page.locator('.dashboard-card').filter({ hasText: label }).locator('strong'),
      ).toHaveText(expected);
    }
    await page.screenshot({ path: testInfo.outputPath('workspace-mobile.png'), fullPage: true });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await localPage.close();
  } finally {
    await sourceBrowser?.close();
    if (collector) await new Promise<void>((resolve) => collector!.close(() => resolve()));
    await api.close();
    await pool.end();
    await rm(dataRoot, { recursive: true, force: true });
  }
});
