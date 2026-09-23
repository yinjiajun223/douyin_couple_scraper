## Why

2026-09-23 生产上线（`20260923-1`）后的真实走查里，管理员在成员页发现四类界面问题：角色下拉的浮层被面板 `overflow: hidden` 裁切、选项样式粗糙；「打开本机助手」按钮因跨源守卫必然失败却仍然留在界面上误导运营；全站滚动条是浏览器默认样式，与深色侧栏和浅色面板都不协调；运营同事需要翻仓库文档才能查到操作步骤，希望后台内直接有操作手册。四项都是走查阻断级或高频可见的体验缺陷，且都不涉及后端行为。

## What Changes

- 筛选/表单下拉（`FilterSelect`）改为 portal 到 `document.body` 的固定定位浮层：宽度对齐触发按钮，下方空间不足时向上翻转，滚动与窗口变化时跟随或收起；选项行重做 hover/选中样式。任何滚动或裁切容器（成员面板、达人详情折叠区）里的下拉都必须完整可见。
- 删除管理后台里所有「打开本机助手」按钮（筛选任务页与采集设备页）。采集设备页保留配对流程说明，并把本机控制页地址 `http://127.0.0.1:43127` 以可复制文本形式给出；同步修订 `docs/product-manual.md` 的相关 FAQ 与 `docs/local-development.md`。
- 全站滚动条统一为细窄主题样式（Firefox `scrollbar-width: thin` + WebKit `::-webkit-scrollbar`），列表、详情、面板同一观感。
- 主导航新增「操作手册」视图：按角色呈现 curated 的操作步骤与常见问题（运营快速上手、管理员成员/设备/模板职责、异常处理），界面名称与 `apps/web/src/constants.ts` 及页面文案一致；不引入 markdown 渲染依赖。

## Capabilities

### New Capabilities

- `operator-console-usability`: 管理后台的可用性与自助文档边界——浮层完整可见、不提供必然失败的本机入口、内置操作手册。

### Modified Capabilities

（无：四项都不改变既有 capability 的需求。）

## Impact

- 仅 `apps/web` 与文档；`packages/*`、`apps/api`、`apps/collector` 零改动，采集器包不需要重新分发。
- 无数据库迁移、无配置键变化：回滚只需换镜像 tag。
- 发布标签 `20260923-2`，沿用本地构建 + tar 侧载流程。
