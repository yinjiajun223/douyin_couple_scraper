## Context

动机见 proposal.md - Why。这里只记录影响技术选型的现状与约束。

**半成品盘点**（勘查确认）：
- `campaign_candidates.archived_at`（`0004_candidate_decisions.sql:12`）存在且可空，`operations-dashboard.ts:37,42,48` 已在过滤 `archived_at IS NULL`，但**没有任何代码写入它**，`candidate-library.ts` 也**没有**这个过滤 —— dashboard 与达人库对归档的处理本来就不一致。
- `tags` / `candidate_tags`（`0011_candidate_tags.sql`）表结构完整：`uq_tags_workspace_name` 支持按名 upsert，主键 `(candidate_id, tag_id)` 支持按候选读写，`idx_candidate_tags_tag` 支持 `candidate-library.ts:313-321` 已有的按标签筛选。**读路径与筛选参数都已存在，只缺写入。**
- `disableUserAccount`（`sessions.ts:195-238`）已完整实现（`FOR UPDATE` 锁 membership → 置 `users.status='disabled'` → 撤销全部 sessions → 撤销全部 devices → 写 `account.disabled` 审计 → 提交），但**从未挂上任何 HTTP 路由**。其审计写的是 `actorUserId: userId`（:224），即被停用者本人而非执行操作的管理员。
- 没有 `enableUserAccount`。`memberships.role` 在整个代码库中**没有任何 UPDATE**。
- `invitations.ts` 只有 `createInvitation`（:85）与 `acceptInvitation`（:118）；`invitations` 表（`0001_access.sql:40-58`）有 `expires_at` / `accepted_at`，**没有撤销标记列**。
- `directory.ts` 只有两个只读查询（`listWorkspaceMembers` :25、`listWorkspaceDevices` :45）。
- `MembersPage.tsx`（109 行）已展示 `member.status`（'使用中' / '已停用'），即停用状态早已被前端渲染，只是没有任何途径造成它。

**无需 DDL 的部分**（勘查确认，proposal 原先的猜测已被推翻）：
- `audit_events.action` 是 `VARCHAR(100)` 且**无 CHECK 约束**（`0001_access.sql:108`）；`candidate_events.event_type` 同样是 `VARCHAR(100)` 无 CHECK（`0004:152`）。新增取值纯属 `AuditAction` 联合类型扩展。
- `campaign_candidates.pipeline_status` 的 CHECK（`0004:27`）已含全部 7 个值，本次不改流转矩阵。

**权限与路由现状**：`ROLE_PERMISSIONS`（`permissions.ts:16-41`）是硬编码的 11 个权限字符串 × 3 个角色；每个路由单独调用 `authorizeBrowserRequest(pool, request, reply, permission?, requireCsrf=false)`（`server.ts:125-149`），没有 Fastify 鉴权插件或装饰器。全部路由集中在 `apps/api/src/server.ts` 单文件。行级可见范围由 `resolveCandidateScope`（`candidate-access.ts:23`）+ `candidateVisibilityPredicate` 统一施加，`candidate-library.ts:254,426`、`candidate-workflow.ts:467`、`operations-dashboard.ts:29` 均已接入。

**硬约束**：
- `creator_observations`、`post_observations`、`candidate_events`、`audit_events`、`campaign_rule_versions` 有 `BEFORE UPDATE/DELETE ... SIGNAL` 触发器，物理删除在数据库层面不可能。
- AGENTS.md：迁移只向前、不修改已执行迁移、不删生产数据；日志与错误信息必须脱敏。
- `uq_campaign_candidates_campaign_creator (campaign_id, creator_id)`：归档不会释放唯一键，同一达人再次被采集会命中已归档行。

## Goals / Non-Goals

**Goals:**
- 管理员能在界面内完成人员变动的全部动作（停用、启用、改角色、撤销邀请），不再需要直接操作数据库。
- 运营能批量处理复核队列，不必逐条点击。
- 「删除」与「编辑」的边界由规格固定下来，不再反复被问。
- 工作区永远不会因为管理员操作而失去最后一名管理员。

