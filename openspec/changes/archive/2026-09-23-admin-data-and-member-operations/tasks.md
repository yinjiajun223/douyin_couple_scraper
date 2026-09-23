## 1. 数据库迁移

- [x] 1.1 新增一个向前的 expand 迁移，给 `invitations` 增加可空的撤销时间列，并在 `packages/domain/src/database/` 的迁移清单中按既有顺序登记。不修改任何已执行过的迁移文件。验证：`npm run db:migrate` 在本地 MySQL 上成功，重复执行不报错，`SHOW CREATE TABLE invitations` 含新列且原有列与约束未变。
- [x] 1.2 在 `packages/domain/src/database/access-schema.integration.test.ts` 补该列的 schema 断言，并确认迁移可幂等重跑。验证：`npm run test:mysql` 通过。
- [x] 1.3 确认 `audit_events.action` 与 `candidate_events.event_type` 均无 CHECK 约束，因此新增取值不需要 DDL。验证：`grep -n "chk_audit\|chk_candidate_events" packages/domain/migrations/*.sql` 无命中（退出码 1），结论记录在实施备注中。实施备注：迁移为 `0015_invitation_revocation.sql`，仅 `ADD COLUMN revoked_at TIMESTAMP(3) NULL`；迁移清单是目录扫描（`migrations.ts:58-75`），文件名即登记。

## 2. 归档领域能力（domain）

- [x] 2.1 在 `packages/domain/src/candidates/candidate-library.ts` 的默认查询加上 `candidates.archived_at IS NULL`，并在该处注明这是与 `operations-dashboard.ts:37,42,48` 对齐的既有过滤。此改动在当前生产数据下不改变任何结果（该列从未被写入）。验证：`candidate-library.integration.test.ts` 全绿，`npm run test:mysql` 通过。
- [x] 2.2 在 `packages/domain/src/candidates/candidate-library.ts` 新增「已归档」视图查询，复用 `resolveCandidateScope`（`candidate-access.ts:23`）与 `candidateVisibilityPredicate` 施加同一记录级可见范围，并复用既有日期分组与服务端分页。验证：集成测试断言运营人员只能看到自己可见范围内的已归档候选，越权返回与不存在一致。
- [x] 2.3 在 `packages/domain/src/candidates/candidate-workflow.ts` 新增 `archiveCandidate` / `unarchiveCandidate`：行级访问校验 → `assertCandidateVersion`（:490-494）→ 写入或清除 `archived_at` → `appendCandidateEvent('archived' | 'unarchived')`（备注可空）→ 写审计 → `version` 递增一次，全部在同一事务内。验证：集成测试覆盖归档、恢复、版本冲突、越权四类，`npm run test:mysql` 通过。
- [x] 2.4 在 `candidate-workflow.integration.test.ts` 断言归档**不阻断**后续采集更新：归档行在新一轮入库中 `latest_creator_observation_id` 与 `latest_run_id` 被更新、`archived_at` 保持不变（不自动取消归档）。验证：`npm run test:mysql` 通过。
- [x] 2.5 断言归档候选的私有素材既不被 `tighten-review-funnel` 的孤儿回收路径误删（候选行仍存在），也不因归档而绕过素材签名访问的记录级校验。验证：`npm run test:mysql` 中媒体清理与素材访问相关集成测试均含该用例并通过。实施备注：2.1/2.2 合并为 `listCandidatePage` 的 `archiveView` 谓词翻转（默认 `active`），复用 `resolveCandidateScope` 与既有日期分组、游标分页；2.4 的用例落在 `collector-ingestion.integration.test.ts`（归档行在新一轮入库中 `latest_run_id`/`latest_creator_observation_id` 前进、`archived_at` 不变、版本 1→2→3）；2.5 拆成 `media-cleanup.integration.test.ts`（归档候选的 confirmed 素材 400 天仍不回收）与 `candidate-access.integration.test.ts`（归档后签名地址的成员范围结论不变）两处。`archiveCandidate`/`unarchiveCandidate` 已从 `packages/domain/src/index.ts` 导出供 API 使用。

