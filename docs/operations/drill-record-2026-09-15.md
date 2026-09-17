# 2026-09-15 本地生产基线演练记录

- 环境：Docker Desktop Linux VM，使用与生产相同的 API/worker/Web Dockerfile、Nginx 路由策略与 MySQL 8 schema；不含真实 RDS/OSS 凭据。
- 镜像：API/worker 使用 Node 24.18.1 Bookworm slim 并更新 Debian 安全包；Web 使用 nginx-unprivileged 1.29 Alpine 并执行安全升级；三者均为非 root。
- 构建/联调：三镜像生产构建成功；迁移容器从空库应用 12 个迁移；MySQL、API readiness、worker、Web、网关均健康；HTTP 页面、健康路由、请求 ID 与安全头通过。
- 漏洞：固定 Grype v0.116.1，`--only-fixed --fail-on high`。旧基础镜像曾检出可修复高危，升级 Node/系统包并移除 npm/Playwright 后，API、worker、Web 均为 `No vulnerabilities found`。
- 恢复：创建达人 `recovery-drill-creator`、观察记录与已确认素材 key，执行 `mysqldump --single-transaction --routines --triggers`，恢复到 `douyin_ops_restore`，通过外键链得到原达人 ID 与完全相同的 OSS key。结果 `RECOVERY_DRILL_OK`。
- 发布回滚：以不同 release label 构建 current/previous 镜像；空库前向迁移 12 个版本并启动 current；随后恢复 previous API/worker/Web。首轮演练发现 Nginx 缓存旧容器地址并持续 502，发布与回滚脚本增加网关强制重建后复测通过，结果 `RELEASE_ROLLBACK_DRILL_OK migrations=12`。
- 边界：这是本地可重复演练。真实 RDS 时间点恢复、OSS 非当前版本恢复以及 Ubuntu 2核4GB 指标仍需在阿里云 staging/生产权限到位后执行并追加记录。
