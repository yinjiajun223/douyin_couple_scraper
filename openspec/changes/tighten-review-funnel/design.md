## Context

动机见 proposal.md - Why。这里只记录影响技术选型的现状与约束。

**入库路径现状**（`packages/domain/src/ingestion/collector-ingestion.ts`）：`ingestCollectorBatch`（:82-141）在单事务内逐条处理观测，`ingestCreatorObservation`（:182-334）依次写 `creators` → `creator_observations` → `run_creator_sources` → `posts` / `post_observations` → 服务端重算硬筛（:288-297）→ `findOrCreateCandidate`（:298-305）→ 每条硬规则一行 `rule_evaluations`（:306-331）。`findOrCreateCandidate`（:336-382）当前对**所有**结论都执行：已存在则 `SELECT ... FOR UPDATE` 后更新，不存在则插入。

**返回契约**：批次 ack 为 `{ observationId, status: 'accepted'|'duplicate'|'rejected', reason? }`（`packages/contracts/src/collector.ts:74-82`），**不含 candidateId**。采集器只在 `status === 'rejected'` 时中止运行（`apps/collector/src/runtime.ts:663`）。这是「服务端单侧改动即可生效」的关键前提。

**截图门控现状**：`runtime.ts:506-511` 为 `filter.outcome === 'fail' ? null : await screenshot(...)` —— fail 已不截图，unknown 仍截图。上传调用在 `flushPending`（:657-692）中**没有 try/catch**，而 `apps/collector/src/media-upload.ts` 在任何失败上都 `throw`（:74, :81, :85, :94, :115, :122）。因此服务端拒绝签发上传凭证会直接终止整轮采集。

**状态轴现状**：`hard_filter_status`（pass/fail/unknown）× `manual_reviews.decision`（pending/approved/rejected）× `pipeline_status`（7 值）三轴并存。转换矩阵（`packages/domain/src/candidates/candidate-workflow.ts:24-32`）已允许 `pending_review → unsuitable | to_contact`。`submitManualReview`（:148-190）当前不触碰 `pipeline_status`。

**已存在的死代码**：`campaign_candidates.archived_at`（0004:12）从未被写入，但 dashboard 已在过滤它（`operations-dashboard.ts:37,42,48`）；dashboard 三个计数器均已写死 `hard_filter_status = 'pass'`（:38,43,49），而达人库默认列表只排除 `fail`（`candidate-library.ts:293-298`）—— 两者对 unknown 的处理本来就不一致。

**硬约束**：
- `creator_observations`、`post_observations`、`candidate_events`、`audit_events`、`campaign_rule_versions` 有 `BEFORE UPDATE/DELETE ... SIGNAL` 触发器，物理删除或改写在数据库层面不可能。
- `rule_evaluations.candidate_id` 是外键，无候选行即无法写入规则评估。
- AGENTS.md：迁移只向前、不修改已执行迁移、不删生产数据；生产 OSS 必须保持 private 且最小权限；不得关闭 TLS 校验。
- 采集器发布成本高（GitHub Actions 手动触发、Mac 侧 Gatekeeper 首启阻断、每机单实例导致的端口占用），应尽可能避免被迫升级。

## Goals / Non-Goals

**Goals:**
- 服务端与前端可独立于采集器发布：本次变更 MUST NOT 强制任何已分发采集器升级。
- 零数据库迁移即可上线入库闸门与分区轴切换，存量数据不动、不删、不迁。
- 人工复核成为单一操作：一次提交同时落结论与阶段，不再需要两处各点一次。
- OSS 中不保留没有业务消费者的截图，且回收过程可安全重跑、可中断恢复。

**Non-Goals:**
- 不减少采集器上报的数据量：fail/unknown 的结构化观测仍照常同步，本设计不优化上行带宽。
- 不实现「已判负名单」下发给采集器以跳过重复主页访问 —— 那需要新增协议接口，属独立变更。
- 不做候选软归档、批量操作、标签写入、成员管理（见 `admin-data-and-member-operations`）。
- 不引入不可逆的时间窗淘汰策略（例如「N 天未复核即永久丢弃证据」）。
- 不改 `hard_filter_status` 的取值域，不删列，不收紧 CHECK 约束。

## Decisions

### D1: 闸门只作用于候选记录的「创建」，且 `hard_filter_status` 只在创建时写入

`findOrCreateCandidate`（:336-382）改为：