## 3. 标签写入（domain）

- [x] 3.1 在 `packages/domain/src/candidates/` 新增标签写入领域函数：按名 upsert `tags`（用 `INSERT ... ON DUPLICATE KEY UPDATE id = id` 后重新 SELECT，不做「先查后插」以避免 `uq_tags_workspace_name` 并发冲突）→ 建立或解除 `candidate_tags` 关联 → `appendCandidateEvent('tags_changed')` → 写审计。验证：新增集成测试覆盖添加、移除、并发同名创建、移除不影响其他候选上的同名标签，`npm run test:mysql` 通过。
- [x] 3.2 确认标签写入后既有筛选路径（`candidate-library.ts:311-324` 的 `tagNames` 子查询）可直接命中，无需新增索引。验证：`EXPLAIN` 走 `idx_candidate_tags_tag`，输出记录在实施备注中。实施备注（3.1-3.3）：领域函数为 `candidate-workflow.ts` 的 `setCandidateTags`（整组标签替换语义，返回 `{ id, tags }`），复用 `lockCandidate` 的行级可见范围、`appendCandidateEvent('tags_changed')` 与审计 `candidate.tags_changed`；只读成员由 `assertPermission(actorRole, 'candidate:write')` 在领域层直接拒绝。**不递增 `campaign_candidates.version`**，否则正在填写的复核/跟进表单会撞上版本冲突。upsert 后的回读必须用 `FOR SHARE`（当前读），并发同名创建时快照读看不到对方刚提交的行，会拿到 `undefined` 绑定参数。3.2 的实测结论：子查询的 `possible_keys` 含 `idx_candidate_tags_tag`，当前小数据量下优化器选覆盖索引 `fk_candidate_tags_candidate`（`Using index`，无回表），两者都是索引访问、无全表扫描，因此无需新增索引。
- [x] 3.3 对标签写入施加与候选写操作一致的行级可见范围校验，只读成员拒绝。验证：集成测试断言越权与非授权角色均被拒绝且不改变任何关联。

## 4. 批量操作（domain + api）

- [x] 4.1 在 domain 新增批量入口，接收显式 ID 数组（上限 100，超限抛错）并**顺序**遍历，每个 ID 复用既有单条领域函数（各自开自己的事务），收集 `{ id, ok, code?, message? }` 后一次性返回。禁止并发调用以避免 `pool.getConnection()` 耗尽连接池。验证：单元测试断言上限校验、顺序执行与逐项结果结构。
- [x] 4.2 批量人工复核必须与单条 `submitManualReview` 语义完全一致，包括 `tighten-review-funnel` 引入的「仅从 `pending_review` 自动推进阶段、单次版本递增」。验证：集成测试断言批量通过 N 个待复核候选后各自进入 `to_contact`、`version` 各 +1、审计与事件各 N 条。
- [x] 4.3 部分成功语义：构造一个含版本过期目标和一个越权目标的批量请求。验证：集成测试断言其余目标成功、失败目标返回原因、无聚合式回滚，且失败目标的数据完全未变。
- [x] 4.4 在 `apps/api/src/server.ts` 新增批量复核与批量归档路由，权限 `candidate:write`、CSRF 必填、请求体经 zod 校验且拒绝超限。验证：`apps/api/src/authorization.integration.test.ts` 补三类断言（operator 可用、readonly 拒绝、缺 CSRF 拒绝），`npm run test:mysql` 通过。
- [x] 4.5 在 `apps/api/src/server.ts` 新增标签写入路由（`PUT /candidates/:id/tags`），权限 `candidate:write`、CSRF 必填、请求体经 zod 校验（标签名 1-100 字、最多 20 个），转调 `setCandidateTags`。原任务清单遗漏了这条路由，但 8.1 的网页标签编辑与 `specs/creator-candidate-library` 的「候选标签维护」都依赖它。验证：`authorization.integration.test.ts` 断言 operator 可用、readonly 拒绝、缺 CSRF 拒绝，`npm run test:mysql` 通过。
- [x] 4.6 记录 100 条批量复核的实测耗时，确认未超出网关超时；若超出则下调上限而不是改为并发。验证：实测数值与最终上限写入实施备注。实施备注（4.1-4.6）：批量入口为 `packages/domain/src/candidates/candidate-batch.ts` 的 `batchSubmitManualReview` / `batchArchiveCandidates`，顺序 `await`（不用 `Promise.all`，避免一次性占满连接池），逐项复用单条领域函数、各自一个事务，返回 `{ results, succeeded, failed }`；同一批次重复 ID 在校验阶段就拒绝（否则第二次只会表现为版本冲突，误导成并发修改）。上限 100 条实测：本地 Docker MySQL 三次分别 932 / 911 / 655 ms（约 6.5-9.3 ms/条），生产 RDS 同地域按每条 7 次往返、每次 +1 ms 估算约 1.6 s，网关 `infra/production/proxy_params` 为 `proxy_read_timeout 60s`，余量充足，**上限保持 100 不下调**。路由：`POST /candidates/batch-reviews`、`POST /candidates/batch-archive`（形状错误如超限/重复 ID 返回 400 `INVALID_BATCH_REQUEST`，逐项失败走 200 + `results`）、`PUT /candidates/:candidateId/tags`，权限均为 `candidate:write` 且强制 CSRF；`handleCandidateWorkflowError` 增加 `PermissionDeniedError` → 403 映射。

