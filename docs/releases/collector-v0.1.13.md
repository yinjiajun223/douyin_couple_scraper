# Collector v0.1.13

## 变更摘要

- 本机采集助手的字体、面板、输入框、焦点状态和下拉框样式与团队工作台统一。
- 下拉框增加明确的箭头、悬停和聚焦反馈；选项、保存行为、采集规则及安全暂停边界均不变。
- 团队工作台达人详情增加置顶的一键“通过 / 不通过”复核入口；仍复用既有人工复核接口，原有“待定”、理由和完整工作流表单继续保留。

采集协议仍为 `1.0.0`，服务端最低采集器版本不提高。

## 发布状态

- GitHub Actions 正式 Release 已上传 Windows ZIP：`collector-windows-v0.1.13.zip`，45,346,266 字节；包级冒烟和 `start-collector.cmd` 启动器冒烟通过。Release 资产 SHA256：`3b2a8ca8c1977b11a9df9dd748611c72a6323c79936e0a16065423537dbe180a`。
- 本机此前生成的 Windows 包仍保留在 `artifacts/collector-windows-v0.1.13.zip`，用于本地回退和复核；新包已并排安装到 `collector-windows-v0.1.13`，共享 `../data` 未改动，v0.1.12 进程未被停止。
- Web-only 生产镜像已构建为 `douyin-ops-web:20260929-1`，隔离容器健康检查为 HTTP 200，生产 JS 包含“一键复核”“通过”“不通过”入口。镜像归档为 `artifacts/douyin-ops-web-20260929-1.tar`，31,843,840 字节，SHA256 为 `98f9c8179c5710c92d5ef8e9bb18dce07f3a24b53f3bef4217e9ad0013b2c5ba`。
- 生产 Web 已切换到 `douyin-ops-web:20260929-1`：线上预检（RDS TLS/权限及 OSS 私有 ACL）、镜像 SHA256、Web 健康检查、Nginx 配置、HTTPS readiness 和生产静态资源中的“一键复核”入口均已验证。API 与 worker 仍保持 `20260923-2`，未执行数据库迁移；回退备份位于 `/srv/douyin-ops/app/infra/production/web-release-20260929-1-final.kcGGuj`。
- GitHub Actions 已构建并上传 macOS universal 包：`collector-macos-universal-v0.1.13.tar.gz`，同时在 Intel 和 Apple Silicon runner 上使用同一包通过冒烟验证。Release 资产 SHA256：`747c68a42696795ccb26d222c132a6958622e5776f5b2abe6cfdd855a9688302`。

## 安装与回退

将 v0.1.13 解压到 v0.1.12 同级的新目录并继续复用 `../data`，不要覆盖旧目录。关闭旧助手及其可见 Chrome 后，再从新目录双击 `start-collector.cmd`；验证完成前保留 v0.1.12 用于回退。
