# 项目协作约定

本文件适用于仓库根目录及其全部子目录。修改代码、脚本或文档前，先阅读本文件以及与任务直接相关的 `docs/` 文档。

## 项目目标与边界

本项目是团队共享的抖音达人发现与运营平台，核心流程是：配置筛选任务 → Windows 本机助手人工启动采集 → 服务端入库和保存证据 → 人工复核 → 合作跟进。

必须保持以下产品边界：

- 抖音登录、Cookie、验证码和浏览器画像只保存在运营人员本机。
- 服务端不能远程启动采集，也不能替用户处理验证码。
- 采集器不得自动点赞、关注、评论、私信、转发或点击“不感兴趣”。
- 低可信度或缺失数据保持 `unknown`，不得按 0、失败或通过进行猜测。
- 截图可以通过短期签名地址直传私有 OSS；不得上传完整视频或把 bucket 改为公开。

## 仓库结构

- `apps/web`：React 管理后台。
- `apps/api`：Fastify API、会话、权限和业务接口。
- `apps/worker`：后台任务和素材清理。
- `apps/collector`：Windows 本机采集助手及本地控制页。
- `packages/contracts`：跨端协议、规则和校验 schema。
- `packages/domain`：数据库、鉴权、任务、候选和媒体领域逻辑。
- `packages/platform-douyin`：抖音页面解析和平台适配。
- `infra/production`：生产 Compose、Nginx 和代理配置。
- `scripts`：开发、迁移、预检、部署、回滚和发布包脚本。
- `docs`：开发、部署、管理员、运营和产品文档。
- `legacy`：只用于兼容与回退的旧采集器，不是默认入口。

## 开发与验证

要求 Node.js 22.12+、npm、Docker Desktop 和 Chrome。优先运行与改动最接近的检查，交付前按风险扩大验证范围。

```powershell
npm run build
npm run typecheck
npm test
npm run lint
npm run format:check
```

完整检查使用：

```powershell
npm run check
```

涉及数据库或浏览器工作流时，按需运行：

```powershell
npm run test:mysql
npm run test:e2e
```

不要假设自动化测试等同于真实抖音或真实 OSS 验收。真实发布前必须进行小范围人工试运行和证据抽查。

## TypeScript 与包边界

- 项目使用 ESM；源码中的相对导入保留 `.js` 后缀。
- 跨应用协议放入 `@douyin/contracts`，平台解析放入 `@douyin/platform-douyin`，业务规则放入 `@douyin/domain`。
- Windows 采集器必须从 `@douyin/domain/collector` 导入采集端安全入口，不要重新改回 `@douyin/domain` 总入口。总入口包含服务端认证模块和原生依赖 `argon2`，会破坏免开发环境的 Windows 发布包。
- 采集端新增领域能力时，先在 `packages/domain/src/collector.ts` 明确导出，再更新采集器导入。
- 数据库迁移只向前执行，并遵守 expand/contract。不要修改已经在生产执行过的迁移文件，也不要自动回滚或删除生产数据。
- `creator_observations`、`post_observations` 和审计记录具有不可变语义；不要绕过触发器进行更新或删除。

## 配置与秘密

- 不得提交或输出 `.env.production`、数据库密码、OSS Secret、会话令牌、设备令牌、Cookie 或私钥。
- 可以检查单个非敏感配置是否存在或是否等于预期值，但不要打印完整环境文件。
- 生产 RDS 必须启用 TLS 并验证 CA；禁止使用 `rejectUnauthorized=false`、`NODE_TLS_REJECT_UNAUTHORIZED=0` 或等效绕过。
- RDS 业务账号只授予 DML，迁移账号按迁移需要授予 DDL；API/worker 不得使用迁移账号。
- 生产 OSS 必须保持 private，并使用最小权限 RAM 身份。
- 日志、测试夹具和错误信息都必须经过敏感字段脱敏。

## 本机采集助手发布

正式用户包应做到 Windows“解压后双击 `start-collector.cmd`”、macOS“解压后双击 `start-collector.command`”。用户无需安装 Node、npm、Python 或编译工具，但必须安装 Chrome。

构建和冒烟验证入口：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File scripts/build-collector-windows.ps1 `
  -Version <version> `
  -ApiBaseUrl <https-url> `
  -CaCertificatePath <optional-public-ca-pem>

powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File scripts/test-collector-windows-package.ps1 `
  -PackagePath artifacts/collector-windows-v<version>.zip
```

```bash
bash scripts/build-collector-macos.sh \
  --version <version> \
  --architecture universal \
  --api-base-url <https-url> \
  --ca-certificate <optional-public-ca-pem>

bash scripts/test-collector-macos-package.sh \
  --package artifacts/collector-macos-universal-v<version>.tar.gz
```

- 自签名 HTTPS 必须把公开证书随包分发并通过 `NODE_EXTRA_CA_CERTS` 信任；不得关闭 TLS 校验。
- 公开 CA 域名不需要随包携带证书。
- `collector.env` 中只能包含采集器所需的非秘密配置，不得放入数据库或 OSS 凭据。Windows 正式启动器还应内置这些非秘密值，不能因为隐藏点文件丢失而要求普通用户手工配置。
- `artifacts/`、本机 `data/`、浏览器画像、`device-token.dpapi` 和 `device-token.keychain` 不得提交到 Git。
- 新版本解压到同级新目录，通过 `../data` 复用本机状态；验证完成前保留旧版本以便回退。
- Windows 使用 DPAPI 和 `device-token.dpapi`；macOS 使用 Keychain 和不含秘密的 `device-token.keychain` 标记。不得降级为明文令牌文件。
- macOS 通用包由 `scripts/build-collector-macos.sh` 在 macOS 上构建，内含 Apple Silicon/Intel 两套运行时并自动选择；同一个包必须使用 `scripts/test-collector-macos-package.sh` 在两个架构真机分别验证。
- macOS `.command` 团队内测包必须附 SHA256。没有完成对应架构真机测试前不得宣布正式可用；面向外部用户大规模分发前应制作 Developer ID 签名及 Apple 公证的 `.app`/`.dmg`。

## 生产运维

- 生产主机只对外开放 80/443；API、worker、MySQL 和 Docker 管理端口不得公网暴露。
- 部署前运行在线预检，确认 RDS TLS/权限、OSS ACL、证书文件和配置占位符。
- `/health/live` 只代表进程存活；以 `/health/ready` 判断 MySQL 和 OSS 状态。MySQL/OSS 不可用则不能视为就绪。
- 修改证书、域名或网关时先备份、执行 `nginx -t`，再仅重建 gateway，并从公网客户端验证。
- 中国大陆云主机使用域名时必须确认 ICP 备案以及当前云厂商的接入备案；证书签发成功不等于域名一定可访问。
- 生产问题优先执行只读诊断。涉及删除、权限扩大、证书替换、数据库修复或回滚时，先确认精确目标和恢复路径。

## 文档同步

用户流程、配置项、权限、发布包行为或运维步骤发生变化时，同步更新以下相关文档：

- `README.md`
- `docs/product-manual.md`
- `docs/collector-windows.md`
- `docs/collector-macos.md`
- `docs/operations/admin-guide.md`
- `docs/operations/operator-guide.md`
- `docs/operations/production-deployment.md`

文档中的命令必须完整可复制；示例不得包含真实密码、Secret、Cookie、令牌或私钥。
