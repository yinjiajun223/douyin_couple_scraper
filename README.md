# 抖音达人采集运营平台

一个面向团队的抖音达人发现、证据筛选、人工复核与合作跟进平台。运营人员在自己的 Windows 或 macOS 电脑上人工启动采集，服务端负责共享任务、候选、证据、审计和协作状态。

默认任务用于寻找 0–5000 粉丝、近 15 天存在万赞作品的潜在素人达人；所有规则均可按任务调整。素人属性和内容适配由人工复核判断，人工结论是最终业务判断。

## 能力概览

- 团队登录、邀请、角色与设备授权。
- 筛选任务、不可变规则快照和受控停止条件。
- Windows/macOS 本机独立抖音画像、人工登录和人工开始。
- 单次运行最长 1,440 分钟；服务异常、网络错误等暂时性页面故障采用有界退避恢复，验证码、登录失效和明确平台限制仍安全暂停。
- 达人、作品、观察历史、硬筛证据和私有截图；只有全部硬筛通过的达人才入库成为候选并采集截图，未入库达人的判定依据仍可在运行详情中查看。
- 人工复核、负责人分配、联系信息与合作阶段；复核结论自动推进合作阶段，达人库按合作阶段分区。
- 审计记录、生产健康检查、备份恢复和发布回滚。

系统不会自动点赞、关注、评论、私信、转发或点击“不感兴趣”。抖音 Cookie、验证码和浏览器画像只留在运营人员本机；截图通过短期签名地址直传私有 OSS，不上传完整视频。

## 系统组成

- Ubuntu/Docker：Nginx gateway、Web、API 和 worker。
- 阿里云 RDS MySQL 8：业务数据、任务、审计和协作状态。
- 阿里云私有 OSS：截图等证据对象。
- Windows/macOS 采集助手：可见 Chrome、独立画像、本地持久队列，以及 DPAPI/Keychain 设备令牌。

采集必须由本机用户明确开始或继续。服务器创建运行、刷新页面或重启助手都不会远程操作抖音。

长运行并不等于绕过平台限制或无人值守守护：电脑和助手进程必须保持运行且系统不得休眠；自动恢复仅维持当前已人工开始的运行，不会处理验证码、自动启动下一运行或保证任何平台状态下绝对连续 24 小时。本机控制页会显示恢复类别、阶段、次数、下次尝试时间和结果，脱敏恢复日志保存在共享 `data/diagnostics` 目录并限制为 3 个文件。

## 文档入口

- [产品使用手册](docs/product-manual.md)：管理员、运营人员和普通成员的完整使用流程。
- [Windows 采集助手](docs/collector-windows.md)：安装、配对、升级和发布包验证。
- [macOS 采集助手](docs/collector-macos.md)：架构选择、Keychain、启动、构建和真机验证。
- [管理员手册](docs/operations/admin-guide.md)：成员、设备、安全和交接。
- [运营手册](docs/operations/operator-guide.md)：任务、采集、复核和合作跟进。
- [本地开发](docs/local-development.md)：开发环境和端到端联调。
- [生产部署](docs/operations/production-deployment.md)：RDS TLS、OSS、Compose、发布和回滚。
- [备份恢复](docs/operations/backup-and-recovery.md) 与 [负载测试](docs/operations/load-test.md)。

## 本地开发

要求 Node.js 22.12+、npm、Docker Desktop 和 Chrome。首次运行：

```powershell
npm install
Copy-Item .env.local.example .env.local
npm run dev:setup
npm run dev:local
```

开发入口：

- 管理后台：`http://127.0.0.1:5173`
- API readiness：`http://127.0.0.1:3000/health/ready`
- 本机采集控制页：`http://127.0.0.1:43127`

完整检查：

```powershell
npm run check
```

MySQL 集成与浏览器流程按需运行：

```powershell
npm run test:mysql
npm run test:e2e
```

## Windows 正式用户

管理员生成的正式 ZIP 已包含 Node、非秘密配置和所需公开 CA。用户只需：

