import { expect, test } from '@playwright/test';

import { COLLECTOR_CONTROL_HTML } from '../apps/collector/src/control-page.js';

test('未配对的本地助手提供完整配对入口', async ({ page }) => {
  await page.route('http://collector-pair.local/**', (route) => {
    if (new URL(route.request().url()).pathname === '/') {
      return route.fulfill({ contentType: 'text/html', body: COLLECTOR_CONTROL_HTML });
    }
    return route.fulfill({
      json: { paired: false, profiles: [], runs: [], selectedProfileId: null },
    });
  });
  await page.goto('http://collector-pair.local/');
  await expect(page.getByLabel('配对码', { exact: true })).toBeVisible({ timeout: 3000 });
  await expect(page.getByRole('button', { name: '完成配对' })).toBeVisible();
});

test('本地控制页只能由人工点击开始，页面同步不会启动浏览器', async ({ page }) => {
  let actionCalls = 0;
  let runStatus = 'ready';
  await page.route('http://collector.local/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') {
      return route.fulfill({ contentType: 'text/html', body: COLLECTOR_CONTROL_HTML });
    }
    if (url.pathname === '/control/api/state') {
      return route.fulfill({
        contentType: 'application/json',
        json: {
          profiles: [{ id: 'profile-1', label: '校园圈层' }],
          selectedProfileId: 'profile-1',
          runtime: { activeRunId: runStatus === 'running' ? 'run-1' : null },
          runs: [
            {
              id: 'run-1',
              campaignName: '18-24 岁素人爆款',
              progress: { candidatesFound: 0, creatorProfilesSeen: 0, feedItemsSeen: 0 },
              status: runStatus,
            },
          ],
        },
      });
    }
    if (url.pathname === '/control/api/runs/run-1/start') {
      actionCalls += 1;
      runStatus = 'running';
      return route.fulfill({
        contentType: 'application/json',
        json: { id: 'run-1', status: runStatus },
      });
    }
    return route.fulfill({ status: 404, contentType: 'application/json', json: {} });
  });

  await page.goto('http://collector.local/');
  await expect(page.getByRole('heading', { name: '抖音采集助手' })).toBeVisible();
  await expect(page.getByText('18-24 岁素人爆款')).toBeVisible();
  await page.waitForTimeout(500);
  expect(actionCalls).toBe(0);

  await page.getByRole('button', { name: '人工开始' }).click();
  await expect(page.getByText('状态：采集中')).toBeVisible();
  expect(actionCalls).toBe(1);
});

test('版本过低时控制页显示升级阻断且没有开始入口', async ({ page }) => {
  await page.route('http://collector-upgrade.local/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') {
      return route.fulfill({ contentType: 'text/html', body: COLLECTOR_CONTROL_HTML });
    }
    return route.fulfill({
      contentType: 'application/json',
      json: {
        connectionError: '采集助手版本过低，需要升级到 2.4.0 或更高版本后才能继续。',
        profiles: [{ id: 'profile-1', label: '校园圈层' }],
        runs: [],
        selectedProfileId: 'profile-1',
      },
    });
  });

  await page.goto('http://collector-upgrade.local/');
  await expect(page.getByRole('status')).toContainText('需要升级到 2.4.0');
  await expect(page.getByRole('button', { name: '人工开始' })).toHaveCount(0);
});

test('运行过程中也可将未识别与低可信度策略即时设为永不暂停', async ({ page }) => {
  let savedPolicy: unknown;
  await page.route('http://collector-policy.local/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') {
      return route.fulfill({ contentType: 'text/html', body: COLLECTOR_CONTROL_HTML });
    }
    if (url.pathname === '/control/api/settings/low-confidence') {
      savedPolicy = route.request().postDataJSON();
      return route.fulfill({
        contentType: 'application/json',
        json: { lowConfidencePolicy: savedPolicy },
      });
    }
    return route.fulfill({
      contentType: 'application/json',
      json: {
        paired: true,
        profiles: [],
        runs: [
          {
            id: 'run-1',
            progress: { candidatesFound: 0, creatorProfilesSeen: 3, feedItemsSeen: 3 },
            status: 'running',
          },
        ],
        runtime: {
          activeRunId: 'run-1',
          lowConfidencePolicy: { consecutiveLimit: 3, mode: 'pause_after_consecutive' },
        },
        selectedProfileId: null,
      },
    });
  });

  await page.goto('http://collector-policy.local/');
  await page.getByLabel('处理方式').selectOption('never_pause');
  await expect(page.getByLabel('连续次数')).toBeHidden();
  await page.getByRole('button', { name: '保存策略' }).click();
  await expect(page.getByRole('status')).toContainText('未识别与低可信度处理策略已保存到本机');
  expect(savedPolicy).toEqual({ mode: 'never_pause' });
});
