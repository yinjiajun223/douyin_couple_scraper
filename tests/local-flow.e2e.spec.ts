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
      /^\/(auth|campaigns|campaign-templates|candidates|runs|devices|members|dashboard|ai-connections|audit-events|media)(\/|$)/u;
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
          const profile = new URL(route.request().url()).pathname.startsWith('/user/');
          const publishedAt = new Date(Date.now() - 86_400_000).toISOString();
          const body = profile
            ? `<h1 data-e2e="user-title">流程测试同学</h1><p data-e2e="user-desc">校园日常</p><p>粉丝 1200</p><article data-e2e="user-post-item"><a href="/video/7600000000000000001">公开作品</a><span data-e2e="video-like-count">1.2万</span><time datetime="${publishedAt}"></time></article>`
            : '<article data-e2e="feed-item"><a href="/video/7600000000000000001">公开作品</a><a href="/user/flow-creator">流程测试同学</a><span data-e2e="video-like-count">1.2万</span></article>';
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
    await page.getByLabel('最多浏览作品').fill('1');
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
    expect(uploads.size).toBe(1);
    const [counts] = await pool.query<RowDataPacket[]>(
      `SELECT
         (SELECT COUNT(*) FROM creator_observations WHERE workspace_id = ?) AS observations,
         (SELECT COUNT(*) FROM campaign_candidates WHERE workspace_id = ?) AS candidates,
         (SELECT COUNT(*) FROM media_objects WHERE workspace_id = ? AND status = 'confirmed') AS evidence`,
      [workspaceId, workspaceId, workspaceId],
    );
    expect(counts[0]).toMatchObject({ observations: 1, candidates: 1, evidence: 1 });
    await localPage.screenshot({
      path: testInfo.outputPath('collector-completed.png'),
      fullPage: true,
    });
    await page.getByRole('button', { name: '达人库', exact: true }).click();
    await page.getByRole('button', { name: /流程测试同学/ }).click();
    await expect(page.getByRole('heading', { name: '私有证据截图' })).toBeVisible();
    await page.getByLabel('理由', { exact: true }).fill('已人工核验公开内容，适合进一步沟通');
    await page.getByRole('button', { name: '保存人工结论' }).click();
    await expect(page.getByText(/最新人工结论：通过/)).toBeVisible();
    await page.getByRole('button', { name: /负责人/ }).click();
    await page.getByRole('option', { name: '流程验收员', exact: true }).click();
    await page.getByLabel('联系渠道', { exact: true }).fill('抖音');
    await page.getByLabel('下一步', { exact: true }).fill('人工联系确认合作意愿');
    await page.getByRole('button', { name: '保存联系资料' }).click();
    await expect(page.getByText(/当前负责人：流程验收员/)).toBeVisible();
    await expect(page.locator('input[name="ownerUserId"]')).toHaveValue(/.+/u);
    await page.getByRole('button', { name: /下一阶段/ }).click();
    await page.getByRole('option', { name: '待联系', exact: true }).click();
    await page.getByRole('button', { name: '更新阶段' }).click();
    await expect(
      page.locator('.detail-section-heading').filter({ hasText: '人工复核与合作跟进' }),
    ).toContainText('待联系');
    await expect(page.locator('input[name="nextStatus"]')).toHaveValue('to_contact');
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
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: '今日工作', exact: true }).click();
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
