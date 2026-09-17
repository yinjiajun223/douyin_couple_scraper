# RDS 与 OSS 备份恢复手册

## 目标与备份策略

- 目标 RPO 24 小时、RTO 4 小时；正式投放期可把 RDS 日志备份频率与保留期提高以缩短 RPO。
- RDS 开启自动备份和日志备份，至少保留 7 天；发布前、权限或批量数据操作前创建手动备份。每月检查一次最近备份可恢复。
- OSS 开启版本控制。`pending`/未确认对象可在 7 天后清理；已确认证据遵循应用 `MEDIA_RETENTION_DAYS`，非当前版本至少保留 30 天。生命周期规则不得直接永久删除仍在数据库中为 `confirmed` 的对象。
- 备份、恢复实例与 OSS 凭据使用独立运维 RAM 身份，密钥不写入仓库或工单正文。

## 隔离恢复流程

1. 在独立 VPC/安全组中从指定时间点创建新 RDS 恢复实例，禁止公网 `0.0.0.0/0`，只允许恢复验证机。
2. 使用只读验证账号连接恢复实例，运行迁移版本检查，并统计 workspace、任务、运行、达人、候选、审计和 `media_objects`。
3. 随机抽取 `media_objects.status='confirmed'` 记录；按 `object_key` 查询 OSS 当前版本。若当前对象损坏或误删，从 OSS 非当前版本恢复到同一 key，并核对大小与 SHA-256 元数据。
4. 沿 `media_objects -> creator/post observation -> run -> campaign -> workspace` 外键链核对业务归属；不要只验证对象存在。
5. 在隔离环境以只读账户启动 API，确认 `/health/ready`、登录后达人详情及私有短签名读取。禁止恢复环境向真实 collector 下发任务。
6. 由负责人记录恢复时间点、备份 ID、抽样 ID/key、校验结果、RPO/RTO 和异常。确认后销毁隔离资源及临时凭据。

## 切换原则

只有原实例不可修复时才切换应用连接。先暂停 worker 和运行中的采集任务，再更新服务器 secret 中的 RDS 地址，启动 API 做 readiness，最后恢复 worker。OSS 对象 key 不变，因此恢复数据库后引用可继续解析。任何缺失对象都标记为待人工补证，不伪造或静默删除业务记录。

## 可重复本地演练

`powershell -File scripts/test-recovery-drill.ps1` 会在一次性 MySQL 8 容器中迁移 schema，建立一条达人观察及已确认 OSS 素材引用，执行一致性备份，恢复到隔离数据库，再通过外键链比对达人 ID 和对象 key。它验证恢复步骤与引用完整性，不替代阿里云控制台的 RDS 时间点恢复和 OSS 版本恢复演练。
