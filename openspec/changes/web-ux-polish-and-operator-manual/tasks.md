## 1. 下拉浮层 portal 化与样式

- [x] 1.1 在 `apps/web/src/components/FilterSelect.tsx` 用 `createPortal` 把浮层挂到 `document.body`，`position: fixed`、宽度对齐触发按钮，下方空间不足时向上翻转；监听 `scroll`(capture) 与 `resize` 重算位置，触发按钮离开视口时收起。键盘操作（方向键、Home/End、Escape 回焦）与外部点击关闭行为保持不变。验证：`npm run typecheck -w @douyin/web` 通过。
- [x] 1.2 重做 `.filter-select-popover` / `.filter-select-option` / `.filter-select-check` 样式：选项行 hover 底色、选中用薄荷色对勾而非实心圆点、圆角与阴影与面板一致。验证：浏览器走查成员页最后一行与达人详情折叠区内的下拉，浮层完整可见且不再被裁切，截图留档。
- [x] 1.3 在 `tests/web-access.e2e.spec.ts` 断言浮层 portal 后完整落在视口内（成员列表最后一行打开角色下拉，取 boundingBox 校验不超出 viewport），并断言浮层挂载在 `body` 下。验证：`npx playwright test tests/web-access.e2e.spec.ts` 全绿。

## 2. 移除「打开本机助手」入口

- [x] 2.1 删除 `apps/web/src/pages/CampaignsPage.tsx` 与 `apps/web/src/pages/DevicesPage.tsx` 中的「打开本机助手」按钮；设备页配对说明改为可复制文本给出 `http://127.0.0.1:43127`，并说明由本机助手启动时自动打开或手动访问。验证：`grep -rn "打开本机助手" apps/web/src` 无命中。
- [x] 2.2 同步 `docs/product-manual.md` 的「点击“打开本机助手”后进入 127.0.0.1」FAQ 与 `docs/local-development.md` 的配对步骤，改为手动访问控制页地址。验证：`grep -rn "打开本机助手" docs` 只剩历史说明或无命中，且说法与实现一致。

## 3. 滚动条主题化

- [x] 3.1 在 `apps/web/src/styles.css` 增加全局细窄滚动条：`scrollbar-width: thin` + `scrollbar-color`，以及 `::-webkit-scrollbar` / `-thumb` / `-track`（thumb 用 `background-clip: content-box` 做细条）。验证：浏览器走查达人库列表、详情滚动区、成员面板三处滚动条观感一致，截图留档。

## 4. 内置操作手册

- [x] 4.1 新增 `apps/web/src/pages/HelpPage.tsx` 与主导航「操作手册」入口（全部角色可见）：运营章节（配对与人工开始、复核与批量、标签与归档）、管理员章节（成员生命周期与护栏、邀请撤销、设备撤销与重新配对、模板维护）、常见问题章节（未入库、版本冲突、批量部分失败、已归档找不到、停用后设备需重配对）。界面名称与 `apps/web/src/constants.ts` 及页面文案逐一对应。验证：`npm run build -w @douyin/web` 通过。
- [x] 4.2 在 `tests/web-access.e2e.spec.ts` 的角色矩阵用例中断言三种角色都能看到「操作手册」入口，运营视图不含管理员章节标题，管理员视图含护栏与救援路径说明。验证：e2e 全绿。

## 5. 验证与发布

- [x] 5.1 运行 `npm run check` 与 `npm run test:mysql`、`npm run test:e2e`，并 `openspec validate "web-ux-polish-and-operator-manual" --strict`。验证：退出码 0 / 输出 valid。
- [ ] 5.2 构建 `20260923-2` 三个镜像（`--build-arg RELEASE_ID=<sha>`），跑 `scripts/test-production-images.ps1` 冒烟门禁，`docker save` 单 tar + 裸文件名 sha256，按既有 runbook 交付服务器步骤（仅换 tag，无迁移、无 infra 变更）。验证：门禁与 grype 通过，tar 校验和在服务器 `sha256sum -c` 为 OK。

  本地交付准备记录（2026-09-23）：以 revision `1fffb80c3f31` 构建三个 `20260923-2` 镜像；生产镜像 smoke compose 全部 healthy，Grype 三镜像均为 `No vulnerabilities found`；已生成单包 `release/douyin-ops-images-20260923-2-bundle.tar` 及裸文件名校验文件，本地重算 SHA-256 为 `4b0bedf39a6cdd2cb776c9158f47650e71cdfd0cc58ff41895dae3f5d467e0a9` 并通过。待完成服务器传输与 `sha256sum -c` 后再勾选本项；本轮未执行生产连接、镜像切换、迁移或 infra 变更。