- **未命中已存在行**：仅 `outcome === 'pass'` 时插入，`hard_filter_status` 写入 `'pass'`。
- **命中已存在行**：照旧更新 `latest_run_id`、`latest_creator_observation_id`、`version`，但**从 UPDATE 中移除 `hard_filter_status = ?`**（当前在 :358）。

**为什么**：全量闸门会让「第一次 pass 进库、运营已在跟进、第二次采集指标掉出区间」的候选停在过时的 `latest_creator_observation_id` 上。已晋级即持续跟踪，是可解释性更强的语义。

**为什么必须同时移除 UPDATE 中的 `hard_filter_status`**：达人库默认谓词是 `candidates.hard_filter_status <> 'fail'`（`candidate-library.ts:296-298`）。若更新路径照旧改写该列，一个已晋级候选在指标掉出区间后会被写成 `fail`，随即从达人库**静默消失** —— 运营正在跟进的达人凭空不见，且无任何提示。这比维持现状更糟。

移除后该列语义收紧为**「入库资格（创建时判定）」**而非「最近一次运行的硬筛结论」：门控上线后新建行恒为 `pass`，存量行保留历史值。「本轮是否仍达标」不再由该列承载，而由 D2/Group 4 的重算能力从不可变采集事实 + 规则快照推导 —— 这两者本来就在建设，因此没有信息损失。

**代价**：想知道「已入库达人当前是否仍达标」必须走重算路径，不能只读一个列。可接受：该列从来就不是本轮结论的可靠来源（它只在有新观测时才更新）。

**额外收益**：默认谓词无需改动，存量 `fail` 行继续被隐藏，存量 `unknown` 行随「待补证据」分区移除而不可见（见 D4），零迁移成立。

**备选**：全量闸门（更新也跳过）—— 被否，产生过时数据；保留 UPDATE 改写并同步放宽默认谓词 —— 被否，会让存量 `fail` 行涌入待复核队列；非 pass 时把候选软归档 —— 被否，会自动归档运营正在跟进的达人，且与 `admin-data-and-member-operations` 的人工归档语义冲突。

### D2: 非 pass 不物化 `rule_evaluations`，改为依赖可重算性

不写候选行，随之不写规则评估行。「为什么没进库」的判定依据由三者重构：不可变的采集事实（`creator_observations.follower_count`、`post_observations.like_count` / `published_at`，缺失即为 NULL）+ 不可变的 `campaign_rule_versions.rules_json` + `collection_runs` 与该规则版本的关联（`assertRunOwnership` 已在加载它，:143-164）。三者均不可变，重算结果确定。

**为什么**：为可确定性重算的数据保留一张隐藏表是纯负债，且它必须靠 `archived_at` 之类的标记与真实候选区分，增加所有读路径的心智负担。

**风险**：重算需要代码路径支持，若从未实现，「可重算」就只是理论能力。→ 缓解：把重算入口作为一个明确的实现任务落地（哪怕只暴露为管理员诊断能力），而不是仅在文档里声称。

**备选**：写 `hard_filter_status = 'fail'` + `archived_at = now()` 的隐藏候选行 —— 被否，理由同上，且会与 D1 的「已存在则更新」逻辑纠缠（隐藏行会被后续运行命中并更新，语义更混乱）。

### D3: 层 1 事实账本完全不门控

`creators`、`creator_observations`、`posts`、`post_observations`、`run_creator_sources` 对所有结论照旧写入。

**为什么**：`creators` 的 `UNIQUE(workspace_id, platform, platform_creator_id)` 是跨运行、跨任务去重的唯一依据。不写它，同一个不达标达人会在每轮运行中被重新打开主页、重新解析、重新上报 —— 采集器的时间成本与平台风控风险，远高于每行数百计字节的存储成本。这也保住了 `screening-campaigns` 与 `creator-candidate-library` 中「统一达人主档与跨任务去重」的既有要求。

**备选**：只写 `creators` 不写 observations —— 被否，去重需要 `creators`，但可追溯性与重算需要 observations；拆开写会同时丢掉两者的一半价值。

