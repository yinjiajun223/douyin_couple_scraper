import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

type Role = 'admin' | 'operator' | 'readonly';

const labels = { admin: '管理员', operator: '运营', readonly: '只读' } as const;
const candidatesRoute = /\/candidates(?:\?.*)?$/;
const observedCreatorsRoute = /\/runs\/[^/]+\/observed-creators$/u;
const observedCreators = [
  {
    admitted: true,
    candidateId: 'candidate-1',
    creatorId: 'creator-1',
    evaluations: [
      {
        evidence: { maximum: 5_000, minimum: 0, observedRawValue: '1200', observedValue: 1_200 },
        outcome: 'pass',
        ruleId: 'followers',
        ruleType: 'follower-range',
      },
      {
        evidence: {
          matchedPosts: [
            {
              likeCount: 12_000,
              likeCountRaw: '1.2万',
              publishedAt: '2026-09-14T08:00:00.000Z',
            },
          ],
          minimumLikes: 10_000,
          unknownPosts: [],
        },
        outcome: 'pass',
        ruleId: 'recent-viral-post',
        ruleType: 'recent-post-likes',
      },
    ],
    followerCount: 1_200,
    followerCountRaw: '1200',
    nickname: '已入库同学',
    observationId: 'observation-1',
    observedAt: '2026-09-15T08:00:00.000Z',
    outcome: 'pass',
    pipelineStatus: 'pending_review',
    platformCreatorId: 'creator-1',
    profileUrl: 'https://www.douyin.com/user/creator-1',
  },
  {
    admitted: false,
    candidateId: null,
    creatorId: 'creator-2',
    evaluations: [
      {
        evidence: { maximum: 5_000, minimum: 0, observedRawValue: null, reason: 'missing' },
        outcome: 'unknown',
        ruleId: 'followers',
        ruleType: 'follower-range',
      },
      {
        evidence: {
          matchedPosts: [],
          minimumLikes: 10_000,
          unknownPosts: [{ likeCount: null, likeCountRaw: null, publishedAt: null }],
        },
        outcome: 'unknown',
        ruleId: 'recent-viral-post',
        ruleType: 'recent-post-likes',
      },
    ],
    followerCount: null,
    followerCountRaw: null,
    nickname: '缺数据同学',
    observationId: 'observation-2',
    observedAt: '2026-09-15T08:05:00.000Z',
    outcome: 'unknown',
    pipelineStatus: null,
    platformCreatorId: 'creator-2',
    profileUrl: 'https://www.douyin.com/user/creator-2',
  },
];

test('已保存的任务可以创建运行，并提示去本机人工开始', async ({ page }) => {
  await mockAuthenticatedWorkspace(page, 'operator');
  await page.route('**/campaigns', (route) =>
    route.fulfill({
      json: {
        campaigns: [
          {
            id: 'campaign-flow',
            name: '校园圈层',
            status: 'active',
            version: 1,
            recommendation_profile_description: '校园日常',
          },
        ],
      },
    }),
  );
  let creations = 0;
  await page.route('**/campaigns/campaign-flow/runs', (route) => {
    creations += 1;
    return route.fulfill({ status: 201, json: { id: 'run-flow', status: 'ready' } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '筛选任务', exact: true }).click();
  await expect(page.getByRole('button', { name: '创建运行', exact: true })).toBeVisible({
    timeout: 3000,
  });
  await page.getByRole('button', { name: '创建运行', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('人工开始');
  expect(creations).toBe(1);
});

async function mockAuthenticatedWorkspace(page: Page, role: Role) {
  await page.route('**/auth/me', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      json: {
        user: {
          id: `${role}-user`,
          workspaceId: '00000000-0000-4000-8000-000000000001',
          email: `${role}@example.test`,
          displayName: `${labels[role]}同事`,
          role,
        },
      },
    });
  });
  await page.route('**/members', async (route) => {
    await route.fulfill({ contentType: 'application/json', json: { members: [] } });
  });
  await page.route('**/members/assignable', async (route) =>
    route.fulfill({ json: { members: [] } }),
  );
  await page.route('**/devices', async (route) => {
    await route.fulfill({ contentType: 'application/json', json: { devices: [] } });
  });
  await page.route('**/campaigns', async (route) => {
    await route.fulfill({ contentType: 'application/json', json: { campaigns: [] } });
  });
  await page.route('**/runs', async (route) => {
    await route.fulfill({ contentType: 'application/json', json: { runs: [] } });
  });
  await page.route(observedCreatorsRoute, async (route) => {
    await route.fulfill({ contentType: 'application/json', json: { creators: [] } });
  });
  await page.route(candidatesRoute, async (route) => {
    await route.fulfill({ contentType: 'application/json', json: { candidates: [] } });
  });
  await page.route('**/dashboard', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      json: { failedRuns: 0, myAssignments: 0, pendingReview: 0, runningRuns: 0, toContact: 0 },
    });
  });
  await page.route('**/campaign-templates', async (route) => {
    await route.fulfill({ contentType: 'application/json', json: { templates: [] } });
  });
  await page.route('**/audit-events', async (route) => {
    await route.fulfill({ contentType: 'application/json', json: { events: [] } });
  });
}

test('未登录成员看到登录页并可进入工作台', async ({ page }) => {
  await page.route('**/auth/me', async (route) => {
    await route.fulfill({ status: 401, contentType: 'application/json', json: {} });
  });
  await page.route('**/auth/login', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      json: {
        csrfToken: 'test-csrf',
        user: {
          id: 'admin-user',
          workspaceId: '00000000-0000-4000-8000-000000000001',
          email: 'admin@example.test',
          displayName: '测试管理员',
          role: 'admin',
        },
      },
    });
  });
  await page.route('**/members', async (route) => route.fulfill({ json: { members: [] } }));
  await page.route('**/devices', async (route) => route.fulfill({ json: { devices: [] } }));
  await page.route('**/campaigns', async (route) => route.fulfill({ json: { campaigns: [] } }));
  await page.route('**/runs', async (route) => route.fulfill({ json: { runs: [] } }));
  await page.route(candidatesRoute, async (route) => route.fulfill({ json: { candidates: [] } }));
  await page.route('**/dashboard', async (route) =>
    route.fulfill({
      json: { failedRuns: 0, myAssignments: 0, pendingReview: 0, runningRuns: 0, toContact: 0 },
    }),
  );
  await page.route('**/campaign-templates', async (route) =>
    route.fulfill({ json: { templates: [] } }),
  );
  await page.route('**/audit-events', async (route) => route.fulfill({ json: { events: [] } }));

  await page.goto('/');
  await expect(page.getByRole('heading', { name: '回到工作台' })).toBeVisible();
  await page.getByLabel('工作邮箱').fill('admin@example.test');
  await page.getByLabel('密码').fill('StrongAdmin2026');
  await page.getByRole('button', { name: '登录工作台' }).click();
  await expect(page.getByRole('heading', { name: /把值得联系的人/ })).toBeVisible();
});

test('邀请链接显示一次性账号设置页', async ({ page }) => {
  await page.goto('/?invite=test-invitation-token');
  await expect(page.getByRole('heading', { name: /加入星探台/ })).toBeVisible();
  await expect(page.getByRole('button', { name: '接受邀请并创建账号' })).toBeVisible();
  await expect(page.getByText('这条链接只能使用一次')).toBeVisible();
});