- [x] 4.7 在 `apps/api/src/server.ts` 新增单条归档 / 恢复路由（`POST /candidates/:candidateId/archive` 与 `/unarchive`），权限 `candidate:write`、CSRF 必填，请求体含 `expectedVersion` 与可选 `note`。原任务清单只写了批量归档路由，但 8.2 的「归档 / 恢复入口」在详情页与列表行内都要用到单条路由，因此补上。验证：`authorization.integration.test.ts` 断言缺 CSRF 拒绝、只读拒绝、运营可用且版本冲突返回 409 语义（批量里表现为 `VERSION_CONFLICT` 项）。

## 5. 成员生命周期（domain + api）

- [x] 5.1 修正 `disableUserAccount`（`sessions.ts:195-238`）的签名与审计 actor，写入执行操作的管理员而非被停用者（当前 :224 写的是 `userId`）。该函数从未被路由调用，无历史数据需要兼容。验证：集成测试断言 `audit_events.actor_user_id` 为管理员 ID，`npm run test:mysql` 通过。
- [x] 5.2 新增护栏函数，在同一事务内 `SELECT ... FOR UPDATE` 锁定目标 membership 行后统计该工作区 `role='admin' AND users.status='active'` 的人数：目标为最后一名 admin 时拒绝停用与降级；`actorUserId === targetUserId` 时拒绝停用。验证：集成测试覆盖自我停用、停用最后 admin、降级最后 admin、两名管理员并发互相降级（串行化后第二次失败），`npm run test:mysql` 通过。
- [x] 5.3 新增 `enableUserAccount`：置 `users.status='active'`、写 `account.enabled` 审计，**不**触碰 `devices.status`。验证：集成测试断言启用后可登录、其名下设备仍为 `revoked` 且设备令牌调用被拒绝。
- [x] 5.4 新增角色变更领域函数：更新 `memberships.role`、写 `account.role_changed` 审计、施加最后管理员护栏。验证：集成测试断言变更即时生效——目标成员**持既有会话**发起写请求时按新角色判定权限（确认 `sessions.ts:127-162` 是每请求解析角色，不依赖重新登录）。
- [x] 5.5 在 `apps/api/src/server.ts` 新增停用 / 启用 / 改角色路由，权限 `members:manage`、CSRF 必填。验证：`authorization.integration.test.ts` 断言 operator 与 readonly 均被拒绝、管理员成功、护栏触发时返回可理解原因且无任何部分生效变更。实施备注（5.1-5.5）：新模块 `packages/domain/src/auth/members.ts`（`disableUserAccount` 从 `sessions.ts` 迁出，签名改为 `{ actorUserId, targetUserId, workspaceId }`，审计 actor 写执行者，summary 改为本次实际撤销的会话数与设备数）。护栏加锁顺序为**先工作区范围加锁计数、后目标行**，三个操作（停用 / 启用 / 改角色）统一走这一顺序：只锁目标行挡不住两名管理员并发互相降级，而顺序不统一会死锁（范围锁的 `JOIN users` 也锁 users 行）——design.md D5 已按实现修正。集成测试用 `Promise.allSettled` 断言并发互相降级恰好一个成功、另一个 `LastActiveAdminError`，且工作区仍有 1 名启用管理员。角色即时生效由 api 测试断言：同一条会话不重新登录，改角色后写请求从 403 变 404。路由 `POST /members/:userId/disable`、`POST /members/:userId/enable`、`PUT /members/:userId/role`，错误映射 404 `MEMBER_NOT_FOUND` / 409 `LAST_ACTIVE_ADMIN`（带中文 message）/ 409 `SELF_DISABLE_NOT_ALLOWED` / 400 `INVALID_MEMBER_REQUEST`。