1. 安装 Chrome。
2. 完整解压 ZIP，不能直接在压缩包内运行。
3. 双击 `start-collector.cmd`，保持控制台窗口打开。
4. 在 `http://127.0.0.1:43127` 输入管理员生成的一次性配对码。
5. 创建独立画像、人工登录抖音，再对已下发运行点击“人工开始”。

用户不需要安装 Node、npm、Python 或编译工具。macOS 通用团队内测包同时内置 Apple Silicon 和 Intel 运行时并自动选择，但两个架构仍必须分别完成真机冒烟和人工试运行。

## Windows 发布包

在仓库根目录构建并验证：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File scripts/build-collector-windows.ps1 `
  -Version 0.1.6 `
  -ApiBaseUrl "https://ops.example.com" `
  -CaCertificatePath "release/collector-server-ca.pem"

powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File scripts/test-collector-windows-package.ps1 `
  -PackagePath artifacts/collector-windows-v0.1.6.zip
```

使用公开可信 CA 的域名时省略 `CaCertificatePath`。使用自签名 HTTPS 时只打包公开证书，并通过 `NODE_EXTRA_CA_CERTS` 正常验证；禁止关闭 TLS 校验。

## macOS 发布包

在 macOS 构建机上生成同时兼容 Apple Silicon 和 Intel 的通用发布包，并在当前 Mac 验证对应运行时：

```bash
bash scripts/build-collector-macos.sh \
  --version 0.1.6 \
  --architecture universal \
  --api-base-url 'https://106.12.56.109' \
  --ca-certificate 'release/collector-server-ca.pem'

bash scripts/test-collector-macos-package.sh \
  --package 'artifacts/collector-macos-universal-v0.1.6.tar.gz'
```

通用包内同时包含 `arm64` 和 `x64` 两套经过校验的 Node.js 官方运行时，`start-collector.command` 会自动识别电脑架构。详见 [macOS 采集助手](docs/collector-macos.md)。

## 发布产物留存

`artifacts/` 是本机构建目录，保持 Git 忽略；忽略不会删除本机文件，但这些大体积二进制不随源码仓库同步。需要长期保存和分发的 Windows ZIP、macOS TAR.GZ 及其 SHA256 必须上传到 GitHub Releases。

仓库的 `Collector release` Actions 工作流会构建 Windows 包和 macOS 通用包，执行 Windows、macOS Intel、macOS Apple Silicon 三组冒烟门禁，全部通过后才发布对应版本的 Release。自动门禁不替代运营电脑上的真实配对、登录和小范围人工试运行。

## 生产部署

生产使用固定版本容器镜像、TLS 反向代理、RDS 最小权限账号和私有 OSS。部署前必须执行在线预检；数据库迁移只向前执行，API/worker 不得使用迁移账号。

```bash
sh scripts/deploy-production.sh .env.production
```

`/health/ready` 会分别报告 MySQL 和 OSS 状态，两者都必须正常。中国大陆云服务器绑定域名前，还必须完成 ICP 备案和当前云厂商的接入备案；证书签发不代表域名已具备公网接入条件。

## 安全原则

- 不提交或输出 `.env.production`、密码、OSS Secret、Cookie、会话令牌、设备令牌或私钥。
- RDS 强制 TLS 和 CA 校验；业务账号与迁移账号分离。
- OSS bucket 保持 private，应用只使用最小权限。
- 对外只开放 80/443，API、worker、MySQL 和 Docker 端口不直接暴露。
- 日常业务查看使用管理后台；DMS 只用于授权管理员的只读核对和故障排查。

## 旧结果迁移与兼容入口

旧 JSON/CSV 可通过正常 ingestion 链路导入；缺失证据保持 `unknown`，本地截图路径不会被隐式上传：

```powershell
$env:DATABASE_URL = 'mysql://...'
npm run legacy:import -- --input data/全部候选.json --workspace-id <workspace-id> --actor-user-id <admin-user-id>
```

旧单机采集器仅供回退：`.\legacy\run.ps1` 或 `npm run legacy`。兼容行为记录在 [legacy 基线](legacy/BASELINE.md)。