**Non-Goals:**
- 不做物理删除（触发器层面不可能）。
- 不做密码重置（用「停用 + 重新邀请」替代）。
- 不启用 `workspace_roles` 自定义角色表（运行时从不读取，CHECK 只允许三个角色名）。
- 不做工作区 CRUD、设备解吊销 / 改名 / 删除。
- 不拆分 `apps/api/src/server.ts`（见 D9）。
- 不改动入库闸门、复核驱动流转、达人库分区轴 —— 那些属于 `tighten-review-funnel`。

## Decisions

### D1: 归档写入既有 `archived_at` 列，并先补达人库缺失的过滤

`candidate-library.ts` 的默认查询加上 `candidates.archived_at IS NULL`，「已归档」视图取反。归档 / 取消归档写 `archived_at` 与 `candidate_events`（`archived` / `unarchived`）。

**为什么可以先补过滤**：该列从未被写入，因此补上过滤在当前生产数据下**不改变任何查询结果**，可以在归档写入能力上线之前独立发布，先把 dashboard 与达人库的既有不一致修掉。

**为什么不引入新状态**：`pipeline_status` 的 CHECK 已固定 7 个值，加「已归档」需要改约束；而归档是**正交于跟进阶段**的可见性标记 —— 一个已归档的候选仍应保留它归档前所处的阶段，恢复后原地出现。用 `archived_at` 正好表达这一点。

**与 `tighten-review-funnel` 的交互**：该 change 的 D1 规定后续运行仍更新已存在候选行的采集事实指针，归档行同样适用 —— 归档不阻断更新，也**不因新观测自动取消归档**（否则运营刚归档的达人下一轮采集就自己回来了）。

### D2: 批量操作 = 逐条调用单条领域函数 + 顺序执行，不用大事务

批量接口接收显式 ID 数组，服务端顺序遍历，每个 ID 复用既有的单条领域函数（`submitManualReview` / 归档函数），各自开自己的事务，逐个收集 `{ id, ok, code?, message? }`，最后一次性返回。上限 100 个，超限直接 400 拒绝整个请求。

**为什么不用单一大事务**：spec 要求部分成功，大事务只能全成全败。

**为什么必须顺序而非并发**：每个单条领域函数都调用 `pool.getConnection()`，并发 100 个会耗尽连接池并拖垮同实例上的其他请求。100 条顺序执行的耗时对一次人工批量操作可接受。

**为什么上限是 100**：与 `MEDIA_CLEANUP_BATCH_SIZE` 的既有量级一致；也是「一屏多选 + 翻页再选」的自然上限，超过就该用筛选条件缩小范围而不是扩大批量。

**代价**：批量复核 100 条会有可感知的等待。缓解：前端提交期间禁用操作栏并显示进度，不做乐观 UI。

### D3: 批量操作只接受显式 ID，不做「服务端展开当前筛选条件」

前端把当前筛选结果中**用户实际勾选**的 ID 发上来，服务端不接收筛选条件、不自己再查一遍。

**为什么**：服务端展开会在分页场景下作用于用户从未看过的行 —— 运营看到第 1 页点了「全选并归档」，服务端却归档了全部 8 页。这是数据安全问题，不是便利问题。spec 中「批量归档当前筛选结果」的场景由「从当前筛选结果中勾选」满足，逐条访问校验仍然生效。

**代价**：跨页批量需要逐页勾选。可接受，且上限 100 本来就不支持一次性处理大结果集。

### D4: 邀请撤销新增一列，不复用 `expires_at`

向前 expand 迁移：`ALTER TABLE invitations ADD COLUMN revoked_at TIMESTAMP(3) NULL`。`acceptInvitation` 增加撤销校验，抛新的 `InvitationRevokedError`，路由映射为 HTTP 410 + `INVITATION_REVOKED`（与既有 `InvitationExpiredError` → 410 `INVITATION_EXPIRED` 同风格但可区分）。

**为什么不把 `expires_at` 改成当前时间**：那会销毁原始过期时间，使审计无法区分「自然过期」与「管理员主动撤销」，也无法回答「这个邀请原本给了多久」。撤销是一个独立事实，应当有独立列。

