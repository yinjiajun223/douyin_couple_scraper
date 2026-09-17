# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: web-access.e2e.spec.ts >> 运营只看到角色允许的管理操作
- Location: tests\web-access.e2e.spec.ts:294:3

# Error details

```
Error: locator.click: Error: strict mode violation: getByRole('button', { name: '采集设备' }) resolved to 2 elements:
    1) <button type="button" class="nav-item ">采集设备</button> aka getByRole('button', { name: '采集设备', exact: true })
    2) <button type="button">…</button> aka getByRole('button', { name: '配对采集设备 连接你电脑上的采集助手' })

Call log:
  - waiting for getByRole('button', { name: '采集设备' })

```

# Page snapshot

```yaml
- generic [ref=e3]:
  - complementary [ref=e4]:
    - generic [ref=e5]:
      - generic [aria-hidden] [ref=e6]: 星
      - generic [ref=e7]:
        - paragraph [ref=e8]: 星探台
        - paragraph [ref=e9]: 达人运营工作台
    - navigation "主导航" [ref=e10]:
      - button "今日工作" [ref=e11] [cursor=pointer]
      - button "筛选任务" [ref=e12] [cursor=pointer]
      - button "运行监控" [ref=e13] [cursor=pointer]
      - button "共享达人库" [ref=e14] [cursor=pointer]
      - button "采集设备" [ref=e15] [cursor=pointer]
    - generic [ref=e16]:
      - generic [ref=e17]: 运
      - generic [ref=e18]:
        - strong [ref=e19]: 运营同事
        - generic [ref=e20]: 运营
      - button "退出登录" [ref=e21] [cursor=pointer]: 退出
    - paragraph [ref=e24]: 采集浏览器只在运营电脑运行
  - main [ref=e25]:
    - generic [ref=e26]:
      - generic [ref=e27]: 团队工作台 / 抖音
      - button "刷新数据" [ref=e28] [cursor=pointer]
    - generic [ref=e29]:
      - generic [ref=e30]:
        - paragraph [ref=e31]: DOUYIN / TEAM DESK
        - heading "把值得联系的人， 交给团队一起跟进。" [level=1] [ref=e32]: 把值得联系的人，交给团队一起跟进。
        - paragraph [ref=e33]: 从推荐流发现，到数据硬筛、AI 提示和人工确认；每一步都能回看，也不会替你做决定。
      - button "创建筛选任务" [ref=e34] [cursor=pointer]
    - region "采集操作流程" [ref=e35]:
      - generic [ref=e36]:
        - heading "从这里开始找博主" [level=2] [ref=e37]
        - generic [ref=e38]: AI 可选 · 最终由人工确认
      - generic [ref=e39]:
        - button "01 配对采集设备 连接你电脑上的采集助手" [ref=e40] [cursor=pointer]:
          - generic [ref=e41]: "01"
          - strong [ref=e42]: 配对采集设备
          - generic [ref=e43]: 连接你电脑上的采集助手
        - button "02 配置筛选任务 设置粉丝、爆款与停止条件" [ref=e44] [cursor=pointer]:
          - generic [ref=e45]: "02"
          - strong [ref=e46]: 配置筛选任务
          - generic [ref=e47]: 设置粉丝、爆款与停止条件
        - link "03 本机人工开始 登录抖音，选择画像与运行 ↗" [ref=e48] [cursor=pointer]:
          - /url: http://127.0.0.1:43127
          - generic [ref=e49]: "03"
          - strong [ref=e50]: 本机人工开始
          - generic [ref=e51]: 登录抖音，选择画像与运行 ↗
        - button "04 复核与合作跟进 查看证据，确认并分配负责人" [ref=e52] [cursor=pointer]:
          - generic [ref=e53]: "04"
          - strong [ref=e54]: 复核与合作跟进
          - generic [ref=e55]: 查看证据，确认并分配负责人
    - region "运营待办概览" [ref=e56]:
      - button "运行中任务 0 查看对应记录 →" [ref=e57]:
        - generic [ref=e58]: 运行中任务
        - strong [ref=e59]: "0"
        - generic [ref=e60]: 查看对应记录 →
      - button "待复核 0 查看对应记录 →" [ref=e61]:
        - generic [ref=e62]: 待复核
        - strong [ref=e63]: "0"
        - generic [ref=e64]: 查看对应记录 →
      - button "待联系 0 查看对应记录 →" [ref=e65]:
        - generic [ref=e66]: 待联系
        - strong [ref=e67]: "0"
        - generic [ref=e68]: 查看对应记录 →
      - button "我负责的 0 查看对应记录 →" [ref=e69]:
        - generic [ref=e70]: 我负责的
        - strong [ref=e71]: "0"
        - generic [ref=e72]: 查看对应记录 →
      - button "失败任务 0 查看对应记录 →" [ref=e73]:
        - generic [ref=e74]: 失败任务
        - strong [ref=e75]: "0"
        - generic [ref=e76]: 查看对应记录 →
    - region [ref=e77]:
      - generic [ref=e78]:
        - generic [ref=e79]:
          - paragraph [ref=e80]: 筛选链路
          - heading "三段证据轨道" [level=2] [ref=e81]
        - paragraph [ref=e82]: 硬条件先判断，AI 只做辅助，最终由运营人员确认。
      - list [ref=e83]:
        - listitem [ref=e84]:
          - generic [ref=e85]: "01"
          - generic [ref=e87]:
            - heading "硬筛数据" [level=3] [ref=e88]
            - paragraph [ref=e89]: 粉丝与近 15 天作品
        - listitem [ref=e90]:
          - generic [ref=e91]: "02"
          - generic [ref=e93]:
            - heading "AI 辅助" [level=3] [ref=e94]
            - paragraph [ref=e95]: 年龄、素人属性与内容
        - listitem [ref=e96]:
          - generic [ref=e97]: "03"
          - generic [ref=e99]:
            - heading "人工确认" [level=3] [ref=e100]
            - paragraph [ref=e101]: 运营人员保留最终判断
    - region [ref=e102]:
      - paragraph [ref=e103]: 当前没有待处理事项
      - heading "先把这次要找的人说明白。" [level=2] [ref=e104]
      - paragraph [ref=e105]: 创建任务后，在运营电脑上选择已经养好的抖音画像并手动开始采集。
```

