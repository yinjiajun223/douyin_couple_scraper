## Why

管理员对业务数据几乎没有操作权限。候选既不能归档也不能批量处理——`campaign_candidates.archived_at` 列自 0004 迁移起就存在，今日工作台的查询也已经在过滤 `archived_at IS NULL`，但**没有任何代码写入它**，是一个半成品；`tags` / `candidate_tags` 表已建好、列表可读可筛，却**没有写入 API**，只有测试夹具在塞数据。所有候选操作都是单 ID 的，复核队列只能一条条点。

成员管理的缺口更大：只能邀请，**不能改角色**（代码里没有任何地方 UPDATE `memberships.role`），**不能停用**——而 `disableUserAccount` 其实已经完整实现（撤销会话、撤销设备、写审计），只是从未挂上任何 HTTP 路由。人员变动时管理员无法收回权限，只能去动数据库。

还有两处「后端已就绪、界面从未交付」的缺口：`screening-campaigns` 主 specs 早已要求任务的编辑 / 复制 / 归档与「从模板预填」，`campaign-service.ts` 与 `server.ts` 的六条路由也已实现，但 `CampaignsPage.tsx` 只有硬编码默认值的新建表单、`TemplatesPage.tsx` 是纯只读列表，运营改条件只能再建一个任务；采集设备列表把已撤销设备与在用设备混排，而设备行被采集观测记录外键引用、物理删除不可能，运营看到的是一份越用越长且无法清理的名单。

## What Changes

**候选数据操作**

- 候选**软归档 / 取消归档**：写入既有但未使用的 `archived_at` 列。归档后从所有默认视图隐藏，可从新增的「已归档」视图恢复。
- `candidate-library` 列表查询补上 `archived_at IS NULL` 过滤（dashboard 已有此过滤，library 缺失，属现存不一致）。
- **批量人工复核**（approved / rejected）与**批量归档**：沿用单条路径的语义，包括 `tighten-review-funnel` 引入的「复核即推进 pipeline」。逐条执行行级访问校验与乐观锁，返回按 ID 的结果，允许部分成功；每条各写一个审计事件（审计表 append-only 且按主体记录）。
- **标签写入**：新增候选打标签 / 取消标签的能力，复用已存在的表、读路径与筛选参数。

**「删除」与「编辑」的语义边界（明确写入规格，避免反复被问）**

- **删除只能是软归档，不提供物理删除**。`creator_observations`、`post_observations`、`candidate_events`、`audit_events`、`campaign_rule_versions` 五张表均有 `BEFORE UPDATE/DELETE ... SIGNAL` 触发器保护，物理级联删除在数据库层面不可能。半物理删除还会产生「删掉的达人下次采集又出现」的行为，运营必然当 bug 上报。
- **采集事实字段不可编辑**：昵称、粉丝数、简介、点赞数、作品发布时间属于 `creator_observations` / `post_observations` 的观测事实，受触发器保护，且产品边界要求低可信度数据保持 `unknown`、不得人为猜测篡改。
- **可编辑的运营字段已全部有 endpoint，本 change 不重复建设**：联系方式、联系值、报价、币种、下次跟进时间、下一步动作、归属人经由既有 `PUT /candidates/:id/outreach`；备注经由既有 `POST /candidates/:id/notes`（append-only）。「编辑候选」的真实缺口只有标签一项。

**成员管理**

- **停用 / 启用成员**：停用接上现成的 `disableUserAccount`（级联撤销会话与设备、写 `account.disabled` 审计）；启用为新增的反向操作。
- **修改成员角色**：新增对 `memberships.role` 的更新能力，写审计。
- **邀请列表与撤销**：目前只能创建邀请，无法查看待处理邀请或使已发出的邀请失效。
- **护栏（必须）**：不能停用自己；不能停用或降级工作区内最后一个 `admin`——否则工作区永久锁死，只能靠 `bootstrap-admin` CLI 救援。停用与降级均需二次确认。

**筛选任务与模板的操作界面（规格早已要求，界面从未交付）**

