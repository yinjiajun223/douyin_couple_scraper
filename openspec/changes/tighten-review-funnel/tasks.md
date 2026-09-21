## 1. 入库闸门（domain，阶段 A）

- [x] 1.1 修改 `packages/domain/src/ingestion/collector-ingestion.ts` 的 `findOrCreateCandidate`（:336-382）：未命中已存在行时仅在 `outcome === 'pass'` 才 INSERT，返回 `null` 表示未建候选；命中已存在行时保留 UPDATE 的 `latest_run_id`、`latest_creator_observation_id`、`version = version + 1`，并从 SET 子句中**移除 `hard_filter_status = ?`**（:358）。验证：`npm run typecheck -w @douyin/domain` 通过，且调用点已适配可空返回值。
- [x] 1.2 调整 `ingestCreatorObservation`（:182-334）：候选为 `null` 时跳过 `rule_evaluations` 写入（:306-331），不抛错、不影响同批次其余观测。验证：`npm run test -w @douyin/domain` 通过。
- [x] 1.3 在 `packages/domain/src/ingestion/collector-ingestion.integration.test.ts` 补闸门用例：pass 首次入库、fail 首次不入库、unknown 首次不入库、fail/unknown 观测仍写满 `creators` / `creator_observations` / `posts` / `post_observations` / `run_creator_sources`、非 pass 观测的 `rule_evaluations` 行数为 0、pass 观测的行数等于硬规则条数。验证：`npm run test:mysql` 通过（需本机 Docker 与 MySQL）。
- [x] 1.4 在同一集成测试文件补「一旦晋级持续跟踪」用例：已存在候选在后续运行结论为 fail / unknown 时，`latest_creator_observation_id` 与 `latest_run_id` 被更新、`hard_filter_status` 保持 `'pass'`、`version` 递增。验证：`npm run test:mysql` 通过。
- [x] 1.5 在同一集成测试文件补跨运行去重回归用例：同一 `platform_creator_id` 在两次运行中均为 fail，`creators` 只有一行且两条观测都挂在同一主档上。验证：`npm run test:mysql` 通过。
- [x] 1.6 在 `apps/api/src/ingestion.integration.test.ts` 锁定批次 ack 语义：fail 与 unknown 观测仍返回 `accepted`（重复提交返回 `duplicate`），任何情况下都不返回 `rejected`。验证：`npm run test:mysql` 通过，且 `git diff --stat packages/contracts` 为空。
- [x] 1.7 处理闸门对旧数据导入的连带影响（实施中发现，见 design.md D3）：`legacy-import.ts` 的 `progress_json.candidatesFound` 由 `importedObservations` 改为 0（旧导出无作品数据，硬筛恒为未知，不再产生候选），删除随之失效的 `preserveMissingLegacyPostEvidence`，并更新 `legacy-import.integration.test.ts` 断言为「候选为空、事实账本与来源关系照旧写入」。验证：`npm run test -w @douyin/domain` 与 domain 集成套件全绿。
- [x] 1.8 修正 `candidate-library.integration.test.ts`：`filter-old-fail` 不再由采集产生候选行，改为直接插入一行存量 `fail` 候选，以继续验证 `hardFilterStatus` 显式过滤对历史行生效。验证：domain 集成套件全绿。

## 2. 复核即推进阶段（domain + api，阶段 A）