# Test source

```ts
  214 |             campaignName: '首页任务',
  215 |             followerCount: 700,
  216 |             hardFilterStatus: 'pass',
  217 |             id: 'contact-one',
  218 |             manualDecision: 'approved',
  219 |             nickname: '待联系达人',
  220 |             observedAt: '2026-09-15T08:00:00.000Z',
  221 |             ownerUserId: 'operator-user',
  222 |             pipelineStatus: 'to_contact',
  223 |             profileUrl: 'https://www.douyin.com/user/contact',
  224 |             tags: [],
  225 |           },
  226 |         ],
  227 |       },
  228 |     }),
  229 |   );
  230 |   const runBase = {
  231 |     campaignId: 'campaign',
  232 |     campaignName: '首页任务',
  233 |     claimedAt: null,
  234 |     createdAt: '2026-09-15T08:00:00.000Z',
  235 |     device: null,
  236 |     endedAt: null,
  237 |     errorCode: null,
  238 |     errorMessage: null,
  239 |     progress: { candidatesFound: 0, creatorProfilesSeen: 0, elapsedSeconds: 0, feedItemsSeen: 0 },
  240 |     ruleVersion: 1,
  241 |     startedAt: null,
  242 |     stopReason: null,
  243 |     updatedAt: '2026-09-15T08:00:00.000Z',
  244 |   };
  245 |   await page.route('**/runs', async (route) =>
  246 |     route.fulfill({
  247 |       json: {
  248 |         runs: [
  249 |           { ...runBase, id: 'run-active', status: 'running', campaignName: '运行中的首页任务' },
  250 |           {
  251 |             ...runBase,
  252 |             id: 'run-failed',
  253 |             status: 'failed',
  254 |             campaignName: '失败的首页任务',
  255 |             errorCode: 'TEST_FAILURE',
  256 |           },
  257 |         ],
  258 |       },
  259 |     }),
  260 |   );
  261 | 
  262 |   await page.goto('/');
  263 |   await expect(page.locator('.dashboard-card')).toHaveCount(5);
  264 |   await page.locator('.dashboard-card').filter({ hasText: '待复核' }).click();
  265 |   await expect(page.getByRole('button', { name: /待复核达人/ })).toBeVisible();
  266 |   await expect(page.getByRole('button', { name: /待联系达人/ })).toHaveCount(0);
  267 |   await page.getByRole('button', { name: '今日工作' }).click();
  268 |   await page.locator('.dashboard-card').filter({ hasText: '我负责的' }).click();
  269 |   await expect(page.getByRole('button', { name: /待联系达人/ })).toBeVisible();
  270 |   await page.getByRole('button', { name: '今日工作' }).click();
  271 |   await page.locator('.dashboard-card').filter({ hasText: '失败任务' }).click();
  272 |   await expect(page.getByRole('button', { name: /失败的首页任务/ })).toBeVisible();
  273 |   await expect(page.getByRole('button', { name: /运行中的首页任务/ })).toHaveCount(0);
  274 |   await page.getByRole('button', { name: '运行监控', exact: true }).click();
  275 |   await expect(page.getByRole('button', { name: /运行中的首页任务/ })).toBeVisible();
  276 |   await expect(page.getByRole('button', { name: /失败的首页任务/ })).toBeVisible();
  277 |   await page.getByRole('button', { name: '共享达人库', exact: true }).click();
  278 |   await expect(page.getByRole('button', { name: /待复核达人/ })).toBeVisible();
  279 |   await expect(page.getByRole('button', { name: /待联系达人/ })).toBeVisible();
  280 | });
  281 | 
  282 | test('网络失败与 AI 未配置时显示明确中文状态', async ({ page }) => {
  283 |   await mockAuthenticatedWorkspace(page, 'admin');
  284 |   await page.unroute('**/dashboard');
  285 |   await page.route('**/dashboard', async (route) => route.abort('failed'));
  286 | 
  287 |   await page.goto('/');
  288 |   await expect(page.getByRole('alert')).toContainText('网络连接失败');
  289 |   await page.getByRole('button', { name: 'AI 连接', exact: true }).click();
  290 |   await expect(page.getByText('尚未配置 AI 连接，人工复核仍可正常使用。')).toBeVisible();
  291 | });
  292 | 
  293 | for (const role of ['admin', 'operator', 'readonly'] as const) {
  294 |   test(`${labels[role]}只看到角色允许的管理操作`, async ({ page }) => {
  295 |     await mockAuthenticatedWorkspace(page, role);
  296 |     await page.goto('/');
  297 |     await expect(page.getByText(`${labels[role]}同事`)).toBeVisible();
  298 | 
  299 |     if (role === 'admin') {
  300 |       await expect(page.getByRole('button', { name: '创建筛选任务' })).toBeVisible();
  301 |       await page.getByRole('button', { name: '成员与邀请' }).click();
  302 |       await expect(page.getByRole('button', { name: '邀请成员' })).toBeVisible();
  303 |       await page.getByRole('button', { name: '采集设备', exact: true }).click();
  304 |       await expect(page.getByRole('button', { name: 'AI 连接' })).toBeVisible();
  305 |       await expect(page.getByRole('button', { name: '筛选模板' })).toBeVisible();
  306 |       await expect(page.getByRole('button', { name: '审计记录' })).toBeVisible();
  307 |       await expect(page.getByRole('button', { name: '生成配对码' })).toBeVisible();
  308 |     } else if (role === 'operator') {
  309 |       await expect(page.getByRole('button', { name: '创建筛选任务' })).toBeVisible();
  310 |       await expect(page.getByRole('button', { name: '成员与邀请' })).toHaveCount(0);
  311 |       await expect(page.getByRole('button', { name: 'AI 连接' })).toHaveCount(0);
  312 |       await expect(page.getByRole('button', { name: '筛选模板' })).toHaveCount(0);
  313 |       await expect(page.getByRole('button', { name: '审计记录' })).toHaveCount(0);
> 314 |       await page.getByRole('button', { name: '采集设备' }).click();
      |                                                        ^ Error: locator.click: Error: strict mode violation: getByRole('button', { name: '采集设备' }) resolved to 2 elements:
  315 |       await expect(page.getByRole('button', { name: '生成配对码' })).toBeVisible();
  316 |     } else {
  317 |       await expect(page.getByRole('button', { name: '创建筛选任务' })).toHaveCount(0);
  318 |       await expect(page.getByRole('button', { name: '成员与邀请' })).toHaveCount(0);
  319 |       await expect(page.getByRole('button', { name: '采集设备' })).toHaveCount(0);
  320 |       await expect(page.getByRole('button', { name: 'AI 连接' })).toHaveCount(0);
  321 |       await expect(page.getByRole('button', { name: '筛选模板' })).toHaveCount(0);
  322 |       await expect(page.getByRole('button', { name: '审计记录' })).toHaveCount(0);
  323 |       await expect(page.getByText('编辑操作由运营成员完成')).toBeVisible();
  324 |     }
  325 |   });
  326 | }
  327 | 
  328 | test('运营可配置三类规则与停止条件，保存后立即回显', async ({ page }) => {
  329 |   await mockAuthenticatedWorkspace(page, 'operator');
  330 |   let submittedCampaign: Record<string, unknown> | undefined;
  331 |   await page.route('**/campaigns', async (route) => {
  332 |     if (route.request().method() === 'POST') {
  333 |       submittedCampaign = route.request().postDataJSON() as Record<string, unknown>;
  334 |       await route.fulfill({
  335 |         contentType: 'application/json',
  336 |         json: { id: 'campaign-new', version: 1 },
  337 |       });
  338 |       return;
  339 |     }
  340 |     await route.fulfill({ contentType: 'application/json', json: { campaigns: [] } });
  341 |   });
  342 | 
  343 |   await page.goto('/');
  344 |   await page.getByRole('button', { name: '筛选任务', exact: true }).click();
  345 |   await page.getByRole('button', { name: '新建筛选任务' }).click();
  346 |   await page.getByLabel('任务名称').fill('开学季校园素人');
  347 |   await page.getByLabel('推荐画像说明').fill('校园日常、宿舍生活，最近推荐流中持续出现的年轻素人');
  348 |   await page.getByLabel('粉丝上限').fill('8000');
  349 |   await page.getByLabel('观察天数').fill('20');
  350 |   await page.getByLabel('点赞门槛').fill('15000');
  351 |   await page.getByLabel('AI 最多分析人数').fill('40');
  352 |   await page.getByLabel('内容偏好（可选）').fill('自然分享，不要明显商业账号');
  353 |   await page.getByLabel('最多浏览作品').fill('120');
  354 |   await page.getByLabel('最长运行分钟').fill('75');
  355 |   await page.getByLabel('目标候选数').fill('35');
  356 |   await page.getByLabel('人工复核项（可选）').fill('主页内容是否适合品牌合作');
  357 |   await page.getByRole('button', { name: '保存筛选任务' }).click();
  358 | 
  359 |   const savedSummary = page.getByRole('complementary');
  360 |   await expect(savedSummary.getByText('已保存')).toBeVisible();
  361 |   await expect(savedSummary.getByText('开学季校园素人', { exact: true })).toBeVisible();
  362 |   await expect(savedSummary.getByText(/粉丝 0–8000/)).toBeVisible();
  363 |   await expect(savedSummary.getByText(/爆款 20 天 \/ 15000 赞/)).toBeVisible();
  364 |   await expect(savedSummary.getByText(/AI 18–24 岁，最多 40 人/)).toBeVisible();
  365 | 
  366 |   expect(submittedCampaign).toMatchObject({
  367 |     name: '开学季校园素人',
  368 |     recommendationProfileDescription: '校园日常、宿舍生活，最近推荐流中持续出现的年轻素人',
  369 |     rules: {
  370 |       schemaVersion: 1,
  371 |       hardRules: [
  372 |         { type: 'follower-range', min: 0, max: 8000 },
  373 |         {
  374 |           type: 'recent-post-likes',
  375 |           windowDays: 20,
  376 |           minimumLikes: 15000,
  377 |           minimumMatchingPosts: 1,
  378 |         },
  379 |       ],
  380 |       aiRules: [
  381 |         { type: 'estimated-age-band', minAge: 18, maxAge: 24 },
  382 |         { type: 'amateur-status' },
  383 |         { type: 'content-fit', prompt: '自然分享，不要明显商业账号' },
  384 |       ],
  385 |       manualChecks: [{ type: 'review-check', label: '主页内容是否适合品牌合作' }],
  386 |       stopConditions: {
  387 |         maxFeedItems: 120,
  388 |         maxDurationMinutes: 75,
  389 |         targetCandidates: 35,
  390 |       },
  391 |       aiLimits: { maximumCandidates: 40, concurrency: 1 },
  392 |     },
  393 |   });
  394 | });
  395 | 
  396 | test('运行监控实时显示进度、停止原因、领取设备和错误', async ({ page }) => {
  397 |   await mockAuthenticatedWorkspace(page, 'operator');
  398 |   let requestCount = 0;
  399 |   const now = '2026-09-15T08:00:00.000Z';
  400 |   await page.route('**/runs', async (route) => {
  401 |     requestCount += 1;
  402 |     const feedItemsSeen = requestCount > 1 ? 18 : 12;
  403 |     await route.fulfill({
  404 |       contentType: 'application/json',
  405 |       json: {
  406 |         runs: [
  407 |           {
  408 |             id: 'run-live',
  409 |             campaignId: 'campaign-live',
  410 |             campaignName: '校园实时采集',
  411 |             ruleVersion: 2,
  412 |             status: 'running',
  413 |             stopReason: null,
  414 |             errorCode: null,
```