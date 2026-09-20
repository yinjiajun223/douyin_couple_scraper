import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

async function mockWorkspace(page: Page) {
  const responses: Record<string, unknown> = {
    '/audit-events': { events: [] },
    '/campaign-templates': { templates: [] },
    '/campaigns': { campaigns: [] },
    '/candidates': { candidates: [] },
    '/dashboard': {
      failedRuns: 1,
      myAssignments: 2,
      pendingReview: 3,
      runningRuns: 1,
      toContact: 2,
    },
    '/devices': { devices: [] },
    '/members': { members: [] },
    '/runs': { runs: [] },
  };
  await page.route('**/auth/me', async (route) =>
    route.fulfill({
      json: {
        user: {
          displayName: '可访问性管理员',
          email: 'a11y@example.test',
          id: 'a11y-admin',
          role: 'admin',
          workspaceId: '00000000-0000-4000-8000-000000000001',
        },
      },
    }),
  );
  for (const [path, json] of Object.entries(responses)) {
    await page.route(`**${path}`, async (route) => route.fulfill({ json }));
  }
}

test('工作台通过 WCAG A/AA 自动检查并保留键盘焦点', async ({ page }) => {
  await mockWorkspace(page);
  await page.goto('/');
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(results.violations).toEqual([]);

  await page.keyboard.press('Tab');
  const focused = page.locator(':focus');
  await expect(focused).toBeVisible();
  const outlineWidth = await focused.evaluate((element) => getComputedStyle(element).outlineWidth);
  expect(outlineWidth).not.toBe('0px');
});

test('390px 窄屏没有页面级横向溢出且导航仍可键盘操作', async ({ page }) => {
  await mockWorkspace(page);
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto('/');
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
  await page.getByRole('button', { name: '筛选任务', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: '筛选任务' })).toBeVisible();
});