## 6. 邀请管理（domain + api）

- [x] 6.1 在 `packages/domain/src/auth/invitations.ts` 新增 `listPendingInvitations`：返回邮箱、角色、发出时间、过期时间、发出者，**MUST NOT** 返回 `token_hash` 或任何令牌材料。验证：集成测试断言响应对象不含令牌字段，`npm run test:mysql` 通过。
- [x] 6.2 新增 `revokeInvitation`：写入撤销时间、写 `account.invitation_revoked` 审计；已接受或已撤销的邀请拒绝再次撤销。验证：集成测试覆盖三种状态。
- [x] 6.3 在 `acceptInvitation`（:118）增加撤销校验，抛新的 `InvitationRevokedError`，并在 `server.ts` 的 `POST /auth/invitations/accept` 映射为 HTTP 410 + `INVITATION_REVOKED`（与既有 `InvitationExpiredError` → 410 `INVITATION_EXPIRED` 同风格但可区分）。验证：集成测试断言已撤销邀请无法创建成员记录，且响应码与错误码正确。
- [x] 6.4 在 `apps/api/src/server.ts` 新增邀请列表与撤销路由，权限 `members:manage`，撤销要求 CSRF。验证：`authorization.integration.test.ts` 断言非管理员被拒绝。实施备注（6.1-6.4）：`listPendingInvitations` 的 SELECT 里根本没有 `token_hash`，返回 `id / email / role / invitedAt / expiresAt / invitedByDisplayName`；测试断言响应 JSON 既不含令牌明文也不含其 sha256，且键集合固定。`revokeInvitation` 先 `FOR UPDATE` 锁行，已接受 → `InvitationAlreadyUsedError`、已撤销 → `InvitationRevokedError`、不存在或跨工作区 → `InvitationNotFoundError`，写 `account.invitation_revoked` 审计（summary 含 email/role）并保留原始 `expires_at`，使审计能区分自然过期与主动撤销。`acceptInvitation` 的撤销判定放在过期判定之前（原因更有用），映射为 410 `INVITATION_REVOKED`；api 测试断言 410 且未创建任何 users/memberships 行。路由 `GET /invitations`（`members:manage`）与 `POST /invitations/:invitationId/revoke`（`members:manage` + CSRF，重复撤销 409）。

## 7. 审计类型扩展