- 主 specs 的 `screening-campaigns` 已明确要求「创建、复制、编辑、归档筛选任务」与「选择初始模板 → 预填模板规则并允许在保存前调整」，后端能力也已全部存在（`updateCampaign` / `archiveCampaign` / `copyCampaign` / `updateCampaignTemplate` / `archiveCampaignTemplate`、`createCampaign` 接受 `templateId`、乐观锁 `expectedVersion` → HTTP 409、审计 `campaign.rules_updated`），**缺口纯在界面**：`CampaignsPage.tsx` 只有「新建」表单且字段是硬编码默认值，`TemplatesPage.tsx` 是纯只读列表，创建任务时从不发送 `templateId`。
- 因此本 change 补齐：任务的编辑（含版本冲突提示）/ 归档 / 复制入口，模板的新建 / 编辑 / 归档入口，以及新建任务时的「从模板预填」。
- **本 capability 无需 spec delta**：`screening-campaigns` 主 specs 已覆盖上述行为，本 change 只是让实现追上规格。

**采集设备列表的可见性**

- 已撤销设备目前与在用设备混排在同一列表中且无法移除（设备行被采集观测记录以外键引用，物理删除不可能）。改为**默认只展示有效设备**，并提供「显示已撤销」开关把已撤销设备作为只读历史（含撤销时间）追加展示。
- 为此 `listWorkspaceDevices` 需返回既有但从未 SELECT 的 `devices.revoked_at`（`0001_access.sql:90`）。**无 DDL、无新路由、无新权限字符串**；不提供恢复、改名或删除入口。

**权限**

- 候选归档、批量操作、标签写入沿用既有 `candidate:write` / `outreach:write`，并复用既有行级可见性 scoping（管理员可见全部，非管理员仅见与自己相关的候选），不新增权限字符串。
- 成员停用 / 启用 / 改角色 / 邀请管理沿用既有 `members:manage`（仅 admin）。
- 筛选任务的编辑 / 归档 / 复制沿用既有 `campaign:write` 路由（admin 与 operator 均可），模板的新建 / 编辑 / 归档沿用既有 `workspace:manage` 路由（仅 admin），设备列表可见性沿用既有 `device:manage`。
- 所有新增写路由要求 CSRF 令牌，与既有变更路由一致。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `creator-candidate-library`: 新增归档状态及其对默认可见性的影响、「已归档」视图与恢复、标签的写入语义、批量操作的部分成功语义；明确软归档是唯一的删除形式。
- `creator-review-and-outreach`: 复核与归档支持批量提交；明确采集事实字段不可编辑、可编辑运营字段的范围与既有入口。
- `internal-access-control`: 成员停用 / 启用、角色变更、邀请列表与撤销；最后管理员与自我停用护栏；停用对会话与设备的级联效果；已撤销设备默认隐藏并可作为只读历史查看。

> `screening-campaigns` **不在** Modified Capabilities 中：其主 specs 已要求任务的编辑 / 复制 / 归档与模板预填，本 change 只是补齐界面实现，不改变规格。

> 基线已就绪：上述三个 capability 的主 specs 已从 `build-douyin-influencer-ops-platform` 的 delta 同步到 `openspec/specs/`（该 change 仍有四项真实环境验收未完成，故保持未归档），本 change 的 MODIFIED delta 有可修改的基线。
>
> 实施顺序依赖：本 change 的批量复核复用 `tighten-review-funnel` 引入的「复核即推进 pipeline」语义，应在其之后实施。

## Impact

**服务端（packages/domain）**
- `src/candidates/candidate-library.ts` — 补 `archived_at IS NULL` 过滤；新增归档视图、标签写入、批量操作的领域函数。
- `src/candidates/candidate-workflow.ts` — 批量复核复用单条推进语义；归档 / 取消归档写 `candidate_events`。
- `src/auth/sessions.ts` — 已有 `disableUserAccount`（:195-238），需补启用成员的反向操作，并修正其审计 actor：当前写的是 `actorUserId: userId`（被停用者本人，:224），应为执行操作的管理员。
- `src/auth/directory.ts` — 角色变更、邀请列表与撤销（该文件目前只有两个只读查询）；`listWorkspaceDevices`（:45）补返回既有的 `devices.revoked_at`（`0001_access.sql:90`），无 DDL。
- `src/auth/invitations.ts` — 目前只有 `createInvitation` / `acceptInvitation`，需补列表与撤销。
- `src/audit/audit-events.ts` — `AuditAction` 联合类型需扩展（如 `candidate.archived`、`candidate.unarchived`、`candidate.tags_changed`、`account.role_changed`、`account.enabled`、`account.invitation_revoked`）。