**为什么是 expand-only**：不删列、不改类型、不加 NOT NULL，旧版本代码在迁移后仍可正常运行，因此迁移与服务端发布无需严格同步，回滚镜像即可。

**安全**：邀请列表与撤销响应 MUST NOT 返回 `token_hash` 或任何令牌材料；`acceptInvitation` 是唯一的令牌消费路径，且它本来就不经 `authorizeBrowserRequest`（登录前接口）。

### D5: 最后管理员护栏在同一事务内用 `FOR UPDATE` 计数判定

停用与降级共用一个护栏函数，在已开启的事务内：先 `SELECT ... FOR UPDATE` 锁定目标 membership 行，再统计该工作区 `memberships.role='admin' AND users.status='active'` 的人数，若目标当前是 admin 且计数 ≤ 1 则抛错回滚。自我停用护栏独立判定（`actorUserId === targetUserId` 即拒绝）。

**为什么必须加锁**：两名管理员并发互相降级时，无锁的计数检查会双双通过，工作区随后失去全部管理员，只能靠 `bootstrap-admin` CLI 救援。锁住目标行使两次操作串行化。

**为什么护栏覆盖降级而不只覆盖停用**：降级同样移除管理员身份，锁死路径完全一致。

**为什么不自动提升他人**：自动指定管理员是替用户做人事决定，且无法判断该提谁。明确拒绝并说明原因，让管理员先提升别人再操作，是更可控的路径。

**代价**：单管理员工作区无法自我停用或自我降级，必须先邀请并提升第二名管理员。这是刻意的。

### D6: 启用成员不恢复其设备授权

`enableUserAccount` 只把 `users.status` 置回 `'active'` 并写审计，**不**触碰 `devices.status`。被停用期间撤销的设备保持 `revoked`，成员需自行重新配对。

**为什么**：`internal-access-control` 已有明确要求「已撤销的设备令牌调用任一受保护接口 → 系统拒绝请求并保留安全审计记录」。启用时自动复活设备会让这条要求在停用/启用往返中失效，且设备令牌绑定的是运营本机的浏览器画像，管理员无从判断那台机器是否仍在同一人手上。

**代价**：重新启用后成员需要在本机重新配对一次。可接受，且配对流程已存在。

### D7: 修正 `disableUserAccount` 的审计 actor

签名增加执行者标识，审计写操作的管理员而不是被停用者。这是 domain 内部签名变更，不涉及任何跨端契约。

**为什么现在修**：该函数从未被路由调用，因此不存在历史数据需要兼容；一旦挂上路由，错误的 actor 会立刻固化进 append-only 且受触发器保护的 `audit_events`，事后无法修正。

### D8: 不新增权限字符串

归档 / 取消归档 / 标签写入 / 批量复核 / 批量归档 → `candidate:write`；成员停用 / 启用 / 改角色 / 邀请列表与撤销 → `members:manage`；全部新增写路由要求 CSRF（`authorizeBrowserRequest` 第四参传 `true`）。

**为什么**：`ROLE_PERMISSIONS` 是硬编码 record，新增一个字符串要同时改三个角色的列表和所有相关守卫，而收益为零 —— 「能批量做」与「能单条做」不是两种权限。operator 已有 `candidate:write`，因此批量复核自然落在运营手里，这与复核本来就是运营职责一致；归档同样如此。

**代价**：无法只允许某些运营归档而不允许其复核。当前团队规模不需要这种细分；真需要时应走 `workspace_roles` 的独立变更，而不是往静态列表里再加字符串。

### D9: 本次不拆分 `apps/api/src/server.ts`

新增路由沿用文件内既有写法。拆分记为独立后续变更。

**为什么**：拆分是纯重构，会与所有在途变更争抢同一个文件，并使本次 diff 从「新增能力」变成「新增能力 + 全文件位移」，审阅成本与回归风险都放大。仓库近期的 `bc4024a refactor(web): split App.tsx into modules` 正是把拆分作为独立 change 处理的先例。

## Risks / Trade-offs

**[归档后达人的截图被 `tighten-review-funnel` 的孤儿回收误删]** → 不会：孤儿判据是「`media_objects.creator_observation_id` 找不到对应 `campaign_candidates` 行」，归档行仍然存在。两个 change 都实施后需专门加一条断言覆盖这一点（见 tasks）。