- [x] 7.1 在 `packages/domain/src/audit/audit-events.ts` 的 `AuditAction` 联合类型（:7-21）补 `candidate.archived`、`candidate.unarchived`、`candidate.tags_changed`、`account.role_changed`、`account.enabled`、`account.invitation_revoked`。验证：`npm run typecheck` 通过，`packages/domain/src/audit/audit-events.integration.test.ts` 全绿，无需迁移（见 1.3）。
- [x] 7.2 确认审计页能正确展示新增 action 的中文标签，缺失标签时不得回退为显示原始英文键或空白。验证：`apps/web/src/pages/AuditPage.tsx` 的标签映射覆盖全部新 action，`npm run typecheck -w @douyin/web` 通过。实施备注（7.1-7.2）：六个新 action 已在 `AuditAction` 联合类型中（无 CHECK 约束，见 1.3）。标签映射放在 `apps/web/src/constants.ts`，类型为 `Record<AuditAction, string>`——web 侧在 `types.ts` 单独声明同一个联合（不能依赖服务端领域包），因此新增动作漏配标签会直接编译不过。审计对象另有 `auditSubjectLabels`。界面永远显示中文，未收录取值走「其他操作 / 其他对象」兜底，原始英文键只放进 `title` 供排查复制；`tests/web-access.e2e.spec.ts` 新增用例断言六个新动作的中文标签、兜底文案，以及英文键不作为可见文本出现（22 个用例全绿）。

## 8. 前端

- [x] 8.1 在 `apps/web/src/types.ts` 补类型，在各页面沿用既有写法直接 `fetch` + `readResponse`（仓库没有 `src/lib/api.ts` 这样的集中封装层，不要新建）：归档 / 恢复、批量复核、批量归档、标签写入、成员停用 / 启用 / 改角色、邀请列表 / 撤销。`readResponse`（`src/api/client.ts`）目前把所有非 401 错误压成同一句文案，需让调用方能区分护栏拒绝、版本冲突与批量部分失败。验证：`npm run typecheck -w @douyin/web` 通过。实施备注：`readResponse` 改为抛 `ApiError`（含 status/body/code），新增 `describeApiError(status, body)` 把已知错误码映射成中文（`LAST_ACTIVE_ADMIN`、`SELF_DISABLE_NOT_ALLOWED`、`INVALID_PIPELINE_TRANSITION` 直接显示服务端 message；批量部分失败不走错误通道，走 200 + `results`）。
- [x] 8.2 在 `apps/web/src/pages/CandidatesPage.tsx` 补多选与批量操作栏（提交期间禁用并显示进度，不做乐观 UI）、归档 / 恢复入口、标签编辑，以及独立的「已归档」视图。批量选择 MUST 只提交用户实际勾选的 ID，不得由服务端展开筛选条件。验证：`npm run build -w @douyin/web` 通过，浏览器走查批量复核 5 条、批量归档 3 条、恢复 1 条、打标签与按标签筛选各一次。实施备注：勾选状态是 `Map<id, version>`，列表不返回版本就只能逐条开详情；切换分区 / 归档视图 / 筛选时勾选收敛到当前列表，避免提交看不见的达人。走查中发现并修掉两个真实缺口：其一，`GET /candidates` 路由从不透传 `archiveView`，「已归档」视图会静默返回在用列表，已在 `apps/api/src/server.ts` 补上（只认精确的 `archived`，其余取值回落在用视图），并在 `authorization.integration.test.ts` 从 HTTP 入口断言；其二，标签检索的服务端能力（`tagNames`）早已存在但界面从未发送，补了筛选栏的「标签」输入框（回车应用、逗号分隔、最多 20 个，与服务端上限一致）。真实浏览器走查落在 `tests/local-flow.e2e.spec.ts` 的新用例「管理员在真实工作区走查批量复核、标签、归档与成员生命周期」（真实 API + MySQL + 浏览器，批量复核 3 条、批量归档 2 条、恢复 1 条、打标签与按标签筛选各一次，截图见 `test-results/.../ops-*.png`）；`tests/web-access.e2e.spec.ts` 另有用例断言只提交勾选 ID 与部分失败归并文案（28 个用例全绿）。
- [x] 8.3 在 `apps/web/src/pages/MembersPage.tsx` 补角色变更、停用 / 启用、邀请列表与撤销，并在护栏触发时呈现禁用态与说明文案（不能停用自己、不能停用或降级最后一名管理员）。停用与降级需二次确认。验证：浏览器走查四种护栏态的文案与禁用表现，并确认非管理员看不到这些操作。实施备注：护栏拆成两条——停用挡「不能停用自己」，降级挡「不能撤掉最后一名启用管理员」；同一个人同时命中时合并成一句（「不能停用或降级当前登录的自己：…」），避免读两遍近似文案。服务端 409（并发场景）的原因经 `describeApiError` 就地显示在列表旁。非管理员看不到入口由 `tests/web-access.e2e.spec.ts` 的角色矩阵用例覆盖；四种护栏态与二次确认在真实工作区走查（同上 local-flow 用例，含唯一管理员工作区的禁用态）。
- [x] 8.4 确认 `GET /members/assignable`（`server.ts:646-655`）已过滤 `status === 'active'`，因此被停用成员不会出现在归属人下拉中。验证：浏览器走查归属人下拉不含已停用成员。实施备注：路由现为 `server.ts:701-710`，服务端过滤确认无误；达人库的「运营成员」筛选另在客户端按 `status === 'active'` 过滤。真实走查在停用成员后分别打开两个下拉，断言已停用成员不在其中；启用后设备仍保持已撤销。