**数据库**
- 只需**一次向前迁移**：给 `invitations` 增加撤销标记列（现无该列，`0001_access.sql:40-58`）。不修改任何已执行过的迁移文件，不删除生产数据，遵守 expand/contract。
- 以下均**无需 DDL**（勘查确认）：`audit_events.action` 与 `candidate_events.event_type` 都是无 CHECK 约束的 `VARCHAR(100)`，新增取值只是 TypeScript 联合类型扩展；`tags` / `candidate_tags` 的 `uq_tags_workspace_name`、主键 `(candidate_id, tag_id)` 与 `idx_candidate_tags_tag` 已覆盖按名 upsert、按候选读写与按标签筛选；`campaign_candidates.archived_at` 已存在（`0004:12`）。

**API（apps/api）**
- `src/server.ts` — 新增归档 / 取消归档、批量复核、批量归档、标签写入、成员停用 / 启用、成员改角色、邀请列表 / 撤销路由。单文件已承载全部路由，需评估是否拆分。
- 筛选任务与模板的编辑 / 归档 / 复制路由**已全部存在**（`PATCH /campaigns/:id`、`POST /campaigns/:id/archive`、`POST /campaigns/:id/copy`、`GET|POST /campaign-templates`、`PATCH /campaign-templates/:id`、`POST /campaign-templates/:id/archive`），设备可见性也**不需要新路由或新查询参数**（过滤在前端完成）。

**前端（apps/web）**
- `src/pages/CandidatesPage.tsx` — 归档 / 恢复入口、多选与批量操作栏、标签编辑。
- `src/pages/MembersPage.tsx` — 目前是只读成员列表 + 邀请表单，需补角色变更、停用 / 启用、邀请管理，以及护栏触发时的禁用态与说明文案。
- `src/pages/CampaignsPage.tsx` — 目前只有硬编码默认值的「新建」表单，需补编辑（含 409 版本冲突提示）、归档、复制，以及新建时的「从模板预填」（发送 `templateId`）。
- `src/pages/TemplatesPage.tsx` — 目前是纯只读列表（连 `csrfToken` prop 都没有），需补模板的新建 / 编辑 / 归档。
- `src/pages/DevicesPage.tsx` — 默认只展示有效设备，加「显示已撤销」开关与撤销时间；已撤销行保持只读。
- `src/types.ts`、`src/constants.ts`、`src/api/client.ts` — 相应类型与错误处理。前端**没有**集中的接口封装层（`src/lib/api.ts` 不存在），各页面直接 `fetch` + `readResponse`，新增调用沿用该写法；`readResponse` 目前把所有非 401 错误压成同一句文案，无法区分 409 版本冲突与批量部分失败，需要补可区分的错误信息。
- `CampaignSummary` 目前不含 `rules_json` / `source_template_id`，`OperationsDesk.tsx:74-79` 也把 `GET /campaigns` 已返回的这些字段丢弃了；编辑表单要预填现有规则就必须补上。

**文档**
- `docs/product-manual.md`、`docs/operations/operator-guide.md` — 归档、批量操作、标签的运营流程；筛选任务的编辑 / 归档 / 复制与「从模板预填」。
- `docs/operations/admin-guide.md` — 成员停用 / 启用、改角色、邀请撤销，最后管理员护栏的说明与救援路径；模板的维护职责与已撤销设备的历史查看方式。

**明确不在本 change 范围内**
- 不做候选物理删除（触发器层面不可能）。
- 不做密码重置流程（工作量中等，先用「停用 + 重新邀请」替代）。
- 不启用 `workspace_roles` 自定义角色（运行时从不读取该表，且 CHECK 仅允许三个角色名）。
- 不做工作区 CRUD（多租户 schema 已存在，但登录需已知 `workspaceId`，当前仅一个 seed 工作区）。
- 不做设备的解吊销 / 改名 / 物理删除（设备行被采集观测记录以外键引用）；本 change 只把已撤销设备改为默认隐藏 + 可展开的只读历史。运营本机的「取消配对」属采集器能力，留待 collector v0.1.6。
- 入库闸门、复核驱动状态流转、达人库分区轴调整属于 `tighten-review-funnel`；本 change 依赖其「复核即推进 pipeline」的语义，应在其后实施。