- [x] 2.1 修改 `packages/domain/src/candidates/candidate-workflow.ts` 的 `submitManualReview`（:148-190）：在同一事务内依次执行 `assertCandidateVersion`（:490-494）→ INSERT `manual_reviews` → 仅当 `pipeline_status === 'pending_review'` 且 `decision !== 'pending'` 时更新为 `approved ? 'to_contact' : 'unsuitable'` 并 `appendCandidateEvent('pipeline_status_changed')` → `appendCandidateEvent('manual_reviewed')` → 写 `candidate.reviewed` 审计 → `version` 只递增一次。验证：`npm run typecheck -w @douyin/domain` 通过。
- [x] 2.2 在 `packages/domain/src/candidates/candidate-workflow.integration.test.ts` 补自动流转用例：`pending_review` + approved → `to_contact`、`pending_review` + rejected → `unsuitable`、`pending_review` + pending → 阶段不变、非 `pending_review` + approved → 记录结论但阶段不变且不报错、版本不匹配 → 冲突错误且 `manual_reviews` / `candidate_events` / `pipeline_status` / `version` 全部无变化。验证：`npm run test:mysql` 通过。
- [x] 2.3 在同一文件补单版本递增与事件断言：一次成功提交后 `version` 恰好 +1，`candidate_events` 恰好含 `pipeline_status_changed`（仅推进时）与 `manual_reviewed` 两条，审计表含一条 `candidate.reviewed`。**实施修正**：`candidate_events` 只有毫秒级 `created_at` 与随机 UUID 主键（`0004_candidate_decisions.sql:147-163`），同一事务内写入的两条事件在 `ORDER BY created_at DESC, id DESC` 下没有可依赖的先后次序，因此断言两条事件的存在与内容，不断言其相对顺序；不为排序新增序列列（超出本次范围）。验证：`npm run test:mysql` 通过。
- [x] 2.4 在同一文件补回滚用例：在写审计前注入失败，断言 `manual_reviews`、`candidate_events`、`pipeline_status`、`version` 均未被修改。验证：`npm run test:mysql` 通过。
- [x] 2.5 更新 `apps/api/src/server.ts` 的复核路由（:920）响应体，返回推进后的 `pipelineStatus` 与 version。**实施修正**：该路由本就透传 `submitManualReview` 的返回值，domain 增加 `pipelineStatus` 后无需改动 server.ts；改为在 `apps/api/src/ingestion.integration.test.ts` 的闸门用例末尾断言响应体与数据库一致。验证：`npm run test:mysql` 通过，`npm run typecheck -w @douyin/api` 通过。
- [x] 2.6 连带修正 `packages/domain/src/ingestion/collector-ingestion.integration.test.ts` 的复核链路：原先「复核 → 显式推进到 `to_contact`」在自动推进后会变成 `to_contact → to_contact`（不在流转矩阵内），改为断言复核自身已推进到 `to_contact`（version 2），再显式推进到 `contacted`（version 3）。验证：domain 集成套件全绿。

## 3. 未入库达人的判定依据（domain + api + web）

- [ ] 3.1 在 `packages/domain/src/screening/` 新增重算能力：输入一次运行的 `runId` 与 `creatorId`，从不可变的 `creator_observations` / `post_observations` 与 `campaign_rule_versions.rules_json` 复用 `evaluateHardFilters` 推导出结论及依据字段（粉丝数、命中作品点赞数与发布时间，缺失即标记未知，不得填 0）。验证：新增单元测试与 `packages/domain/src/screening/hard-filter.test.ts` 同风格，`npm run test -w @douyin/domain` 通过。
- [ ] 3.2 在 `apps/api/src/server.ts` 新增只读路由 `GET /runs/:runId/observed-creators`，复用 `assertRunOwnership`（`collector-ingestion.ts:143-164`）的可见范围规则：运营人员只能读自己名下设备的运行，管理员可读全部，越权返回与「运行不存在」相同的响应以不泄露存在性。验证：在 `apps/api/src/runs.integration.test.ts` 补三类断言（本人可读、他人不可读且响应与不存在一致、管理员可读），`npm run test:mysql` 通过。
- [ ] 3.3 在 `apps/web/src/pages/RunsPage.tsx` 的运行详情列新增面板，展示该运行观察到的达人、是否已入库、重算结论与依据字段；未识别字段显示「未知」而不是 0 或空。验证：`npm run typecheck -w @douyin/web` 与 `npm run build -w @douyin/web` 通过，并在浏览器中用一次真实运行的数据走查该面板（含至少一个未入库达人）。

## 4. 达人库分区轴切换（web + domain，阶段 B）

