# Legacy 采集器兼容基线

本文件记录平台化改造前 `scraper.cjs` 与 `run.ps1` 的行为，便于在迁移期间验证能力没有意外丢失。Legacy 入口已移至 `legacy/`，不再是仓库默认启动路径。

## 启动和参数

- PowerShell 入口：`.\legacy\run.ps1`
- Node 入口：`node legacy/scraper.cjs`
- 默认关键词：`情侣博主`、`情侣日常`、`情侣vlog`、`恋爱日常`
- 默认粉丝范围：200–5000
- 默认最多校验主页：80
- 默认滚动次数：12
- 可配置参数：`--keywords`、`--min-followers`、`--max-followers`、`--max-profiles`、`--scrolls`

## 安全边界

- 使用 `data/browser-profile` 中的独立持久浏览器资料。
- 打开可见 Chrome 或 Edge，并由用户人工登录和处理验证码。
- 只读取公开页面，不执行点赞、关注、评论或私信。

## 输出

- `data/全部候选.csv`
- `data/全部候选.json`
- `data/粉丝{下限}-{上限}_待人工复核.csv`
- `data/人工复核.html`
- `data/screenshots/*.png`

2026-09-15 保存的本地样例包含 80 个候选，其中 1 个账号命中 200–5000 粉丝范围，并生成 1 张截图；80 个候选均来自首个关键词“情侣博主”。这些本地文件可能包含浏览器登录资料或公开账号信息，现已通过 `.gitignore` 排除，不作为测试夹具提交。

## 离线回归

运行以下命令，无需启动浏览器或访问抖音：

```powershell
node --test tests/legacy-baseline.test.cjs
```

测试覆盖默认/自定义参数、主页链接规范化、万/亿/W/K 数字解析、粉丝文本识别、CSV 转义和安全文件名。