**同一闸门也作用于旧数据导入**：`legacy-import.ts` 走的是同一条入库路径，且旧导出只有主页字段（`posts: []`），硬筛结论恒为「数据未知」，因此导入后不再产生任何候选记录，其 `progress_json.candidatesFound` 也据实记为 0。事实账本、作者主档与来源关系照旧完整写入，判定依据可由 D2 的重算能力查看。随之失效的 `preserveMissingLegacyPostEvidence`（往 `rule_evaluations` 与 `campaign_candidates` 回写 unknown 标记）已删除：闸门后这两张表对旧导入恒无行可写。

**代价**：旧数据导入从「填充达人库」变成「只填充事实账本」。这是刻意的 —— 导入的达人都缺少作品数据，即使入库也必然卡在人工复核，正是本次要消除的成本来源。

### D4: 存量数据靠「移除 UI 入口」隔离，不做迁移

存量 `fail` 候选行：默认列表本已排除（`candidate-library.ts:297`），无需处理。存量 `unknown` 候选行：随「待补证据」分区移除而自然不可见。两者都保留在库中，`hardFilterStatus` 服务端过滤参数保留供管理员查询。

**为什么**：AGENTS.md 禁止删生产数据，而软归档存量行需要一次数据迁移 + 一个从未被写入过的列的首次启用，风险与收益不成比例。移除 UI 入口达到同样的运营效果，且完全可逆（恢复分区即恢复可见性）。

**代价**：存量 `unknown` 行的截图仍占 OSS，需靠 D6 的孤儿回收处理。

### D5: 复核自动推进阶段，仅在 `pending_review` 时生效，单事务单版本递增

`submitManualReview` 在同一事务内：乐观锁校验（沿用 `assertCandidateVersion`，:490-494）→ 插入 `manual_reviews` → 若 `pipeline_status === 'pending_review'` 则更新为 `approved ? 'to_contact' : 'unsuitable'` 并追加 `pipeline_status_changed` 事件 → 追加 `manual_reviewed` 事件 → 写 `candidate.reviewed` 审计 → `version` 递增一次。

**为什么只限 `pending_review`**：转换矩阵只保证该起点合法；从其他阶段强行推进会破坏既有流转规则，或需要扩大矩阵（超出本次范围）。

**为什么不满足条件时不报错**：`manual_reviews` 是 append-only 的历史证据轴，`pipeline_status` 是当前状态轴。运营已手动推进后他人补交结论，应被记录而非拒绝。这与 `creator-review-and-outreach` 的「补充复核结论不覆盖历史」场景一致。

**为什么单版本递增**：两次递增会让前端的乐观锁在一次用户操作中失效两次，产生难以解释的冲突提示。实现上合并为一条 `UPDATE campaign_candidates SET pipeline_status = COALESCE(?, pipeline_status), version = version + 1`，推进与递增不可能只做一半。

**事件顺序不可观测**：上面的写入次序（先 `pipeline_status_changed` 后 `manual_reviewed`）在数据库里无法被还原 —— `candidate_events` 只有毫秒级 `created_at` 与随机 UUID 主键（`0004_candidate_decisions.sql:147-163`），而 `getCandidateWorkflow` 按 `created_at DESC, id DESC` 排序，同一事务内的两条事件几乎必然同毫秒，先后由随机 UUID 决定。这不构成正确性问题（两条事件同属一个原子操作，UI 历史里谁先谁后都不改变事实），因此不为排序新增序列列，测试也只断言两条事件的存在与内容。

**`decision = 'pending'` 的处理**：记录结论但不推进阶段（矩阵中没有指向 `pending_review` 自身的转换，且「待定」语义就是保持待复核）。

**备选**：要求 `pipeline_status` 必须为 `pending_review`，否则 409 —— 被否，会把「补记录」这个合法诉求变成错误；完全解耦两轴、只做 UI 联动 —— 被否，无法阻止服务端出现自相矛盾状态。

### D6: 孤儿截图由 worker 回收，而非服务端拒绝上传

服务端**不**在 `assertUploadScope`（`media-service.ts:381-410`）中增加「必须存在 pass 候选行」的校验。改由 `cleanupMediaObjects`（`media-cleanup.ts:28-92`）新增一类回收目标：`status = 'confirmed'` 且其 `creator_observation_id` 找不到对应入库候选行的对象，超过宽限期后删除。

**为什么**：服务端拒绝会经 `media-upload.ts` 的 `throw` 直接终止整轮采集（见 Context）。这是硬约束，不是权衡。