- [ ] 4.1 确认 `packages/domain/src/candidates/candidate-library.ts` 的默认谓词 `candidates.hard_filter_status <> 'fail'`（:296-298）**保持不变**，并在该处加一行注释说明该列现表示「入库资格（创建时判定）」。验证：`npm run test:mysql` 中 `candidate-library.integration.test.ts` 全绿。
- [ ] 4.2 在 `candidate-library.integration.test.ts` 补存量数据隔离用例：历史 `fail` 行在默认列表不可见、历史 `unknown` 行在默认列表可见但不再被任何前端分区消费、`hardFilterStatus` 显式过滤仍能取回两者且受同一记录级可见范围约束。验证：`npm run test:mysql` 通过。
- [ ] 4.3 将 `apps/web/src/pages/CandidatesPage.tsx` 的 `candidateSection`（:39）由 `'qualified' | 'needs_evidence'` 改为五个 pipeline 分区（待复核 / 待联系 / 跟进中 = contacted + communicating / 已合作 / 不合适 = unsuitable + declined），移除「证据不足」分区及其文案。验证：`npm run typecheck -w @douyin/web` 通过，`grep -rn "needs_evidence\|证据不足" apps/web/src` 无结果。
- [ ] 4.4 从 `CandidatesPage.tsx` 的查询构造（:60）移除 `hardFilterStatus`，并修改 `apps/web/src/lib/date.ts` 的 `candidateMatchesLibraryView`（:27-36）去掉硬筛判断、改为按分区对应的 pipeline 集合匹配。验证：`npm run typecheck -w @douyin/web` 通过，`grep -rn "hardFilterStatus" apps/web/src` 无结果。
- [ ] 4.5 保持 `groupCandidatesByDate`（`apps/web/src/lib/date.ts:39-55`）与日期筛选选项完全不动。验证：`grep -n "Asia/Shanghai" apps/web/src/lib/date.ts` 仍命中，`npm run build -w @douyin/web` 通过，浏览器中确认「今天 / 昨天 / 近 7 天 / 近 30 天 / 自定义」分组与分页行为与改动前一致。
- [ ] 4.6 让 `CandidatesPage.tsx` 的 `submitWorkflowRequest`（:367-397）在成功后刷新数据：重新拉取该达人详情（`openCandidate`）并重新加载当前分区列表（给 :73-101 的 `useEffect` 加一个刷新令牌依赖）。**为什么必须做**：复核现在会在同一次请求内推进阶段并递增版本，而当前实现提交后不重新拉取，详情面板会同时显示过期的阶段与过期的 `candidateVersion`，运营紧接着的第二次操作必然 409。验证：`npm run typecheck -w @douyin/web` 通过，浏览器中提交复核后面板阶段与列表分区立即更新，且无需手动刷新即可连续操作。
- [ ] 4.7 浏览器走查五个分区：新建一次采集运行后确认只有 pass 达人出现在「待复核」，点击复核通过该达人自动出现在「待联系」，点击不通过则出现在「不合适」，且工作台三个计数器与达人库分区数字一致。验证：走查记录写入本 change 的实施备注，截图不入仓。

## 5. 孤儿截图回收（worker + domain，阶段 C，开关默认关闭）

- [ ] 5.1 新增两个配置项：孤儿回收启用开关（默认关闭）与宽限期天数（默认 7），与既有 `MEDIA_RETENTION_DAYS`、`MEDIA_CLEANUP_BATCH_SIZE` 同一加载与校验风格。验证：`packages/domain/src/config.test.ts` 补默认值与非法值用例，`npm run test -w @douyin/domain` 通过。
- [ ] 5.2 在 `infra/production` 的 compose / env 模板中补这两个变量的占位符，并在 `scripts/preflight-production.mjs` 中登记，确保缺省时不报错、显式关闭时不执行回收。验证：`node scripts/preflight-production.mjs` 不因新变量失败，且模板中不含任何真实秘密值。
- [ ] 5.3 在 `packages/domain/src/media/media-cleanup.ts` 的 `cleanupMediaObjects`（:28-92）新增孤儿回收路径：目标为 `status = 'confirmed'` 且其 `creator_observation_id` 找不到对应 `campaign_candidates` 行、且确认时间早于宽限期的对象；复用既有两阶段删除（claim → `expired` → `deleteObject` → `deleted`，:104-123），`media_objects` 行永不物理删除。验证：新增 `media-cleanup.integration.test.ts`，覆盖超期孤儿被删、未超期保留、有候选行保留、中断后重跑不重复删除、行未被物理删除五个用例，`npm run test:mysql` 通过。
- [ ] 5.4 在同一测试文件断言孤儿回收路径与既有「已归档任务 + 超保留期」路径（:58-80）互不干扰：同一对象不会被两条路径重复 claim，开关关闭时两条既有行为完全不变。验证：`npm run test:mysql` 通过。
- [ ] 5.5 用 `EXPLAIN` 确认回收查询走 `media_objects.creator_observation_id` 与 `campaign_candidates.creator_id` 上的索引且受批大小上限约束；若缺索引，追加一个向前的 expand 迁移（不修改任何已执行过的迁移文件）。验证：`EXPLAIN` 输出记录在实施备注中，`packages/domain/src/database/query-plans.integration.test.ts` 全绿，`npm run test:mysql` 通过。
- [ ] 5.6 在 `apps/worker/src/index.ts` 接入该回收任务，沿用既有轮询与错误记录方式，失败不阻塞其他后台任务。验证：`npm run typecheck -w @douyin/worker` 与 `npm run build -w @douyin/worker` 通过，本地以开关开启运行一轮并确认日志记录回收数量且不含对象存储永久地址。

