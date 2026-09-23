## D1 下拉浮层用 portal + 固定定位，而不是改容器 overflow

`.data-panel` 的 `overflow: hidden` 是面板圆角与分隔线所需要的，达人详情外层又是 `overflow-y: auto` 的滚动容器；把浮层留在原 DOM 里就只能二选一：要么放开所有祖先的 overflow（破坏面板视觉与滚动锁高），要么接受裁切。因此 `FilterSelect` 打开时用 `createPortal` 把浮层挂到 `document.body`，`position: fixed`，宽度取触发按钮的 `getBoundingClientRect()`，默认贴在按钮下方 7px；若下方剩余高度小于浮层高度则翻转到按钮上方。监听 `scroll`（capture）与 `resize` 重新计算位置，触发按钮离开视口时直接收起。焦点管理不变：选项仍由 `optionRefs` 持有，portal 不影响 `focus()` 与 Escape 回焦触发按钮；外部点击关闭的判定改为同时检查触发按钮容器与 portal 容器。

## D2 手册是 curated 静态内容，不渲染 markdown

仓库文档（`docs/product-manual.md` 等）使用表格与代码块，自研 markdown 渲染器会引入长期维护负担，且把整份文档打进前端包会泄露运维细节（RDS、回滚、救援 SQL）。因此「操作手册」视图是一组静态 React 段落，只写运营/管理员在界面上能做的事，界面名称直接引用页面文案；运维类内容仍留在仓库文档。代价是手册与文档存在两份表述，靠发布前对照 `apps/web/src/constants.ts` 与页面文案检查（写入任务验证）。

## D3 滚动条用标准属性 + WebKit 伪元素双写

Firefox 走 `scrollbar-width: thin` 与 `scrollbar-color`，Chromium/Edge 走 `::-webkit-scrollbar` 族。 thumb 用 `background-clip: content-box` 加透明 border 做出细窄观感，track 保持透明以免在深色侧栏上出现灰条。不对单个容器做特例，避免列表与详情再次出现两种滚动条。