**实现约束**：
- 复用既有两阶段删除（claim → `expired` → `deleteObject` → `deleted`，:104-123），保证中断可重跑。
- `media_objects` 行永不物理删除，保留「曾存在何种证据」的可追溯性。
- 宽限期必须长于「素材确认 → 候选行建立」的最大正常间隔。注意当前实现顺序是**先入库批次、后上传截图**（`runtime.ts:660-687`），所以候选行在截图确认时通常已存在；宽限期主要为重试与乱序场景兜底。
- 回收查询涉及 `media_objects → creator_observations → campaign_candidates` 连接，必须沿用既有批大小上限（`MEDIA_CLEANUP_BATCH_SIZE`，默认 100）并确认走索引，避免全表扫描。
- 与既有的「已归档任务 + 超保留期」回收路径（:58-80）互不干扰，两条路径各自独立判定。

**备选**：改采集器让其在 unknown 时也不截图，服务端同时拒绝 —— 被否，会让未升级的采集器整轮失败；OSS 生命周期规则按前缀自动过期 —— 被否，需要区分暂存/永久前缀并在通过时 `copyObject`，引入不可逆时间窗，复杂度高于收益。

### D7: 采集器改动是一行，且刻意不触碰契约

`runtime.ts:506-511` 的条件由 `filter.outcome === 'fail'` 改为 `filter.outcome !== 'pass'`。不改 `COLLECTOR_PROTOCOL_VERSION`、不改 `@douyin/contracts`、不改 `COLLECTOR_MIN_VERSION`、不改 `apps/collector/package.json` 版本号。

**为什么**：这正是 v0.1.5 那次被迫全员升级的反面 —— 那次因为 `CAMPAIGN_RULE_SCHEMA_VERSION` 从 1 提到 2，采集器打包了 `@douyin/contracts`，于是服务端发布强制触发采集器重发。本次刻意把改动限制在采集器内部行为，使服务端发布与采集器发布解耦。

**发布策略**：服务端部分先行上线并独立生效；采集器这一行搭下一次自然发包的便车。在此之前 unknown 的多余截图由 D6 回收。

**代价**：过渡期内 unknown 截图仍会白传一次（占用运营上行带宽，存储被回收）。可接受。

### D8: 达人库分区轴换成 pipeline 阶段，前端做减法

分区状态由 `'qualified' | 'needs_evidence'` 改为 pipeline 分组（待复核 / 待联系 / 跟进中 / 已合作 / 不合适）。`buildCandidateQuery` 不再传 `hardFilterStatus`；`candidateMatchesLibraryView`（`apps/web/src/lib/date.ts:27-36`）去掉硬筛判断；`groupCandidatesByDate`（:39-55）与日期筛选完全不动。

**为什么这样分组**：7 个 pipeline 值收成 5 个分区（跟进中 = contacted + communicating，不合适 = unsuitable + declined）以控制 tab 数量；spec 写为「至少提供五个分区」，具体合并方式留给实现，不影响行为契约。

**为什么是减法**：分区轴与既有 `preset` 过滤（`'pending_review' | 'to_contact' | 'mine'`）本就是同一维度，合并后少一个正交过滤器，`hardFilterStatus` 也从查询构造中消失。

**顺带修复**：dashboard 计数器只数 pass 而达人库展示 unknown 的既有不一致，随 unknown 不再进库而自动消失。

## Risks / Trade-offs

**[数据未知的达人可能其实达标，永久错失]** → 层 1 采集事实完整保留，`hardFilterStatus` 服务端过滤保留，管理员仍可查询历史；后续可基于层 1 数据实现「复采队列」重新抓取。这是本设计接受的、有恢复路径的损失，不是不可逆丢弃。

**[孤儿回收误删仍需要的证据]** → 宽限期可配置且首次上线取保守值；`media_objects` 行不物理删除，保留 object_key 与删除状态可供审计；回收查询以「不存在对应入库候选行」为唯一判据，D1 保证已入库候选（含掉出区间的）始终有行，因此不会被误判为孤儿。

**[孤儿回收是全设计中唯一不可逆的部分]** → 分阶段上线：先上闸门 + 分区切换 + 自动流转（全部可逆，回滚即恢复），观察一段时间确认候选行创建正常后，再启用回收。见 Migration Plan。

**[运营发现「证据不足」分区消失，以为数据丢了]** → 同步更新 `docs/product-manual.md` 与 `docs/operations/operator-guide.md`，说明该分区已取消、原因、以及管理员如何查询历史非通过数据。

