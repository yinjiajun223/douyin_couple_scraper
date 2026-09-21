## Why

每条采集到的观测目前都会写入 `campaign_candidates` 与 `rule_evaluations`，不论硬筛结论是 `pass`、`fail` 还是 `unknown`；`unknown` 还会额外上传一张主页截图到 OSS。但运营真正能处理的只有 `pass` 那部分——今日工作台的三个计数器已经写死只统计 `hard_filter_status = 'pass'`，「证据不足」分区从来不被任何计数器计入，实际上是一个无人负责的死角。结果是达人库被大量不可行动的条目淹没，人工复核后通过的少数候选反而难找，OSS 里堆积着没有消费者的截图。

同时，人工复核结论（`manual_reviews.decision`）与跟进阶段（`pipeline_status`）是两条互不联动的轴：`approved` 与 `to_contact`、`rejected` 与 `unsuitable` 语义重叠，运营要在两处各操作一次，还容易留下自相矛盾的状态（已 approved 但 pipeline 仍停在 pending_review）。运营想要的「人工审核通过」这个分组，本质上就是 pipeline 的一个阶段，不应该再引入第三条状态轴。

## What Changes

- **入库闸门**：只有硬筛 `pass` 的观测才创建 `campaign_candidates` 行；**已存在的候选行仍照常更新**采集事实指针，遵循「一旦晋级，持续跟踪」——避免已在跟进的达人因指标波动而停在过时的观测指针上。更新路径**不再改写 `hard_filter_status`**：该列语义收紧为「入库资格（创建时判定）」，否则一个已晋级候选在指标掉出区间后会被达人库默认谓词 `<> 'fail'` 静默过滤掉，运营正在跟进的达人会凭空消失。「本轮是否仍达标」改由采集事实 + 规则快照重算得出。
- 非 `pass` 的观测不再写 `rule_evaluations`。「为什么被筛掉」这个结论可由不可变的原始观测（`creator_observations.follower_count`、`post_observations.like_count` / `published_at`）加上不可变的 `campaign_rule_versions.rules_json` 与该 run 的规则版本关联确定性地重算，无需物化。
- **层 1 事实账本保持全量写入，不做门控**：`creators`、`creator_observations`、`posts`、`post_observations`、`run_creator_sources` 照旧为所有观测写入。它是跨运行去重与复采判断的唯一依据，单行成本约数百字节，远低于因丢失去重记忆而重复打开主页所带来的采集时间成本与平台风控风险。
- **人工复核驱动状态流转**：提交复核结论时在同一事务内自动推进 pipeline——`approved` → `to_contact`，`rejected` → `unsuitable`。**仅当当前 `pipeline_status` 为 `pending_review` 时推进**；否则只记录结论、不动状态、不报错（复核结论是 append-only 的历史证据轴，pipeline 是当前状态轴，职责分离）。沿用既有乐观锁，`version` 只递增一次。转换矩阵无需修改（`pending_review → unsuitable | to_contact` 已合法）。
- **BREAKING（UI 行为）** 达人库分区轴由硬筛结论改为 pipeline 阶段：待复核 / 待联系 / 跟进中 / 已合作 / 不合适；**移除「证据不足」分区**。日期分组保留。前端因此变简单：列表查询不再需要传 `hardFilterStatus`，分区匹配逻辑丢掉硬筛判断。
- `hardFilterStatus` API 过滤参数**保留**，管理员仍可查询历史 `fail` / `unknown` 候选；只是 UI 不再提供入口。
- **worker 媒体清理扩展**：新增一类回收目标——`status = 'confirmed'` 但其关联观测没有对应 `pass` 候选行的截图（孤儿证据），复用既有两阶段删除（claim → `expired` → `deleteObject` → `deleted`），并带 7 天宽限期以避免删掉刚入库、候选行尚未建立的对象。
- **采集器截图门控收紧**：条件由 `outcome === 'fail'` 改为 `outcome !== 'pass'`。**不改协议、不改 `@douyin/contracts`、不动 `COLLECTOR_PROTOCOL_VERSION` 与 `COLLECTOR_MIN_VERSION`**，因此 v0.1.5 采集器对新服务端保持完全兼容，不强制升级；该改动搭下一次自然发包的便车即可，在此之前孤儿截图由 worker 回收。
- **零数据库迁移**：存量 `fail` 候选行在默认列表中已被隐藏；存量 `unknown` 候选行随「证据不足」分区移除而不再可见。数据保留在库中，不删除、不迁移，符合「迁移只向前、不删生产数据」的约束。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `screening-campaigns`: 硬筛结论对入库的影响从「记录所有结论」变为「只有 pass 结论创建候选」；明确层 1 事实账本不受门控、非 pass 不物化规则评估记录。
- `creator-candidate-library`: 达人库的组织轴由硬筛结论改为 pipeline 阶段；移除「证据不足」视图；明确存量非 pass 候选的可见性规则与历史查询入口。
- `creator-review-and-outreach`: 人工复核结论新增对 pipeline 状态的自动推进语义，及其仅在 `pending_review` 生效的边界与失败处理。
- `douyin-local-collection`: 主页截图的采集与上传门控由「排除 fail」收紧为「仅 pass」。
- `hosted-platform-operations`: 私有 OSS 素材新增孤儿证据回收责任（已确认但无对应入库候选的截图）；明确本 change 不构成采集助手协议变更、不提高最低支持版本，旧版助手上传的多余截图由服务端回收而非拒绝。