## 9. 筛选任务与模板界面（仅 web，后端零改动）

- [x] 9.1 在 `apps/web/src/types.ts` 给 `CampaignSummary` 补 `rules`（与 `createCampaignSchema` 的 schemaVersion 2 结构一致）与 `source_template_id`，给 `CampaignTemplateSummary` 补 `rules`；修改 `OperationsDesk.tsx:74-79` 使 `GET /campaigns` 已返回的 `rules_json` 不再被丢弃。**不改** `packages/domain`、`apps/api`、`packages/contracts`。验证：`npm run typecheck` 通过，`git diff --stat packages apps/api apps/collector` 对本组为空。
- [x] 9.2 把 `CampaignsPage.tsx` 的新建表单改为新建 / 编辑共用：编辑时用该任务的 `rules` 预填全部字段（移除硬编码 `defaultValue`），提交走 `PATCH /campaigns/:id` 并带 `expectedVersion`；新建仍走 `POST /campaigns`。验证：浏览器走查——编辑一个已有任务，表单显示的是它当前的粉丝范围与点赞门槛而不是默认值，保存后卡片版本号 +1。
- [x] 9.3 处理 409：提交处直接判 `response.status === 409`，提示「该任务已被他人修改，请刷新后重试」，重新拉取 `/campaigns` 后再允许提交，**不做自动合并**。验证：浏览器走查——两个标签页同时编辑同一任务，后提交者看到该提示且其修改未被静默覆盖。
- [x] 9.4 给任务卡片补「编辑」「复制」「归档」入口：复制调 `POST /campaigns/:id/copy`（要求输入新名称，≥2 字），归档调 `POST /campaigns/:id/archive` 且需二次确认；已归档卡片只保留「复制」，不再显示「创建运行」。归档为软操作且当前无恢复路由，确认文案 MUST NOT 声称可以恢复。验证：浏览器走查编辑、复制、归档各一次，归档后卡片状态变为「已归档」且不可创建运行。
- [x] 9.5 新建任务表单增加「从模板预填」：优先发送 `templateId`（让服务端展开规则并记录 `source_template_id`），而不是前端把模板规则拷进表单。`GET /campaign-templates` 是 `workspace:manage`，运营会 403，因此模板列表只由 `OperationsDesk` 在管理员会话里随工作区一起拉取（运营会话直接得到空列表），不额外发出注定 403 的请求；无模板时静默隐藏下拉并回落到手填规则，不报错、不阻断提交。验证：以 admin 走查从模板创建（`source_template_id` 被记录），以 operator 走查新建任务仍可用且看不到模板下拉、控制台无未处理错误。
- [x] 9.6 编辑保存成功后明确提示「规则快照已在每次运行开始时冻结，本次修改只影响新的运行」，避免运营误以为改条件会改变历史结论。验证：浏览器走查该提示出现，措辞与主 specs `screening-campaigns` 的「运行规则快照」一致。
- [x] 9.7 给 `TemplatesPage.tsx` 补新建 / 编辑 / 归档（页面本身只由 `OperationsDesk` 在 `canManageMembers` 时渲染，因此无需再传「是否管理员」prop，只需新增 `csrfToken` 与 `onChanged`；路由权限仍为 `workspace:manage`）：新建与编辑复用与任务相同的规则字段，编辑带 `expectedVersion` 并处理 409，归档需二次确认。验证：浏览器走查新建模板、编辑模板、归档模板各一次，归档后该模板从 `GET /campaign-templates` 消失（服务端已过滤 `archived_at IS NULL`）。