**[自动流转改变既有操作习惯]** → 仅在 `pending_review` 生效，其余情况只记录不推进，不会出现「点了复核却把已联系的人打回待联系」；UI 在提交后立即反映新阶段，使因果可见。

**[回收查询在大数据量下变慢]** → 沿用既有批大小上限，确认连接走 `media_objects.creator_observation_id` 与 `campaign_candidates.creator_id` 上的索引；必要时在实现阶段补索引（属向前迁移，允许）。

**[D2 的「可重算」若不落地就成了空话]** → 在 tasks 中列为独立可验证任务，而非文档声明。

**[`hard_filter_status` 列语义漂移]** → 该列由「最近一次运行的硬筛结论」收紧为「入库资格（创建时判定）」。保留列与 CHECK 约束不动、不改取值域；新行恒为 `pass`，存量行保留历史三值并继续被默认谓词隐藏。代码中以命名与注释明确该语义，避免后续实现者误当作本轮结论使用。

## Migration Plan

**数据库**：本次核心变更**无迁移**。仅当 D6 的回收查询需要新索引时，追加一个向前的 expand 迁移，不修改任何已执行过的迁移文件。

**分阶段上线**（每阶段独立可回滚）：

1. **阶段 A — 入库闸门 + 自动流转（服务端）**：发布 api 与 worker 镜像。可逆性：回滚镜像即恢复旧行为；期间少建的候选行可由后续运行重新采集建立（层 1 数据完整，`findOrCreateCreator` 会命中同一主档）。
2. **阶段 B — 达人库分区切换（前端）**：发布 web 镜像。可逆性：回滚即恢复旧分区；存量 unknown 行重新可见。
3. **观察期**：确认候选行创建量符合预期、复核流转正常、没有运营反馈数据缺失。**在观察期结束前不启用阶段 C。**
4. **阶段 C — 启用孤儿回收（worker）**：以保守宽限期开启。可逆性：关闭开关即停止回收，但**已删除的 OSS 对象不可恢复** —— 这是全流程唯一不可逆步骤，因此被隔离到最后且需显式开启。
5. **阶段 D — 采集器一行改动**：搭下一次自然发包，不单独发版，不提高最低版本要求。

**部署机制**：沿用既有本地构建 + `docker save` tar 侧载流程（生产主机无法访问 Docker Hub，镜像只在 Windows 本机构建），标签按 `YYYYMMDD-N` 约定，切换前保留 `.previous-images.env` 与 infra 备份以便回滚。

**回滚策略**：阶段 A/B 回滚镜像即可，无数据修复动作。阶段 C 一旦执行不可回滚已删对象，因此其开关默认关闭、宽限期默认保守，且启用前需确认阶段 A 的候选行创建行为已稳定。

**采集器兼容性**：全过程不提高 `COLLECTOR_MIN_VERSION`，v0.1.5 采集器在阶段 A-D 期间均保持完全可用，无需通知运营升级。

## Resolved Questions

以下四项在写 tasks 前已确定，不再作为待定项。

- **孤儿回收宽限期 = 7 天**，经环境变量可调（与既有 `MEDIA_RETENTION_DAYS`、`MEDIA_CLEANUP_BATCH_SIZE` 同一配置风格）。7 天远长于「素材确认 → 候选行建立」的正常间隔，首次上线取保守值。
- **达人库分区 = 5 个**（待复核 / 待联系 / 跟进中 / 已合作 / 不合适），不拆成 7 个 pipeline 值各一个 tab。spec 写为「至少五个分区」，后续如需细分属纯 UI 调整。
- **历史非通过数据不提供默认界面入口**，仅保留服务端 `hardFilterStatus` 查询参数，且仍受同一套记录级可见范围约束。运营确有需求时再单独提变更。
- **D2 的重算入口暴露为运行详情内的运营可见能力**，不是仅内部函数。理由：`screening-campaigns` 的「追溯未入库达人的判定依据」场景要求*成员*能解释某达人为何未进复核队列，而未入库达人没有候选行，无法从达人库导航到达。实现为 `GET /runs/:runId/observed-creators`（只读，可见范围继承既有运行归属校验）+ `RunsPage` 详情面板；底层重算逻辑放在 `@douyin/domain`，与该接口共用同一实现，避免「文档声称可重算但无代码路径」。
