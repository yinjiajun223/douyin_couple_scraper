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
    campaignName: '校园任务',
    followerCount: 1_200,
    manualDecision: 'pending',
    observedAt: '2026-09-16T08:00:00.000Z',
    ownerUserId: null,
    tags: [],
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
  await detail.getByRole('button', { name: '查看主页截图' }).click();
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