test('运营首页计数可跳转到对应候选和运行过滤结果', async ({ page }) => {
  await mockAuthenticatedWorkspace(page, 'operator');
  await page.unroute('**/dashboard');
  await page.unroute(candidatesRoute);
  await page.unroute('**/runs');
  await page.route('**/dashboard', async (route) =>
    route.fulfill({
      json: { failedRuns: 1, myAssignments: 1, pendingReview: 1, runningRuns: 1, toContact: 1 },
    }),
  );
  await page.route(candidatesRoute, async (route) =>
    route.fulfill({
      json: {
        candidates: [
          {
            campaignName: '首页任务',
            followerCount: 900,
            hardFilterStatus: 'pass',
            id: 'pending-one',
            manualDecision: 'pending',
            nickname: '待复核达人',
            observedAt: '2026-09-15T08:00:00.000Z',
            ownerUserId: null,
            pipelineStatus: 'pending_review',
            profileUrl: 'https://www.douyin.com/user/pending',
            tags: [],
          },
          {
            campaignName: '首页任务',
            followerCount: 700,
            hardFilterStatus: 'pass',
            id: 'contact-one',
            manualDecision: 'approved',
            nickname: '待联系达人',
            observedAt: '2026-09-15T08:00:00.000Z',
            ownerUserId: 'operator-user',
            pipelineStatus: 'to_contact',
            profileUrl: 'https://www.douyin.com/user/contact',
            tags: [],
          },
        ],
      },
    }),
  );
  const runBase = {
    campaignId: 'campaign',
    campaignName: '首页任务',
    claimedAt: null,
    createdAt: '2026-09-15T08:00:00.000Z',
    device: null,
    endedAt: null,
    errorCode: null,
    errorMessage: null,
    progress: { candidatesFound: 0, creatorProfilesSeen: 0, elapsedSeconds: 0, feedItemsSeen: 0 },
    ruleVersion: 1,
    startedAt: null,
    stopReason: null,
    updatedAt: '2026-09-15T08:00:00.000Z',
  };
  await page.route('**/runs', async (route) =>
    route.fulfill({
      json: {
        runs: [
          { ...runBase, id: 'run-active', status: 'running', campaignName: '运行中的首页任务' },
          {
            ...runBase,
            id: 'run-failed',
            status: 'failed',
            campaignName: '失败的首页任务',
            errorCode: 'TEST_FAILURE',
          },
        ],
      },
    }),
  );

  await page.goto('/');
  await expect(page.locator('.dashboard-card')).toHaveCount(5);
  await page.locator('.dashboard-card').filter({ hasText: '待复核' }).click();
  await expect(page.getByRole('button', { name: /待复核达人/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /待联系达人/ })).toHaveCount(0);
  await page.getByRole('button', { name: '今日工作' }).click();
  await page.locator('.dashboard-card').filter({ hasText: '我负责的' }).click();
  await expect(page.getByRole('button', { name: /待联系达人/ })).toBeVisible();
  await page.getByRole('button', { name: '今日工作' }).click();
  await page.locator('.dashboard-card').filter({ hasText: '失败任务' }).click();
  await expect(page.getByRole('button', { name: /失败的首页任务/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /运行中的首页任务/ })).toHaveCount(0);
  await page.getByRole('button', { name: '运行监控', exact: true }).click();
  await expect(page.getByRole('button', { name: /运行中的首页任务/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /失败的首页任务/ })).toBeVisible();
  await page.getByRole('button', { name: '达人库', exact: true }).click();
  await expect(page.getByRole('button', { name: /待复核达人/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /待联系达人/ })).toBeVisible();
});