## 10. 采集设备列表可见性

- [x] 10.1 在 `packages/domain/src/auth/directory.ts` 的 `listWorkspaceDevices`（:45）SELECT 补 `devices.revoked_at`（列已存在于 `0001_access.sql:90`，且已由 `devices.ts:264` 与 `sessions.ts:219` 写入），映射中返回 `revokedAt`。不新增查询参数、不改路由、不改权限。验证：`npm run test:mysql` 通过；集成测试断言主动撤销与停用级联两种路径下 `revokedAt` 均非空，且响应不含 `token_hash`。
- [x] 10.2 在 `apps/web/src/pages/DevicesPage.tsx` 默认只渲染 `status === 'active'` 的设备，并提供「显示已撤销」开关；展开后已撤销行以只读形式显示撤销时间，**不**提供恢复、改名或删除入口。验证：浏览器走查——默认列表不含已撤销设备，打开开关后出现且无操作按钮，运营只能看到自己名下的设备。
- [x] 10.3 撤销成功后把该设备从默认列表移除（无需刷新），并在开关旁说明「已撤销设备保留为历史，无法删除，成员需在本机重新配对」。验证：浏览器走查撤销一台设备后它立即从默认列表消失，开关展开仍可见。

## 11. 文档同步

- [x] 11.1 更新 `docs/product-manual.md` 与 `docs/operations/operator-guide.md`：归档与恢复流程、「已归档」视图、批量复核与批量归档的操作方式与上限、标签的添加与筛选、筛选任务的编辑 / 复制 / 归档与「改条件只影响新运行」、以及「删除只能是软归档、采集事实字段不可编辑」的边界说明。验证：文档中的界面名称与 `apps/web/src/constants.ts` 的标签常量逐一对应，命令示例可完整复制且不含真实密码、Secret、Cookie、令牌或私钥。实施备注：product-manual 新增 5 节「编辑、复制与归档」「从模板新建（管理员）」与 8.4/8.5/8.6（批量、标签、归档与恢复），10 节补成员生命周期与已撤销设备；operator-guide 在 2、4、5 节补同一套操作的运营视角与新的异常文案；界面名称逐一对照 `candidateSections`、批量操作栏、归档开关、标签编辑与模板页按钮文案。
- [x] 11.2 更新 `docs/operations/admin-guide.md`：成员停用 / 启用 / 改角色的效果与级联范围（停用会撤销全部会话与设备、启用不恢复设备）、邀请撤销、最后管理员护栏、护栏导致无法操作时用 `bootstrap-admin` CLI 救援的完整步骤、筛选模板的维护职责（新建 / 编辑 / 归档，仅管理员）、以及已撤销设备的默认隐藏与历史查看方式。明确写出「停用是账户级而非工作区级」。验证：救援步骤中的命令可完整复制，`npm run bootstrap-admin -w @douyin/domain` 的调用形式与实际脚本一致。实施备注：核对 `packages/domain/src/auth/bootstrap-admin-cli.ts` 后修正了旧文档的两处错误说法——该 CLI 从环境变量读取输入（没有交互提示），且只能创建首位管理员：工作区已有管理员成员记录时同邮箱返回 `already_initialized`、换邮箱直接报错，因此「唯一管理员被停用或丢密码」不能靠它救援。文档据此给出两条路径：无管理员记录时用 `docker compose ... --profile tools run --rm -e BOOTSTRAP_ADMIN_* migrate node packages/domain/dist/auth/bootstrap-admin-cli.js`（与 `scripts/deploy-production.sh:24` 的调用形式一致）；记录仍在时执行一次性、留痕的 `UPDATE users` 修复，并写明先备份目标行、事后记录执行人与原因。
- [x] 11.3 更新 `docs/collector-windows.md` 与 `docs/collector-macos.md` 中关于设备撤销的描述（如有）：说明服务端已撤销设备在网页端默认隐藏、无法删除，重新配对需在本机进行。验证：`grep -rn "已撤销" docs` 的说法与实现一致。实施备注：两篇原文都没有设备撤销章节，各补一节「设备被撤销」，说法与 `DevicesPage` 的只读历史、`disableUserAccount` 的级联撤销一致。
- [x] 11.4 更新 `README.md` 中涉及成员管理、筛选任务或候选操作的描述（如有）。验证：`grep -n "只能邀请\|无法停用\|只能新建" README.md docs` 无遗留旧说法。实施备注：README 没有需要修改的旧说法（成员与候选操作都指向 product-manual / admin-guide），grep 校验退出码 1（无命中）；product-manual 15 节上线验收补了批量 / 标签 / 归档 / 成员停用启用四个走查项。

