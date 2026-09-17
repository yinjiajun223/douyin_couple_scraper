# 抖音素人博主运营平台

这是一个团队共享的抖音博主发现、证据筛选、人工复核和合作跟进平台。默认模板寻找疑似 18–24 岁、0–5000 粉丝、近 15 天有一条万赞作品的素人账号；所有规则都可按任务调整，AI 只提供建议，最终结论由运营人员确认。

系统由 Ubuntu 服务器上的 Web/API/worker、阿里云 RDS MySQL 8、私有 OSS，以及运营同事 Windows 电脑上的本地采集助手组成。抖音登录 Cookie 只留在本机独立浏览器画像中；服务器不能远程自动启动浏览，截图由本机直传 OSS，也不上传完整视频。

## 本地开发

要求 Node.js 22.12+、npm 和 Docker Desktop。首次运行：

```powershell
npm install
Copy-Item .env.local.example .env.local
npm run dev:setup
npm run dev:local
```

管理后台位于 `http://127.0.0.1:5173`，本地采集控制页位于 `http://127.0.0.1:43127`。完整说明见 [本地调试](docs/local-development.md)。

## Windows 采集助手

在 `.env` 中至少配置 `COLLECTOR_API_BASE_URL`、`COLLECTOR_DATA_DIR` 和 `COLLECTOR_CONTROL_PORT`，然后运行默认入口：

```powershell
.\run.ps1
```

打开 `http://127.0.0.1:43127`，创建独立画像、输入一次性配对码并人工开始任务。详细步骤见 [Windows 采集助手](docs/collector-windows.md) 和 [运营手册](docs/operations/operator-guide.md)。

## 生产部署

生产使用固定版本容器镜像、TLS 反向代理、RDS 最小权限账号和私有 OSS。部署前必须运行在线预检，完整流程见 [生产部署手册](docs/operations/production-deployment.md)；备份恢复和负载验收分别见 [备份恢复](docs/operations/backup-and-recovery.md) 与 [低并发负载测试](docs/operations/load-test.md)。

## 旧结果迁移与兼容入口

旧 JSON/CSV 可通过正常 ingestion 链路导入；缺失粉丝或作品证据保持 `unknown`，截图路径只计入报告而不会被隐式上传：

```powershell
$env:DATABASE_URL = 'mysql://...'
npm run legacy:import -- --input data/全部候选.json --workspace-id <workspace-id> --actor-user-id <admin-user-id>
```

旧单机采集器仅供回退：`.\legacy\run.ps1` 或 `npm run legacy`。它不会从仓库根目录的默认入口启动；兼容行为记录在 [legacy 基线](legacy/BASELINE.md)。