> 排序依赖：`openspec/specs/` 目前为空，上述四个 capability 仅以 delta 形式存在于尚未归档的 `build-douyin-influencer-ops-platform`（90/94）。该 change 应先归档，使 delta 落入主 specs，本 change 的 delta 才有可修改的基线。

## Impact

**服务端（packages/domain）**
- `src/ingestion/collector-ingestion.ts` — `findOrCreateCandidate` 增加「仅 pass 时创建」条件；`rule_evaluations` 写入随之跳过。
- `src/candidates/candidate-workflow.ts` — `submitManualReview` 增加 pipeline 自动推进与事件写入。
- `src/media/media-cleanup.ts` — 新增孤儿证据回收路径与宽限期配置。
- `src/config.ts` — 新增孤儿回收宽限期环境变量。

**API（apps/api）**
- `src/server.ts` — 复核路由响应体需反映推进后的 pipeline 状态；`GET /candidates` 的分区语义变化（过滤参数本身不变）。

**前端（apps/web）**
- `src/pages/CandidatesPage.tsx` — 分区状态由 `qualified | needs_evidence` 改为 pipeline 分组；查询构造去掉 `hardFilterStatus`。
- `src/lib/date.ts` — `candidateMatchesLibraryView` 去掉硬筛判断；`groupCandidatesByDate` 不变。
- `src/constants.ts` — 新增分区标签（复用既有 `pipelineStatusOptions` 文案）。

**采集器（apps/collector）**
- `src/runtime.ts` — 截图门控条件一行改动。不触发协议或契约变更，不需重发采集包即可上线服务端部分。

**worker（apps/worker）**
- 无代码改动，行为随 `media-cleanup` 扩展而变。

**运维与文档**
- 新增孤儿回收的配置项需同步 `infra/production` 与 `.env` 样例。
- `docs/product-manual.md`、`docs/operations/operator-guide.md` 需同步达人库分区变化与「复核即流转」的新行为。
- `docs/collector-windows.md`、`docs/collector-macos.md` 需说明截图门控收紧为可选升级、旧版采集器仍可正常工作。

**明确不在本 change 范围内**
- 不启用 `workspace_roles` 自定义角色（表虽已建并 seed，但运行时从不读取，且 CHECK 仅允许三个角色名）。
- 不做「暂存 N 天后不可逆过期」的激进 OSS 生命周期策略——它把复核时限变成硬约束，收益不比孤儿回收更大。
- 不对存量数据做迁移或清理。
- 不改动 `COLLECTOR_MIN_VERSION`，避免重演被迫全员升级的情况。
- 候选软归档、批量操作、标签写入、成员管理属于 `admin-data-and-member-operations`。
