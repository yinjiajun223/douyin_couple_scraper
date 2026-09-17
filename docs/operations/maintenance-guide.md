# 运维维护与故障处理

## 日常与每周检查

每日查看 `/health/ready`、容器重启、后台任务 `queued/retry/dead` 和磁盘使用。每周核对 RDS 连接/CPU、OSS 清理结果、证书剩余有效期、Docker 日志轮转和异常登录/设备审计。AI 故障是降级项；MySQL 或 OSS 故障会使 readiness 返回 503。

生产发布、迁移和回滚按 `production-deployment.md`；RDS/OSS 备份及隔离恢复按 `backup-and-recovery.md`；2 核 4GB 验收按 `load-test.md`。发布镜像必须固定标签或 digest，先运行 `node scripts/preflight-production.mjs --env .env.production --live`，禁止跳过数据库权限、TLS、RDS 白名单和 OSS ACL 检查。

## 常见故障

1. API 503：读取 readiness 的 component，MySQL 检查 TLS、白名单、账号权限和连接数；OSS 检查 endpoint、RAM 权限和 private ACL。
2. 网关 502：检查 API 容器和网关 upstream。替换或回滚 API 后必须强制重建 gateway，避免缓存旧容器地址。
3. worker 堆积：先停止新增运行，检查 dead/retry 错误码和 AI 限流；确认租约会恢复后再重启 worker。2 核 4GB 默认并发保持 1。
4. collector 离线：不要删除本地数据目录；恢复网络后让持久队列继续逐条确认。设备撤销或版本过低时需重新配对或升级。
5. 素材缺失：沿素材 ID、观察 ID、运行 ID 查日志，核对 OSS object key、大小和 SHA-256。缺失时标记待人工补证，不伪造引用。
6. 并发编辑冲突：让运营刷新候选后重做操作，不直接修改数据库版本号。

## 旧数据导入

导入前创建 RDS 备份，确认 workspace 与执行管理员 ID。运行 `npm run legacy:import -- --input <json-or-csv> --workspace-id <id> --actor-user-id <id>`。报告包含源记录、合法记录、输入重复、导入观察、跳过截图及 run ID；同一文件在同一 workspace 重跑会返回 `existingImport: true`，不会重复导入。

导入生成 `legacy_import` 运行并走正常达人/观察/候选去重链路。旧文件没有作品明细时相关硬筛证据保持 unknown；旧截图路径仅统计，不读取或上传。导入后抽查候选、观察时间和 unknown 结论，再决定是否用新 collector 补充证据。

## 事故记录最低字段

记录发生/恢复时间、影响工作区、版本 digest、request/run/device/job/candidate ID、根因、处置、数据完整性检查和后续行动。任何凭据只写密码管理器引用，不写进事故正文。