## 12. 全量验证与上线

- [x] 12.1 运行 `npm run check`，确认 format、lint、typecheck、单测与构建全绿。验证：命令退出码为 0。实施备注：2026-09-23 在组 8/11 提交后运行，format:check、lint、typecheck、各工作区单测与五个包的构建全部通过（web 产物 314.10 kB / gzip 95.70 kB）。
- [x] 12.2 运行 `npm run test:mysql` 与 `npm run test:e2e`。验证：两条命令退出码为 0（需本机 Docker 与 Chrome）。实施备注：2026-09-23 终态运行——domain 集成 21 文件 83 用例、api 集成 8 文件 21 用例、local-flow 真实栈 2 用例全绿；`test:e2e` 34 通过 2 跳过（local-flow 在无 `MYSQL_TEST_URL` 时按设计跳过）。
- [x] 12.3 运行 `openspec validate "admin-data-and-member-operations" --strict`。验证：输出 `Change 'admin-data-and-member-operations' is valid`。实施备注：2026-09-23 组 8/11 打勾后运行，输出与预期一致。
- [x] 12.4 确认 `tighten-review-funnel` 的服务端部分已上线，再按 design.md 的 Migration Plan 依次执行迁移 → api 镜像 → web 镜像，沿用本地构建 + `docker save` tar 侧载流程与 `YYYYMMDD-N` 标签，切换前保留 `.previous-images.env` 与 infra 备份。验证：`/health/ready` 返回健康，迁移账号与业务账号未混用。验收记录（2026-09-23）：用户确认迁移、账号隔离与上线流程已验证；`20260923-1` 已包含本变更，后续 `20260923-2` 仍包含该代码，切换后 readiness 为 `ok`。
- [x] 12.5 上线后在真实工作区完成一次端到端走查：邀请 → 撤销 → 重新邀请 → 接受 → 改为只读 → 停用 → 启用 → 重新配对设备；对若干候选执行批量复核、打标签、归档、恢复；编辑一个筛选任务并确认旧运行的规则快照未变；新建并归档一个模板；撤销一台设备并确认它从默认列表消失。验证：每步的审计记录都出现在审计页且 actor 为执行操作的管理员。验收记录（2026-09-23）：用户确认上述真实工作区流程与审计 actor 已逐项验证。
- [x] 12.6 确认本次未触碰 `packages/contracts`、采集器行为与 `COLLECTOR_MIN_VERSION`。验证：`git diff --stat packages/contracts apps/collector` 为空，v0.1.5 采集器仍可正常 claim 运行与同步。验收记录（2026-09-23）：用户确认边界对比与 v0.1.5 claim/同步兼容性已验证。