test('达人库按跟进阶段分区，不再提供待补证据入口', async ({ page }) => {
  await mockAuthenticatedWorkspace(page, 'operator');
  await page.unroute(candidatesRoute);
  const candidateBase = {
    archivedAt: null,
    campaignName: '校园任务',
    followerCount: 1_200,
    manualDecision: 'pending',
    observedAt: '2026-09-16T08:00:00.000Z',
    ownerUserId: null,
    tags: [],
    version: 1,
  };
  const library = [
    { id: 'pending', nickname: '待复核同学', pipelineStatus: 'pending_review' },
    { id: 'to-contact', nickname: '待联系同学', pipelineStatus: 'to_contact' },
    { id: 'contacted', nickname: '已联系同学', pipelineStatus: 'contacted' },
    { id: 'communicating', nickname: '沟通中同学', pipelineStatus: 'communicating' },
    { id: 'partnered', nickname: '已合作同学', pipelineStatus: 'partnered' },
    { id: 'unsuitable', nickname: '不符合同学', pipelineStatus: 'unsuitable' },
    { id: 'declined', nickname: '不合作同学', pipelineStatus: 'declined' },
  ].map((candidate) => ({
    ...candidateBase,
    profileUrl: `https://www.douyin.com/user/${candidate.id}`,
    ...candidate,
  }));
  // 真实接口按 pipelineStatuses 在服务端过滤并分页，mock 照做：
  // 分区若退化成「拉一整页再前端筛选」，下面的可见性断言会立刻失败。
  await page.route(candidatesRoute, (route) => {
    const statuses = (new URL(route.request().url()).searchParams.get('pipelineStatuses') ?? '')
      .split(',')
      .filter(Boolean);
    return route.fulfill({
      json: {
        candidates: library.filter((candidate) => statuses.includes(candidate.pipelineStatus)),
        nextCursor: null,
      },
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: '达人库', exact: true }).click();
  await expect(page.getByRole('button', { name: '全部', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('button', { name: '待补证据', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /待复核同学/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /沟通中同学/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /不合作同学/ })).toBeVisible();
  await expect(page.locator('.library-count')).toHaveText('7 位达人');

  await page.getByRole('button', { name: '跟进中', exact: true }).click();
  await expect(page.getByRole('button', { name: /已联系同学/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /沟通中同学/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /待复核同学/ })).toHaveCount(0);
  await expect(page.locator('.library-count')).toHaveText('2 位跟进中');

  await page.getByRole('button', { name: '不合适', exact: true }).click();
  await expect(page.getByRole('button', { name: /不符合同学/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /不合作同学/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /已合作同学/ })).toHaveCount(0);
  await expect(page.locator('.library-count')).toHaveText('2 位不合适');
});

test('达人库支持日期分组、管理员成员筛选和游标加载更多', async ({ page }) => {
  await mockAuthenticatedWorkspace(page, 'admin');
  await page.unroute('**/members');
  await page.unroute(candidatesRoute);
  await page.route('**/members', (route) =>
    route.fulfill({
      json: {
        members: [
          {
            id: 'operator-filter-id',
            displayName: '小林运营',
            email: 'lin@example.test',
            role: 'operator',
            status: 'active',
          },
        ],
      },
    }),
  );
  const requestedUrls: string[] = [];
  const now = new Date().toISOString();
  const candidate = (id: string, nickname: string) => ({
    archivedAt: null,
    campaignName: '日期任务',
    firstVisibleAt: now,
    followerCount: 1_200,
    hardFilterStatus: 'pass',
    id,
    manualDecision: 'pending',
    nickname,
    observedAt: now,
    ownerUserId: null,
    pipelineStatus: 'pending_review',
    profileUrl: `https://www.douyin.com/user/${id}`,
    tags: [],
    version: 1,
  });
  await page.route(candidatesRoute, (route) => {
    const url = route.request().url();
    requestedUrls.push(url);
    const parsed = new URL(url);
    if (!parsed.searchParams.has('pipelineStatuses')) {
      return route.fulfill({ json: { candidates: [], nextCursor: null } });
    }
    if (parsed.searchParams.has('cursor')) {
      return route.fulfill({
        json: { candidates: [candidate('date-second', '第二页达人')], nextCursor: null },
      });
    }
    return route.fulfill({
      json: { candidates: [candidate('date-first', '第一页达人')], nextCursor: 'next-page' },
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: '达人库', exact: true }).click();
  await expect(page.locator('.candidate-date-heading strong', { hasText: '今天' })).toBeVisible();
  await page.getByRole('button', { name: /发现日期/ }).click();
  await page.getByRole('option', { name: '今天', exact: true }).click();
  await expect.poll(() => requestedUrls.some((url) => url.includes('discoveredFrom='))).toBe(true);
  const memberSelect = page.getByRole('button', { name: /运营成员/ });
  await memberSelect.focus();
  await memberSelect.press('ArrowDown');
  await expect(page.getByRole('option', { name: '全部成员', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('option', { name: '小林运营', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect
    .poll(() => requestedUrls.some((url) => url.includes('memberUserId=operator-filter-id')))
    .toBe(true);
  await page.getByRole('button', { name: '加载更多' }).click();
  await expect(page.getByRole('button', { name: /第二页达人/ })).toBeVisible();
});

/** 详情接口的最小夹具：只放被测界面真正读取的字段，免得每个用例重复三十行。 */
function candidateDetailFixture(
  id: string,
  overrides: {
    archivedAt?: string | null;
    nickname?: string;
    tags?: string[];
    version?: number;
  } = {},
) {
  const observedAt = new Date().toISOString();
  const version = overrides.version ?? 1;
  return {
    candidate: {
      archivedAt: overrides.archivedAt ?? null,
      campaignName: '标签任务',
      id,
      pipelineStatus: 'pending_review',
      tags: overrides.tags ?? [],
      version,
    },
    observations: [
      {
        id: `${id}-observation`,
        nickname: overrides.nickname ?? '详情同学',
        biography: null,
        profileUrl: `https://www.douyin.com/user/${id}`,
        followerCount: 1_200,
        followerCountRaw: '1200',
        observedAt,
        device: { id: 'device-1', name: '运营电脑一号' },
      },
    ],
    sources: [],
    evaluations: [],
    media: [],
    workflow: {
      candidateVersion: version,
      pipelineStatus: 'pending_review',
      reviews: [],
      outreach: null,
      notes: [],
      events: [],
    },
  };
}

/** 达人库列表项夹具：批量操作要按条携带 expectedVersion，所以 version 必填。 */
function candidateSummaryFixture(
  id: string,
  nickname: string,
  version: number,
  tags: string[] = [],
) {
  const now = new Date().toISOString();
  return {
    archivedAt: null,
    campaignName: '批量任务',
    firstVisibleAt: now,
    followerCount: 1_200,
    id,
    manualDecision: 'pending',
    nickname,
    observedAt: now,
    ownerUserId: null,
    pipelineStatus: 'pending_review',
    profileUrl: `https://www.douyin.com/user/${id}`,
    tags,
    version,
  };
}

test('批量操作只提交勾选的达人，部分失败按原因归并成一句话', async ({ page }) => {
  await mockAuthenticatedWorkspace(page, 'operator');
  await page.unroute(candidatesRoute);
  const library = [
    candidateSummaryFixture('batch-a', '批量同学甲', 1),
    candidateSummaryFixture('batch-b', '批量同学乙', 2),
    candidateSummaryFixture('batch-c', '批量同学丙', 3),
  ];
  const batchRequests: Array<{ body: unknown; url: string }> = [];
  await page.route(candidatesRoute, (route) =>
    route.fulfill({ json: { candidates: library, nextCursor: null } }),
  );
  await page.route('**/candidates/batch-reviews', (route) => {
    batchRequests.push({ body: route.request().postDataJSON(), url: route.request().url() });
    return route.fulfill({
      json: {
        failed: 1,
        results: [
          { id: 'batch-a', ok: true },
          { code: 'VERSION_CONFLICT', currentVersion: 9, id: 'batch-c', ok: false },
        ],
        succeeded: 1,
      },
    });
  });
  await page.route('**/candidates/batch-archive', (route) => {
    batchRequests.push({ body: route.request().postDataJSON(), url: route.request().url() });
    return route.fulfill({
      json: { failed: 0, results: [{ id: 'batch-b', ok: true }], succeeded: 1 },
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: '达人库', exact: true }).click();
  await expect(page.locator('.candidate-batch-bar')).toBeVisible();
  // 没勾选就禁用：空批次只会换来一句「已复核通过 0 条」，运营会以为点错了。
  await expect(page.getByRole('button', { name: '批量通过复核' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '批量归档' })).toBeDisabled();
  await page.getByLabel('选择本页全部').check();
  await expect(page.getByText('已选 3 条')).toBeVisible();
  await page.getByLabel('选择批量同学乙').uncheck();
  await expect(page.getByText('已选 2 条')).toBeVisible();
  await page.getByRole('button', { name: '批量通过复核' }).click();
  await expect(page.getByRole('status')).toContainText(
    '已复核通过 1 条，1 条未处理：已被同事修改 1 条',
  );
  expect(batchRequests).toHaveLength(1);
  expect(batchRequests[0]!.url).toContain('/candidates/batch-reviews');
  expect(batchRequests[0]!.body).toEqual({
    decision: 'approved',
    items: [
      { candidateId: 'batch-a', expectedVersion: 1 },
      { candidateId: 'batch-c', expectedVersion: 3 },
    ],
  });
  // 提交后清空勾选：留着的话运营再点一次就是重复提交同一批人。
  await expect(page.getByText('已选 0 条')).toBeVisible();
  await expect(page.getByLabel('选择批量同学甲')).not.toBeChecked();

  await page.getByLabel('选择批量同学乙').check();
  await page.getByRole('button', { name: '批量归档' }).click();
  await expect(page.getByRole('status')).toContainText('已归档 1 条。');
  expect(batchRequests[1]!.body).toEqual({
    items: [{ candidateId: 'batch-b', expectedVersion: 2 }],
  });
});

test('已归档是独立视图，逐条恢复并带上最新版本号', async ({ page }) => {
  await mockAuthenticatedWorkspace(page, 'operator');
  await page.unroute(candidatesRoute);
  const active = candidateSummaryFixture('active-one', '在用同学', 2);
  const archived = {
    ...candidateSummaryFixture('archived-one', '已归档同学', 5),
    archivedAt: '2026-09-20T08:00:00.000Z',
    pipelineStatus: 'communicating',
  };
  const requestedUrls: string[] = [];
  await page.route(candidatesRoute, (route) => {
    const url = route.request().url();
    requestedUrls.push(url);
    const isArchivedView = new URL(url).searchParams.get('archiveView') === 'archived';
    return route.fulfill({
      json: { candidates: isArchivedView ? [archived] : [active], nextCursor: null },
    });
  });
  const unarchiveRequests: unknown[] = [];
  await page.route('**/candidates/archived-one/unarchive', (route) => {
    unarchiveRequests.push(route.request().postDataJSON());
    return route.fulfill({ json: { id: 'archived-one', version: 6 } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: '达人库', exact: true }).click();
  await expect(page.getByRole('button', { name: /在用同学/ })).toBeVisible();
  await expect(page.getByRole('button', { name: '已归档', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await page.getByRole('button', { name: '已归档', exact: true }).click();
  await expect(page.getByRole('button', { name: /已归档同学/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /在用同学/ })).toHaveCount(0);
  // 已归档视图不提供批量勾选：恢复是逐条决定，不该被一次全选带走。
  await expect(page.locator('.candidate-select')).toHaveCount(0);
  await expect(page.locator('.candidate-batch-bar')).toContainText('已归档视图逐条恢复');
  await expect
    .poll(() => requestedUrls.some((url) => url.includes('archiveView=archived')))
    .toBe(true);
  await page.getByRole('button', { name: '恢复', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已恢复「已归档同学」');
  expect(unarchiveRequests).toEqual([{ expectedVersion: 5 }]);
  await page.getByRole('button', { name: '在用列表', exact: true }).click();
  await expect(page.getByRole('button', { name: /在用同学/ })).toBeVisible();
});

test('详情页可编辑标签，达人库可按标签筛选', async ({ page }) => {
  await mockAuthenticatedWorkspace(page, 'operator');
  await page.unroute(candidatesRoute);
  const library = [
    candidateSummaryFixture('tagged-one', '校园同学', 4, ['校园']),
    candidateSummaryFixture('plain-one', '未打标同学', 1),
  ];
  const requestedUrls: string[] = [];
  const tagRequests: unknown[] = [];
  await page.route(candidatesRoute, (route) => {
    requestedUrls.push(route.request().url());
    return route.fulfill({ json: { candidates: library, nextCursor: null } });
  });
  await page.route('**/candidates/tagged-one', (route) =>
    route.fulfill({
      json: candidateDetailFixture('tagged-one', {
        nickname: '校园同学',
        tags: ['校园'],
        version: 4,
      }),
    }),
  );
  await page.route('**/candidates/tagged-one/tags', (route) => {
    tagRequests.push(route.request().postDataJSON());
    return route.fulfill({ json: { id: 'tagged-one', tags: ['校园', '情侣'] } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: '达人库', exact: true }).click();
  await page.getByRole('button', { name: /校园同学/ }).click();
  const detail = page.getByRole('article');
  await expect(detail.getByRole('heading', { name: '标签', exact: true })).toBeVisible();
  await expect(detail.locator('.tag-chip', { hasText: '校园' })).toBeVisible();
  await detail.getByLabel('新标签名').fill('情侣');
  // 回车是「加一个标签」而不是「提交整组」：运营通常连着敲好几个。
  await detail.getByLabel('新标签名').press('Enter');
  await expect(detail.locator('.tag-chip', { hasText: '情侣' })).toBeVisible();
  expect(tagRequests).toHaveLength(0);
  await detail.getByRole('button', { name: '保存标签' }).click();
  await expect(detail.getByRole('status')).toContainText('标签已保存');
  expect(tagRequests).toEqual([{ tags: ['校园', '情侣'] }]);

  await page.getByLabel('按标签筛选').fill('校园, 情侣');
  await page.getByLabel('按标签筛选').press('Enter');
  await expect
    .poll(() =>
      requestedUrls.some((url) => url.includes('tags=%E6%A0%A1%E5%9B%AD%2C%E6%83%85%E4%BE%A3')),
    )
    .toBe(true);
  await expect(page.getByRole('button', { name: /清除标签筛选：校园,情侣/ })).toBeVisible();
  await page.getByRole('button', { name: /清除标签筛选/ }).click();
  await expect.poll(() => requestedUrls.some((url) => !url.includes('tags='))).toBe(true);
  await expect(page.getByRole('button', { name: /清除标签筛选/ })).toHaveCount(0);
});

test('成员管理呈现护栏禁用态与说明，操作前都要二次确认', async ({ page }) => {
  await mockAuthenticatedWorkspace(page, 'admin');
  await page.unroute('**/members');
  await page.unroute('**/members/assignable');
  const members = [
    {
      id: 'admin-user',
      displayName: '管理员同事',
      email: 'admin@example.test',
      role: 'admin',
      status: 'active',
    },
    {
      id: 'admin-b',
      displayName: '管理员乙',
      email: 'admin-b@example.test',
      role: 'admin',
      status: 'active',
    },
    {
      id: 'operator-user',
      displayName: '运营同事',
      email: 'operator@example.test',
      role: 'operator',
      status: 'active',
    },
    {
      id: 'disabled-user',
      displayName: '停用同事',
      email: 'off@example.test',
      role: 'operator',
      status: 'disabled',
    },
  ];
  await page.route('**/members', (route) => route.fulfill({ json: { members } }));
  await page.route('**/members/assignable', (route) =>
    route.fulfill({
      json: {
        members: members
          .filter((member) => member.status === 'active')
          .map((member) => ({ displayName: member.displayName, id: member.id })),
      },
    }),
  );
  let invitations = [
    {
      id: 'invite-1',
      email: 'newcomer@example.test',
      role: 'operator',
      invitedAt: '2026-09-22T02:00:00.000Z',
      expiresAt: '2026-09-23T02:00:00.000Z',
      invitedByDisplayName: '管理员同事',
    },
  ];
  await page.route('**/invitations', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ json: { invitations } })
      : route.fulfill({ json: { token: 'invite-token' } }),
  );
  const memberRequests: Array<{ body: unknown; method: string; url: string }> = [];
  await page.route(/\/members\/[^/]+\/(?:disable|enable|role)$/u, (route) => {
    const request = route.request();
    memberRequests.push({
      body: request.postDataJSON(),
      method: request.method(),
      url: request.url(),
    });
    // 停用运营同事时模拟服务端护栏：同事刚刚把另一名管理员停用了。
    if (request.url().endsWith('/operator-user/disable')) {
      return route.fulfill({
        json: {
          code: 'LAST_ACTIVE_ADMIN',
          message: '工作区必须保留至少一名启用状态的管理员，请先提升另一名管理员再操作',
        },
        status: 409,
      });
    }
    return route.fulfill({ json: { ok: true } });
  });
  await page.route('**/invitations/invite-1/revoke', (route) => {
    memberRequests.push({
      body: route.request().postDataJSON(),
      method: route.request().method(),
      url: route.request().url(),
    });
    invitations = [];
    return route.fulfill({ json: { ok: true } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: '成员与邀请' }).click();
  const selfRow = page.locator('.member-entry').filter({ hasText: '管理员同事（你）' });
  // 两名管理员都在，所以自己不是「最后一名」，但停用自己始终被挡住。
  await expect(selfRow.getByText('不能停用当前登录的自己，请让另一名管理员操作。')).toBeVisible();
  await expect(selfRow.getByRole('button', { name: '停用' })).toBeDisabled();
  await expect(selfRow.getByRole('button', { name: '保存角色' })).toBeDisabled();

  const adminBRow = page.locator('.member-entry').filter({ hasText: '管理员乙' });
  await expect(adminBRow.getByRole('button', { name: '停用' })).toBeEnabled();
  // FilterSelect 的触发按钮可访问名是「角色 + 当前值」，用 ^角色 才能避开「保存角色」。
  await adminBRow.getByRole('button', { name: /^角色/u }).click();
  await adminBRow.getByRole('option', { name: '运营', exact: true }).click();
  await adminBRow.getByRole('button', { name: '保存角色' }).click();
  // 降级会移除管理员身份，和停用同级，必须先确认。
  await expect(adminBRow.getByText(/从管理员降为运营/)).toBeVisible();
  await adminBRow.getByRole('button', { name: '确认降级' }).click();
  await expect(page.getByRole('status')).toContainText('已把「管理员乙」的角色改为运营');
  expect(memberRequests[0]).toMatchObject({
    body: { role: 'operator' },
    method: 'PUT',
  });
  expect(memberRequests[0]!.url).toContain('/members/admin-b/role');

  const operatorRow = page.locator('.member-entry').filter({ hasText: '运营同事' });
  await operatorRow.getByRole('button', { name: '停用' }).click();
  await expect(operatorRow.getByText(/其登录会话与名下采集设备会立即失效/)).toBeVisible();
  await operatorRow.getByRole('button', { name: '确认停用' }).click();
  // 护栏拒绝时把服务端原因就地显示，不能只说「操作失败」。
  await expect(page.getByRole('alert')).toContainText(
    '工作区必须保留至少一名启用状态的管理员，请先提升另一名管理员再操作',
  );
  expect(memberRequests[1]).toMatchObject({ body: null, method: 'POST' });
  expect(memberRequests[1]!.url).toContain('/members/operator-user/disable');

  const disabledRow = page.locator('.member-entry').filter({ hasText: '停用同事' });
  await expect(disabledRow.getByRole('button', { name: '停用' })).toHaveCount(0);
  await disabledRow.getByRole('button', { name: '启用' }).click();
  await expect(page.getByRole('status')).toContainText('其名下设备保持已撤销');
  expect(memberRequests[2]!.url).toContain('/members/disabled-user/enable');

  await page.getByRole('button', { name: '撤销邀请' }).click();
  await expect(page.getByText(/撤销后这条链接立即失效/)).toBeVisible();
  await page.getByRole('button', { name: '确认撤销' }).click();
  await expect(page.getByRole('status')).toContainText('已撤销发给 newcomer@example.test 的邀请');
  await expect(
    page.getByText('没有待处理的邀请。已被接受、已撤销或已过期的邀请不会出现在这里。'),
  ).toBeVisible();
  expect(memberRequests[3]).toMatchObject({ body: null, method: 'POST' });
});

test('唯一管理员既不能停用也不能降级自己', async ({ page }) => {
  await mockAuthenticatedWorkspace(page, 'admin');
  await page.unroute('**/members');
  await page.route('**/members', (route) =>
    route.fulfill({
      json: {
        members: [
          {
            id: 'admin-user',
            displayName: '管理员同事',
            email: 'admin@example.test',
            role: 'admin',
            status: 'active',
          },
        ],
      },
    }),
  );
  await page.route('**/invitations', (route) => route.fulfill({ json: { invitations: [] } }));

  await page.goto('/');
  await page.getByRole('button', { name: '成员与邀请' }).click();
  const selfRow = page.locator('.member-entry').filter({ hasText: '管理员同事（你）' });
  await expect(selfRow.getByRole('button', { name: '停用' })).toBeDisabled();
  await expect(selfRow.getByRole('button', { name: '保存角色' })).toBeDisabled();
  await expect(
    selfRow.getByText(
      '不能停用或降级当前登录的自己：工作区必须保留至少一名启用状态的管理员，请先提升另一名管理员。',
    ),
  ).toBeVisible();
});

test('已停用成员不出现在归属人与运营成员下拉里', async ({ page }) => {
  await mockAuthenticatedWorkspace(page, 'admin');
  await page.unroute('**/members');
  await page.unroute('**/members/assignable');
  await page.unroute(candidatesRoute);
  const members = [
    {
      id: 'operator-active',
      displayName: '在岗运营',
      email: 'active@example.test',
      role: 'operator',
      status: 'active',
    },
    {
      id: 'operator-disabled',
      displayName: '离岗运营',
      email: 'disabled@example.test',
      role: 'operator',
      status: 'disabled',
    },
  ];
  await page.route('**/members', (route) => route.fulfill({ json: { members } }));
  // /members/assignable 由服务端过滤 status === 'active'（server.ts 的 members/assignable 路由）。
  await page.route('**/members/assignable', (route) =>
    route.fulfill({ json: { members: [{ displayName: '在岗运营', id: 'operator-active' }] } }),
  );
  await page.route(candidatesRoute, (route) =>
    route.fulfill({
      json: {
        candidates: [candidateSummaryFixture('assign-one', '待分配同学', 1)],
        nextCursor: null,
      },
    }),
  );
  await page.route('**/candidates/assign-one', (route) =>
    route.fulfill({ json: candidateDetailFixture('assign-one', { nickname: '待分配同学' }) }),
  );

  await page.goto('/');
  await page.getByRole('button', { name: '达人库', exact: true }).click();
  await page.getByRole('button', { name: /运营成员/ }).click();
  await expect(page.getByRole('option', { name: '在岗运营', exact: true })).toBeVisible();
  await expect(page.getByRole('option', { name: '离岗运营', exact: true })).toHaveCount(0);
  await page.getByRole('heading', { name: '达人库' }).click();
  await page.getByRole('button', { name: /待分配同学/ }).click();
  const detail = page.getByRole('article');
  await detail.getByText('联系资料与沟通记录（跟进阶段再填）').click();
  // 负责人下拉来自 /members/assignable，服务端已过滤停用成员；等它加载完再断言选项。
  await expect(detail.getByRole('button', { name: /^负责人/u })).toContainText('未分配');
  await detail.getByRole('button', { name: /^负责人/u }).click();
  await expect(detail.getByRole('option', { name: '在岗运营', exact: true })).toBeVisible();
  await expect(detail.getByRole('option', { name: '离岗运营', exact: true })).toHaveCount(0);
});

test('网络失败时显示明确中文状态', async ({ page }) => {
  await mockAuthenticatedWorkspace(page, 'admin');
  await page.unroute('**/dashboard');
  await page.route('**/dashboard', async (route) => route.abort('failed'));

  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('网络连接失败');
});

for (const role of ['admin', 'operator', 'readonly'] as const) {
  test(`${labels[role]}只看到角色允许的管理操作`, async ({ page }) => {
    await mockAuthenticatedWorkspace(page, role);
    await page.goto('/');
    await expect(page.getByText(`${labels[role]}同事`)).toBeVisible();

    if (role === 'admin') {
      await expect(page.getByRole('button', { name: '创建筛选任务' })).toBeVisible();
      await page.getByRole('button', { name: '成员与邀请' }).click();
      await expect(page.getByRole('button', { name: '邀请成员' })).toBeVisible();
      await page.getByRole('button', { name: '采集设备', exact: true }).click();
      await expect(page.getByRole('button', { name: '筛选模板' })).toBeVisible();
      await expect(page.getByRole('button', { name: '审计记录' })).toBeVisible();
      await expect(page.getByRole('button', { name: '生成配对码' })).toBeVisible();
    } else if (role === 'operator') {
      await expect(page.getByRole('button', { name: '创建筛选任务' })).toBeVisible();
      await expect(page.getByRole('button', { name: '成员与邀请' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: '筛选模板' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: '审计记录' })).toHaveCount(0);
      await page.getByRole('button', { name: '采集设备', exact: true }).click();
      await expect(page.getByRole('button', { name: '生成配对码' })).toBeVisible();
    } else {
      await expect(page.getByRole('button', { name: '创建筛选任务' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: '成员与邀请' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: '采集设备' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: '筛选模板' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: '审计记录' })).toHaveCount(0);
      await expect(page.getByText('编辑操作由运营成员完成')).toBeVisible();
    }
  });
}

test('采集设备默认只列在用设备，已撤销设备作为只读历史按需展开', async ({ page }) => {
  await mockAuthenticatedWorkspace(page, 'admin');
  await page.unroute('**/devices');
  const device = (id: string, name: string, status: 'active' | 'revoked') => ({
    id,
    name,
    ownerDisplayName: '运营同事',
    status,
    collectorVersion: '0.1.5',
    parserVersion: '0.1.5',
    lastSeenAt: '2026-09-18T08:00:00.000Z',
    revokedAt: status === 'revoked' ? '2026-09-19T08:00:00.000Z' : null,
  });
  await page.route('**/devices', (route) =>
    route.fulfill({
      contentType: 'application/json',
      json: {
        devices: [
          device('device-live', '在用电脑', 'active'),
          device('device-old', '已撤销电脑', 'revoked'),
        ],
      },
    }),
  );

  await page.goto('/');
  await page.getByRole('button', { name: '采集设备', exact: true }).click();
  await expect(page.getByText('在用电脑')).toBeVisible();
  await expect(page.getByText('已撤销电脑')).toHaveCount(0);
  await expect(page.getByText('1 台在用', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: /显示已撤销/ }).click();
  const revokedRow = page.locator('.device-row').filter({ hasText: '已撤销电脑' });
  await expect(revokedRow).toBeVisible();
  await expect(revokedRow.getByText(/已撤销 · /)).toBeVisible();
  // 已撤销设备是历史，不能恢复、改名或删除。
  await expect(revokedRow.getByRole('button')).toHaveCount(0);
  await expect(page.getByText(/已撤销设备保留为历史记录，无法删除/)).toBeVisible();

  await page.getByRole('button', { name: '隐藏已撤销' }).click();
  await expect(page.getByText('已撤销电脑')).toHaveCount(0);
});

test('审计记录显示中文动作与对象，未收录的取值也不露出英文键', async ({ page }) => {
  await mockAuthenticatedWorkspace(page, 'admin');
  await page.unroute('**/audit-events');
  const event = (id: string, action: string, subjectType: string) => ({
    id,
    action,
    subjectType,
    actorUserId: 'admin-user',
    createdAt: '2026-09-22T08:00:00.000Z',
  });
  await page.route('**/audit-events', (route) =>
    route.fulfill({
      contentType: 'application/json',
      json: {
        events: [
          event('audit-tags', 'candidate.tags_changed', 'candidate'),
          event('audit-archived', 'candidate.archived', 'candidate'),
          event('audit-unarchived', 'candidate.unarchived', 'candidate'),
          event('audit-role', 'account.role_changed', 'user'),
          event('audit-enabled', 'account.enabled', 'user'),
          event('audit-invite', 'account.invitation_revoked', 'invitation'),
          event('audit-unknown', 'candidate.future_action', 'candidate'),
        ],
      },
    }),
  );

  await page.goto('/');
  await page.getByRole('button', { name: '审计记录' }).click();
  for (const label of [
    '更新候选标签',
    '归档候选',
    '恢复候选',
    '变更成员角色',
    '启用成员',
    '撤销成员邀请',
    '成员邀请',
  ]) {
    await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
  }
  // 未收录的动作走中文兜底；原始英文键只允许出现在 title 属性里，不作为可见文本。
  await expect(page.getByText('其他操作', { exact: true })).toBeVisible();
  await expect(page.getByText('candidate.future_action')).toHaveCount(0);
  await expect(page.getByText('candidate.tags_changed')).toHaveCount(0);
  await expect(page.locator('[title="candidate.future_action"]')).toHaveCount(1);
});

test('运营可配置硬筛规则与停止条件，保存后立即回显', async ({ page }) => {
  await mockAuthenticatedWorkspace(page, 'operator');
  let submittedCampaign: Record<string, unknown> | undefined;
  await page.route('**/campaigns', async (route) => {
    if (route.request().method() === 'POST') {
      submittedCampaign = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        contentType: 'application/json',
        json: { id: 'campaign-new', version: 1 },
      });
      return;
    }
    await route.fulfill({ contentType: 'application/json', json: { campaigns: [] } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: '筛选任务', exact: true }).click();
  await page.getByRole('button', { name: '新建筛选任务' }).click();
  await page.getByLabel('任务名称').fill('开学季校园素人');
  await page.getByLabel('推荐画像说明').fill('校园日常、宿舍生活，最近推荐流中持续出现的年轻素人');
  await page.getByLabel('粉丝上限').fill('8000');
  await page.getByLabel('观察天数').fill('20');
  await page.getByLabel('点赞门槛').fill('15000');
  await page.getByLabel('最多浏览作品').fill('120');
  await page.getByLabel('最长运行分钟').fill('75');
  await page.getByLabel('目标候选数').fill('35');
  await page.getByLabel('人工复核项（可选）').fill('主页内容是否适合品牌合作');
  await page.getByRole('button', { name: '保存筛选任务' }).click();

  const savedSummary = page.getByRole('complementary');
  await expect(savedSummary.getByText('已保存')).toBeVisible();
  await expect(savedSummary.getByText('开学季校园素人', { exact: true })).toBeVisible();
  await expect(savedSummary.getByText(/粉丝 0–8000/)).toBeVisible();
  await expect(savedSummary.getByText(/爆款 20 天 \/ 15000 赞/)).toBeVisible();

  expect(submittedCampaign).toMatchObject({
    name: '开学季校园素人',
    recommendationProfileDescription: '校园日常、宿舍生活，最近推荐流中持续出现的年轻素人',
    rules: {
      schemaVersion: 2,
      hardRules: [
        { type: 'follower-range', min: 0, max: 8000 },
        {
          type: 'recent-post-likes',
          windowDays: 20,
          minimumLikes: 15000,
          minimumMatchingPosts: 1,
        },
      ],
      manualChecks: [{ type: 'review-check', label: '主页内容是否适合品牌合作' }],
      stopConditions: {
        maxFeedItems: 120,
        maxDurationMinutes: 75,
        targetCandidates: 35,
      },
    },
  });
});

const campaignRulesFixture = {
  schemaVersion: 2,
  hardRules: [
    { id: 'followers', kind: 'hard', type: 'follower-range', min: 0, max: 5_000 },
    {
      id: 'recent-viral-post',
      kind: 'hard',
      type: 'recent-post-likes',
      windowDays: 15,
      minimumLikes: 10_000,
      minimumMatchingPosts: 2,
    },
  ],
  manualChecks: [],
  stopConditions: { maxFeedItems: 100, maxCreatorProfiles: 40 },
  pacing: { minimumDelayMs: 1_500, maximumDelayMs: 3_000 },
};

const existingCampaignFixture = {
  id: 'campaign-edit',
  name: '校园圈层',
  status: 'active',
  version: 3,
  recommendation_profile_description: '校园日常',
  source_template_id: null,
  rules_json: campaignRulesFixture,
};

test('管理员可编辑任务条件，未填写的停止条件保持未设置', async ({ page }) => {
  await mockAuthenticatedWorkspace(page, 'admin');
  await page.route('**/campaigns', async (route) =>
    route.fulfill({
      contentType: 'application/json',
      json: { campaigns: [existingCampaignFixture] },
    }),
  );
  let patched: Record<string, unknown> | undefined;
  await page.route('**/campaigns/campaign-edit', async (route) => {
    patched = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      contentType: 'application/json',
      json: { id: 'campaign-edit', version: 4 },
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: '筛选任务', exact: true }).click();
  await expect(page.getByText(/粉丝 0–5000 · 爆款 15 天 \/ 10000 赞/)).toBeVisible();
  await page.getByRole('button', { name: '编辑', exact: true }).click();

  await expect(page.getByLabel('粉丝上限')).toHaveValue('5000');
  await expect(page.getByLabel('最长运行分钟')).toHaveValue('');
  await page.getByLabel('粉丝上限').fill('9000');
  await page.getByRole('button', { name: '保存修改' }).click();

  await expect(page.getByRole('status')).toContainText('冻结独立快照');
  expect(patched).toMatchObject({
    name: '校园圈层',
    expectedVersion: 3,
    rules: {
      hardRules: [
        { id: 'followers', type: 'follower-range', min: 0, max: 9_000 },
        { id: 'recent-viral-post', windowDays: 15, minimumLikes: 10_000, minimumMatchingPosts: 2 },
      ],
      stopConditions: { maxFeedItems: 100, maxCreatorProfiles: 40 },
      pacing: { minimumDelayMs: 1_500, maximumDelayMs: 3_000 },
    },
  });
});

test('任务被同事改过时提示冲突并刷新，不做静默合并', async ({ page }) => {
  await mockAuthenticatedWorkspace(page, 'admin');
  let listRequests = 0;
  await page.route('**/campaigns', async (route) => {
    listRequests += 1;
    await route.fulfill({
      contentType: 'application/json',
      json: { campaigns: [existingCampaignFixture] },
    });
  });
  await page.route('**/campaigns/campaign-edit', async (route) =>
    route.fulfill({
      status: 409,
      contentType: 'application/json',
      json: { code: 'VERSION_CONFLICT', currentVersion: 4 },
    }),
  );

  await page.goto('/');
  await page.getByRole('button', { name: '筛选任务', exact: true }).click();
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByLabel('粉丝上限').fill('9000');
  const beforeSave = listRequests;
  await page.getByRole('button', { name: '保存修改' }).click();

  await expect(page.getByRole('alert')).toContainText('已被同事修改');
  await expect(page.getByRole('button', { name: '保存修改' })).toHaveCount(0);
  await expect.poll(() => listRequests, { timeout: 3_000 }).toBeGreaterThan(beforeSave);
});

test('复制任务需要新名称，归档会明确说明不能恢复', async ({ page }) => {
  await mockAuthenticatedWorkspace(page, 'admin');
  await page.route('**/campaigns', async (route) =>
    route.fulfill({
      contentType: 'application/json',
      json: { campaigns: [existingCampaignFixture] },
    }),
  );
  let copyBody: Record<string, unknown> | undefined;
  await page.route('**/campaigns/campaign-edit/copy', async (route) => {
    copyBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      json: { id: 'campaign-copy', version: 1 },
    });
  });
  let archiveHeaders: Record<string, string> | undefined;
  await page.route('**/campaigns/campaign-edit/archive', async (route) => {
    archiveHeaders = route.request().headers();
    await route.fulfill({
      contentType: 'application/json',
      json: { id: 'campaign-edit', version: 4 },
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: '筛选任务', exact: true }).click();
  await page.getByRole('button', { name: '复制', exact: true }).click();
  await expect(page.getByPlaceholder('新任务名称')).toHaveValue('校园圈层 副本');
  await page.getByRole('button', { name: '确认复制' }).click();
  await expect(page.getByRole('status')).toContainText('已复制为「校园圈层 副本」');
  expect(copyBody).toEqual({ name: '校园圈层 副本' });

  await page.getByRole('button', { name: '归档', exact: true }).click();
  await expect(page.getByText(/不能再创建运行/)).toBeVisible();
  await page.getByRole('button', { name: '确认归档' }).click();
  await expect(page.getByRole('status')).toContainText('已归档');
  expect(archiveHeaders?.['content-type']).toBeUndefined();
});

test('新建任务可以选模板并沿用模板条件', async ({ page }) => {
  await mockAuthenticatedWorkspace(page, 'admin');
  await page.route('**/campaign-templates', async (route) =>
    route.fulfill({
      contentType: 'application/json',
      json: {
        templates: [
          {
            id: 'template-campus',
            name: '校园模板',
            description: '校园素人',
            version: 2,
            rules_json: {
              ...campaignRulesFixture,
              hardRules: [
                { id: 'followers', kind: 'hard', type: 'follower-range', min: 200, max: 7_000 },
              ],
              stopConditions: { targetCandidates: 25 },
            },
          },
        ],
      },
    }),
  );
  let submitted: Record<string, unknown> | undefined;
  await page.route('**/campaigns', async (route) => {
    if (route.request().method() === 'POST') {
      submitted = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        json: { id: 'campaign-from-template', version: 1 },
      });
      return;
    }
    await route.fulfill({ contentType: 'application/json', json: { campaigns: [] } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: '筛选任务', exact: true }).click();
  await page.getByRole('button', { name: '新建筛选任务' }).click();
  await page.getByLabel('从模板开始（可选）').selectOption('template-campus');
  await expect(page.getByLabel('粉丝上限')).toHaveValue('7000');
  await expect(page.getByLabel('目标候选数')).toHaveValue('25');
  await page.getByLabel('任务名称').fill('校园秋季');
  await page.getByRole('button', { name: '保存筛选任务' }).click();

  await expect(page.getByRole('status')).toContainText('校园秋季');
  expect(submitted).toMatchObject({
    name: '校园秋季',
    templateId: 'template-campus',
    rules: {
      hardRules: [{ type: 'follower-range', min: 200, max: 7_000 }],
      stopConditions: { targetCandidates: 25 },
      pacing: { minimumDelayMs: 1_500, maximumDelayMs: 3_000 },
    },
  });
});

test('管理员可以新建和归档筛选模板', async ({ page }) => {
  await mockAuthenticatedWorkspace(page, 'admin');
  await page.route('**/campaign-templates', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        json: { id: 'template-new', version: 1 },
      });
      return;
    }
    await route.fulfill({
      contentType: 'application/json',
      json: {
        templates: [
          {
            id: 'template-campus',
            name: '校园模板',
            description: '校园素人',
            version: 2,
            rules_json: campaignRulesFixture,
          },
        ],
      },
    });
  });
  let archived = 0;
  await page.route('**/campaign-templates/template-campus/archive', async (route) => {
    archived += 1;
    await route.fulfill({
      contentType: 'application/json',
      json: { id: 'template-campus', version: 3 },
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: '筛选模板', exact: true }).click();
  await expect(page.getByText(/粉丝 0–5000 · 爆款 15 天 \/ 10000 赞/)).toBeVisible();

  await page.getByRole('button', { name: '新建模板' }).click();
  await page.getByLabel('模板名称').fill('城市探店');
  await page.getByLabel('粉丝上限').fill('20000');
  await page.getByRole('button', { name: '保存模板' }).click();
  await expect(page.getByRole('status')).toContainText('模板「城市探店」已保存');

  await page.getByRole('button', { name: '归档', exact: true }).click();
  await expect(page.getByText(/不再出现在新建任务的下拉里/)).toBeVisible();
  await page.getByRole('button', { name: '确认归档' }).click();
  await expect(page.getByRole('status')).toContainText('已归档');
  expect(archived).toBe(1);
});

test('运营成员看不到筛选模板入口', async ({ page }) => {
  await mockAuthenticatedWorkspace(page, 'operator');
  await page.goto('/');
  await expect(page.getByRole('button', { name: '筛选任务', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '筛选模板', exact: true })).toHaveCount(0);
});

test('运行监控实时显示进度、停止原因、领取设备和错误', async ({ page }) => {
  await mockAuthenticatedWorkspace(page, 'operator');
  let requestCount = 0;
  const now = '2026-09-15T08:00:00.000Z';
  await page.route('**/runs', async (route) => {
    requestCount += 1;
    const feedItemsSeen = requestCount > 1 ? 18 : 12;
    await route.fulfill({
      contentType: 'application/json',
      json: {
        runs: [
          {
            id: 'run-live',
            campaignId: 'campaign-live',
            campaignName: '校园实时采集',
            ruleVersion: 2,
            status: 'running',
            stopReason: null,
            errorCode: null,
            errorMessage: null,
            progress: {
              feedItemsSeen,
              creatorProfilesSeen: 7,
              candidatesFound: 3,
              elapsedSeconds: 420,
            },
            device: { id: 'device-1', name: '运营电脑一号' },
            claimedAt: now,
            startedAt: now,
            endedAt: null,
            createdAt: now,
            updatedAt: now,
          },
          {
            id: 'run-completed',
            campaignId: 'campaign-completed',
            campaignName: '目标完成任务',
            ruleVersion: 1,
            status: 'completed',
            stopReason: 'target_candidates',
            errorCode: null,
            errorMessage: null,
            progress: {
              feedItemsSeen: 68,
              creatorProfilesSeen: 22,
              candidatesFound: 10,
              elapsedSeconds: 1_800,
            },
            device: { id: 'device-2', name: '运营电脑二号' },
            claimedAt: now,
            startedAt: now,
            endedAt: now,
            createdAt: now,
            updatedAt: now,
          },
          {
            id: 'run-paused',
            campaignId: 'campaign-paused',
            campaignName: '验证码暂停任务',
            ruleVersion: 1,
            status: 'paused',
            stopReason: null,
            errorCode: null,
            errorMessage: null,
            progress: {
              feedItemsSeen: 8,
              creatorProfilesSeen: 2,
              candidatesFound: 1,
              elapsedSeconds: 120,
            },
            device: { id: 'device-4', name: '运营电脑四号' },
            claimedAt: now,
            startedAt: now,
            endedAt: null,
            createdAt: now,
            updatedAt: now,
          },
          {
            id: 'run-failed',
            campaignId: 'campaign-failed',
            campaignName: '解析异常任务',
            ruleVersion: 3,
            status: 'failed',
            stopReason: null,
            errorCode: 'DOUYIN_STRUCTURE_UNKNOWN',
            errorMessage: '页面结构无法识别，采集已安全暂停。',
            progress: {
              feedItemsSeen: 4,
              creatorProfilesSeen: 1,
              candidatesFound: 0,
              elapsedSeconds: 90,
            },
            device: { id: 'device-3', name: '运营电脑三号' },
            claimedAt: now,
            startedAt: now,
            endedAt: now,
            createdAt: now,
            updatedAt: now,
          },
        ],
      },
    });
  });
  await page.route(observedCreatorsRoute, async (route) => {
    const runId = new URL(route.request().url()).pathname.split('/')[2];
    await route.fulfill({
      contentType: 'application/json',
      json: { creators: runId === 'run-live' ? observedCreators : [] },
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: '运行监控', exact: true }).click();
  const detail = page.getByRole('article');
  await expect(page.getByRole('heading', { name: '运行监控' })).toBeVisible();
  await expect(detail.getByText('运营电脑一号')).toBeVisible();
  await expect(detail.getByText('18', { exact: true })).toBeVisible();
  await expect(detail.getByText('采集中')).toBeVisible();

  const observed = detail.locator('.evaluation-card');
  await expect(observed.filter({ hasText: '已入库同学' })).toContainText('已入库 · 待复核');
  await expect(observed.filter({ hasText: '已入库同学' })).toContainText('命中 12,000 赞（1.2万）');
  // 缺失字段必须显示「未知」，不能被折算成 0 或留空。
  const missing = observed.filter({ hasText: '缺数据同学' });
  await expect(missing).toContainText('未入库 · 不进入复核队列');
  await expect(missing).toContainText('粉丝 未知');
  await expect(missing).toContainText('粉丝范围 · 未知 · 范围 0–5000');
  await expect(missing).toContainText('1 条作品缺少赞数或发布时间，按未知处理');
  await expect(missing.locator('.evidence-outcome')).toHaveText('未知');

  await page.getByRole('button', { name: /目标完成任务/ }).click();
  await expect(detail.getByText('目标候选数已达到')).toBeVisible();
  await page.getByRole('button', { name: /验证码暂停任务/ }).click();
  await expect(detail.getByText('采集已暂停', { exact: true })).toBeVisible();
  await expect(detail.getByText(/请回到运营电脑处理验证码/)).toBeVisible();
  await page.getByRole('button', { name: /解析异常任务/ }).click();
  await expect(detail.getByText('异常', { exact: true })).toBeVisible();
  await expect(detail.getByText('页面结构无法识别，采集已安全暂停。')).toBeVisible();
  await expect(detail.getByText(/DOUYIN_STRUCTURE_UNKNOWN/)).toBeVisible();
  await expect(detail.getByText('本次运行还没有核验任何达人主页。')).toBeVisible();
});

test('达人详情保留历史粉丝变化、任务来源和旧规则作品证据', async ({ page }) => {
  await mockAuthenticatedWorkspace(page, 'operator');
  const newer = '2026-09-15T08:00:00.000Z';
  const older = '2026-09-14T08:00:00.000Z';
  await page.route(candidatesRoute, async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      json: {
        candidates: [
          {
            id: 'candidate-history',
            campaignName: '九月校园任务',
            nickname: '小影同学',
            biography: '校园日常记录',
            profileUrl: 'https://www.douyin.com/user/history-creator',
            followerCount: 1_800,
            observedAt: newer,
            hardFilterStatus: 'pass',
            manualDecision: 'pending',
            pipelineStatus: 'pending_review',
            tags: ['校园', '素人'],
          },
        ],
      },
    });
  });
  await page.route('**/candidates/candidate-history/reviews', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      json: { code: 'VERSION_CONFLICT', currentVersion: 4 },
      status: 409,
    });
  });
  await page.route('**/media/media-profile/access', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      json: {
        downloadUrl:
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      },
    });
  });
  await page.route('**/candidates/candidate-history', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      json: {
        candidate: {
          id: 'candidate-history',
          campaignName: '九月校园任务',
          hardFilterStatus: 'pass',
          pipelineStatus: 'pending_review',
        },
        observations: [
          {
            id: 'observation-new',
            nickname: '小影同学',
            biography: '校园日常记录',
            profileUrl: 'https://www.douyin.com/user/history-creator',
            followerCount: 1_800,
            followerCountRaw: '1800',
            observedAt: newer,
            device: { id: 'device-2', name: '运营电脑二号' },
          },
          {
            id: 'observation-old',
            nickname: '小影',
            biography: '记录生活',
            profileUrl: 'https://www.douyin.com/user/history-creator',
            followerCount: 1_200,
            followerCountRaw: '1200',
            observedAt: older,
            device: { id: 'device-1', name: '运营电脑一号' },
          },
        ],
        sources: [
          {
            runId: 'run-new',
            campaignName: '十月校园任务',
            device: { id: 'device-2', name: '运营电脑二号' },
            observationCount: 1,
            lastObservedAt: newer,
          },
          {
            runId: 'run-old',
            campaignName: '九月校园任务',
            device: { id: 'device-1', name: '运营电脑一号' },
            observationCount: 1,
            lastObservedAt: older,
          },
        ],
        evaluations: [
          {
            id: 'evaluation-old-viral',
            ruleVersion: 1,
            ruleKey: 'recent-viral-post',
            outcome: 'pass',
            evidence: { minimumLikes: 10_000 },
            matchedPost: {
              observationId: 'post-observation-old',
              url: 'https://www.douyin.com/video/history-viral',
              likeCount: 11_000,
              likeCountRaw: '1.1万',
              publishedAt: '2026-09-10T08:00:00.000Z',
            },
            evaluatedAt: older,
          },
          {
            id: 'evaluation-old-followers',
            ruleVersion: 1,
            ruleKey: 'followers',
            outcome: 'pass',
            evidence: { minimum: 0, maximum: 5_000 },
            matchedPost: null,
            evaluatedAt: older,
          },
        ],
        media: [
          {
            id: 'media-profile',
            purpose: 'profile_screenshot',
            mimeType: 'image/png',
            createdAt: newer,
          },
        ],
        workflow: {
          candidateVersion: 3,
          pipelineStatus: 'to_contact',
          reviews: [
            {
              id: 'review-old',
              decision: 'approved',
              reason: '公开内容匹配',
              reviewerDisplayName: '运营同事',
              createdAt: newer,
            },
          ],
          outreach: {
            ownerUserId: 'operator-user',
            ownerDisplayName: '运营同事',
            contactChannel: 'douyin',
            contactValue: '已私信',
            quotedAmount: 500,
            currency: 'CNY',
            nextFollowUpAt: null,
            nextAction: '发送合作说明',
            version: 1,
          },
          notes: [
            {
              id: 'note-old',
              body: '对方希望先看产品介绍',
              authorDisplayName: '运营同事',
              createdAt: newer,
            },
          ],
          events: [
            {
              id: 'event-old',
              eventType: 'pipeline_status_changed',
              previousStatus: 'pending_review',
              nextStatus: 'to_contact',
              actorDisplayName: '运营同事',
              createdAt: newer,
            },
          ],
        },
      },
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: '达人库', exact: true }).click();
  await page.getByRole('button', { name: /小影同学/ }).click();
  const detail = page.getByRole('article');
  await expect(detail.getByRole('heading', { name: '小影同学' })).toBeVisible();
  await expect(detail.getByText('1,800 粉丝')).toBeVisible();
  await expect(detail.getByText('1,200 粉丝')).toBeVisible();
  await expect(detail.getByText('十月校园任务')).toBeVisible();
  await expect(detail.getByText('九月校园任务')).toBeVisible();
  await expect(detail.getByText('规则 v1')).toHaveCount(2);
  await expect(detail.getByText('门槛 10000 赞')).toBeVisible();
  await expect(detail.getByRole('link', { name: /命中作品 · 11,000 赞（1.1万）/ })).toBeVisible();
  await expect(detail.getByText(/当前负责人：运营同事/)).toBeVisible();
  await expect(detail.getByText('对方希望先看产品介绍')).toBeVisible();
  await expect(detail.getByText('待复核 → 待联系')).toBeVisible();
  // 截图打开详情即自动加载，不需要运营逐张点击（点击加载让复核慢到没人愿意看图）。
  await expect(detail.getByRole('img', { name: '主页证据截图' })).toBeVisible();
  await detail.getByRole('button', { name: '放大查看主页证据截图' }).click();
  const imagePreview = page.getByRole('dialog', { name: '主页证据截图预览' });
  await expect(imagePreview).toBeVisible();
  await expect(imagePreview.getByText('100%')).toBeVisible();
  await imagePreview.getByRole('button', { name: '放大截图' }).click();
  await expect(imagePreview.getByText('125%')).toBeVisible();
  await imagePreview.getByRole('button', { name: '还原' }).click();
  await expect(imagePreview.getByText('100%')).toBeVisible();
  await imagePreview
    .getByLabel('截图预览区域，滚轮可缩放')
    .dispatchEvent('wheel', { deltaY: -100 });
  await expect(imagePreview.getByText('125%')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(imagePreview).toBeHidden();
  await expect(detail.getByRole('button', { name: '保存人工结论' })).toBeVisible();
  await detail.getByRole('button', { name: '保存人工结论' }).click();
  await expect(detail.getByText('这条记录已被同事更新，请重新打开达人后再提交。')).toBeVisible();
  await expect(detail.getByText('规则 v1')).toHaveCount(2);
});

test('只读成员可查看复核历史但没有修改入口', async ({ page }) => {
  await mockAuthenticatedWorkspace(page, 'readonly');
  await page.unroute(candidatesRoute);
  await page.route(candidatesRoute, async (route) => {
    await route.fulfill({
      json: {
        candidates: [
          {
            biography: null,
            campaignName: '只读任务',
            followerCount: 800,
            hardFilterStatus: 'pass',
            id: 'readonly-candidate',
            manualDecision: 'approved',
            nickname: '只读达人',
            observedAt: '2026-09-15T08:00:00.000Z',
            pipelineStatus: 'to_contact',
            profileUrl: 'https://www.douyin.com/user/readonly-candidate',
            tags: [],
          },
        ],
      },
    });
  });
  await page.route('**/candidates/readonly-candidate', async (route) => {
    await route.fulfill({
      json: {
        candidate: {
          campaignName: '只读任务',
          hardFilterStatus: 'pass',
          id: 'readonly-candidate',
          pipelineStatus: 'to_contact',
        },
        evaluations: [],
        observations: [
          {
            biography: null,
            device: { id: 'device', name: '运营设备' },
            followerCount: 800,
            followerCountRaw: '800',
            id: 'observation',
            nickname: '只读达人',
            observedAt: '2026-09-15T08:00:00.000Z',
            profileUrl: 'https://www.douyin.com/user/readonly-candidate',
          },
        ],
        sources: [],
        workflow: {
          candidateVersion: 2,
          events: [],
          notes: [],
          outreach: null,
          pipelineStatus: 'to_contact',
          reviews: [
            {
              createdAt: '2026-09-15T08:00:00.000Z',
              decision: 'approved',
              id: 'review',
              reason: '人工确认通过',
              reviewerDisplayName: '运营同事',
            },
          ],
        },
      },
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: '达人库', exact: true }).click();
  await page.getByRole('button', { name: /只读达人/ }).click();
  await expect(page.getByText(/最新人工结论：通过/)).toBeVisible();
  await expect(page.getByRole('button', { name: '保存人工结论' })).toHaveCount(0);
});