## 6. 采集器一行改动（阶段 D，搭车发布）

- [ ] 6.1 将 `apps/collector/src/runtime.ts:506-511` 的截图条件由 `filter.outcome === 'fail'` 改为 `filter.outcome !== 'pass'`，并确认 `flushPending`（:657-692）的上传调用与 `media-upload.ts` 的抛错行为均无需改动。验证：`npm run typecheck -w @douyin/collector` 通过，`git diff --stat packages/contracts apps/collector/package.json` 为空，`grep -n "COLLECTOR_MIN_VERSION\|COLLECTOR_PROTOCOL_VERSION" -r apps packages` 无本次改动。
- [ ] 6.2 在 `apps/collector/src/profile-inspection.test.ts` 或就近测试中补断言：pass 生成截图、fail 与 unknown 均不生成截图、三种结论的结构化观测都照常入队。验证：`npm run test -w @douyin/collector` 通过。
- [ ] 6.3 不为这一行单独发版：确认服务端阶段 A-C 上线期间 v0.1.5 采集器完全可用，unknown 的多余截图由第 5 组回收；把该行改动排入下一次自然发包。验证：`artifacts/` 下不产生新的采集器包，`apps/collector/package.json` 版本号未变。

## 7. 文档同步

- [ ] 7.1 更新 `docs/product-manual.md` 与 `docs/operations/operator-guide.md`：说明「证据不足」分区已取消及原因、达人库改为五个跟进阶段分区、人工复核通过后自动进入「待联系」、不通过自动进入「不合适」、以及未入库达人如何在运行详情中查看判定依据。验证：文档中的界面名称与 `apps/web/src/constants.ts` 的标签常量逐一对应，命令示例可完整复制且不含真实密码、Secret、Cookie、令牌或私钥。
- [ ] 7.2 更新 `docs/operations/admin-guide.md`：说明 `hardFilterStatus` 服务端过滤仍可用但默认界面无入口、孤儿回收开关与宽限期天数的含义、以及回收是唯一不可逆操作因此默认关闭。验证：新增变量名与 5.1/5.2 的实现完全一致。
- [ ] 7.3 更新 `README.md` 中涉及达人库分区或复核流程的描述（如有）。验证：`grep -n "证据不足\|待补证据" README.md docs` 无遗留旧说法。

## 8. 全量验证与分阶段上线

- [ ] 8.1 运行 `npm run check`，确认 format、lint、typecheck、单测与构建全绿。验证：命令退出码为 0。
- [ ] 8.2 运行 `npm run test:mysql` 与 `npm run test:e2e`，确认集成与端到端全绿。验证：两条命令退出码为 0（需本机 Docker 与 Chrome）。
- [ ] 8.3 运行 `openspec validate "tighten-review-funnel" --strict`，确认实施后 delta specs 仍与实现一致。验证：输出 `Change 'tighten-review-funnel' is valid`。
- [ ] 8.4 按 design.md 的 Migration Plan 依次上线阶段 A（api + worker 镜像）与阶段 B（web 镜像），沿用本地构建 + `docker save` tar 侧载流程与 `YYYYMMDD-N` 标签，切换前保留 `.previous-images.env` 与 infra 备份。验证：`/health/ready` 返回健康，阶段 A 后观察一次真实运行的候选行创建量符合预期。
- [ ] 8.5 观察期结束（确认候选行创建正常、复核流转正常、无运营反馈数据缺失）后再显式开启阶段 C 的孤儿回收开关，以 7 天宽限期运行一轮并核对回收数量。验证：回收日志中的对象数量与预期一致，且 `media_objects` 表行数未减少（仅状态变化）。
- [ ] 8.6 全过程不提高 `COLLECTOR_MIN_VERSION`。验证：上线后 v0.1.5 采集器可正常 claim 运行、同步批次与上传截图，无任何升级提示。
