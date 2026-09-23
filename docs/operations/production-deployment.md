# 生产部署与回滚

## 主机边界

- Ubuntu 24.04 主机只运行 TLS 网关、静态 Web、API 和 worker；抖音浏览器与 Cookie 始终留在同事的 Windows 采集机。
- 安全组入站只开放 TCP 80/443。SSH 应限制到管理员固定 IP，不开放 API、MySQL 或容器端口。
- RDS 白名单只加入服务器出口 IP `/32`，不得出现 `0.0.0.0/0`。RDS 强制 TLS。
- OSS bucket ACL 使用 `private`，RAM 身份只授予指定 bucket 前缀所需的读写/删除权限。截图由采集器通过短期签名 URL 直传 OSS。

## 首次准备

1. 将仓库放在 `/srv/douyin-ops/app`，把 `.env.production.example` 复制为 `.env.production` 并执行 `chmod 600 .env.production`。
2. TLS 目录包含 `fullchain.pem` 和 `privkey.pem`。域名 A 记录指向服务器公网 IP。
3. 建立两个 RDS 账号：`douyin_app` 仅业务 DML；`douyin_migrator` 可执行本仓库迁移需要的 DDL。不要让 API/worker 使用迁移账号。由于 schema 使用不可变记录触发器，RDS 参数模板需启用 `log_bin_trust_function_creators=1`，迁移账号仍不授予 SUPER。
4. 开启 RDS 公网地址的 SSL，下载 PEM 格式 CA 证书到 `/srv/douyin-ops/certs/rds-ca.pem`，并通过 `RDS_CA_CERT_PATH` 挂载给迁移、API 和 worker 容器。禁止关闭证书校验。
5. 在阿里云控制台逐项核对 RDS 白名单与 OSS ACL，把实际值写入模板，然后运行：

   `node scripts/preflight-production.mjs --env .env.production --live`

## 发布

镜像必须固定版本标签或 digest。执行 `sh scripts/deploy-production.sh .env.production`。脚本依次执行在线预检、拉取镜像、取得 MySQL 迁移锁并前向迁移、替换服务、检查 readiness。Compose 仅发布 80/443；日志使用 Docker JSON 文件轮转（每个容器 10MB × 5）。

在线预检必须显式调用 `getBucketACL(environment.OSS_BUCKET)`；ali-oss 的该方法不会自动使用构造时配置的 bucket。旧脚本遗漏参数可能请求服务级地址并出现 `Cannot read properties of undefined (reading 'Grant')`。遇到该错误应先备份并更新预检脚本，再重新执行在线检查；不得跳过 ACL 检查、扩大 RAM 权限或把 bucket 改为公开。公开、缺失或无法读取的 ACL 均不得视为通过。

本地已有经过验证的发布镜像包时，优先通过 SCP 直传生产服务器，避免服务器从 GitHub 重复下载。上传后必须在服务器比对完整 SHA256，再导入固定版本镜像；传输方式改变不豁免在线预检、配置备份、发布范围限制或外部 readiness 验证。仅更新网页时按对应发布记录执行 web-only 流程，不直接套用会迁移和替换全部服务的完整发布脚本。

迁移遵守 expand/contract：先新增可空列、表或索引，旧镜像不依赖新字段；确认所有旧镜像退出且观察一个发布周期后，另开变更删除旧结构。禁止在同一发布中重命名或删除旧镜像仍读取的列。

## 回滚

若新版本失败，执行 `sh scripts/rollback-production.sh .env.production`。脚本使用发布前记录的三个镜像版本恢复 Web/API/worker。数据库只执行兼容的前向迁移，不自动降级，以避免数据丢失。若 readiness 仍失败，查看 `docker compose logs --since 15m api worker gateway`，日志中的 request/job/candidate/run/device ID 可关联排查。

## 日常检查

- `/health/live` 只表示 API 进程可响应；`/health/ready` 分别报告 MySQL 和 OSS 状态。MySQL/OSS 故障返回 503。
- 每周确认磁盘、容器重启次数、RDS 连接数与 OSS 清理任务结果。
- 迁移 `0014_media_cleanup_index.sql` 随本轮发布前向执行，为素材清理新增 `(status, confirmed_at)` 索引；InnoDB 加二级索引是在线 DDL，不阻塞 worker。
- `ORPHAN_MEDIA_CLEANUP_ENABLED` 默认关闭。开启孤儿证据回收前先按[管理员手册](admin-guide.md)第 4 节确认入库闸门正常并核对宽限期天数；该路径会永久删除 OSS 对象，不可恢复。建议先只部署代码、保持开关关闭并观察一轮计数，再显式开启。
- 不记录 Cookie、Authorization、设备令牌、OSS key 或密码；这些字段由应用日志脱敏配置拦截。