**[标签按名 upsert 的并发冲突]** → 两名成员同时创建同名标签会撞 `uq_tags_workspace_name`。用 `INSERT ... ON DUPLICATE KEY UPDATE id = id` 后重新 SELECT，或捕获唯一键冲突后重查，不使用「先查后插」。

**[批量操作耗时导致 HTTP 超时]** → 上限 100 + 顺序执行，实测耗时需记录；若超出网关超时则下调上限而不是改为并发（见 D2）。

**[角色变更对已登录成员的生效时机]** → `sessions.ts:127-162` 在每次请求时从数据库解析角色，因此变更应即时生效且无需撤销会话。这一点必须用测试断言，不能假定（见 tasks）。

**[最后管理员护栏的判定口径]** → 计数只统计 `users.status='active'` 的 admin。若工作区唯一的 admin 已被停用（历史数据或 CLI 操作造成），护栏会阻止对**其他** admin 的降级，可能导致无法操作。此时救援路径是 `bootstrap-admin` CLI，需在管理员手册中写明。

**[停用是全局的而非按工作区]** → `users.status` 不在 `memberships` 上，停用会影响该用户在**所有**工作区的状态。当前只有一个 seed 工作区，因此无实际差异；但规格与文档 MUST NOT 声称这是「工作区内停用」，多工作区启用前需重新设计。

**[`server.ts` 继续膨胀]** → D9 接受这一代价并记录为后续变更；本次新增约 8 条路由。

**[运营误用批量归档]** → 归档可恢复（D1）、逐条写审计与事件历史、二次确认；不提供任何不可逆的批量删除。

## Migration Plan

**数据库**：一次向前 expand 迁移，仅 `ALTER TABLE invitations ADD COLUMN revoked_at TIMESTAMP(3) NULL`。不改任何已执行过的迁移文件，不删数据，无 contract 阶段。旧版本代码在迁移后仍可运行，因此迁移可先于服务端发布执行。

**上线顺序**（每步独立可回滚）：

1. **迁移**：按既有流程用迁移账号执行（API/worker 不使用迁移账号）。可逆性：新增可空列，旧代码忽略它。
2. **服务端**：发布 api 镜像（新路由 + 达人库归档过滤 + 批量操作 + 标签写入 + 成员生命周期）。可逆性：回滚镜像即可；已写入的 `archived_at` 与 `revoked_at` 对旧代码不可见但无害，已写入的审计与事件行受触发器保护、不可也不需要回滚。
3. **前端**：发布 web 镜像。可逆性：回滚即恢复只读成员页与单条操作。
4. **worker**：本次无 worker 改动，不需重发。

**部署机制**：沿用既有本地构建 + `docker save` tar 侧载流程（生产主机无法访问 Docker Hub），标签按 `YYYYMMDD-N`，切换前保留 `.previous-images.env` 与 infra 备份。

**采集器兼容性**：本次不涉及 `packages/contracts`、采集器行为或 `COLLECTOR_MIN_VERSION`，已分发的 v0.1.5 采集器无需升级。

**与 `tighten-review-funnel` 的发布关系**：本 change 的批量复核复用其「复核即推进 pipeline」语义，MUST 在其服务端部分上线之后实施；若两者同期开发，本 change 的批量复核测试需基于其已合入的 `submitManualReview`。

## Resolved Questions

- **归档是否需要备注必填** → 不必填。归档原因有参考价值但强制填写会催生「1」「test」这类噪声；`candidate_events.note` 可空，与既有 `appendCandidateNote` 一致。
- **已归档候选能否继续被编辑（复核、跟进、标签）** → 能。归档只是可见性标记，不是冻结；运营可能在归档后仍需补记沟通结果。若需要冻结语义，属独立变更。
- **邀请撤销是否发通知邮件** → 不做。系统当前没有任何外发邮件能力，为此引入邮件服务不成比例；管理员口头或 IM 通知即可。
- **批量上限具体取值** → 100（见 D2），实现后以实测耗时确认，必要时下调。
