# Collector v0.1.13

## 变更摘要

- 本机采集助手的字体、面板、输入框、焦点状态和下拉框样式与团队工作台统一。
- 下拉框增加明确的箭头、悬停和聚焦反馈；选项、保存行为、采集规则及安全暂停边界均不变。
- 团队工作台达人详情增加置顶的一键“通过 / 不通过”复核入口；仍复用既有人工复核接口，原有“待定”、理由和完整工作流表单继续保留。

采集协议仍为 `1.0.0`，服务端最低采集器版本不提高。

## 发布状态

- Windows 正式 ZIP 已生成：`artifacts/collector-windows-v0.1.13.zip`，44,304,469 字节；包级冒烟和 `start-collector.cmd` 启动器冒烟通过，内置 Node、DPAPI 配对往返、独立画像、可见 Chrome、本机控制服务和公开 CA 均通过检查。
- Windows ZIP SHA256：`8b00c4776de82d40f6594daf814082f7f6426af28f9758bc8fb2d06a49b0cb54`；与同目录 `.sha256` 文件一致。新包已并排安装到 `collector-windows-v0.1.13`，共享 `../data` 未改动，v0.1.12 进程未被停止。
- Web-only 生产镜像已构建为 `douyin-ops-web:20260929-1`，隔离容器健康检查为 HTTP 200，生产 JS 包含“一键复核”“通过”“不通过”入口。镜像归档为 `artifacts/douyin-ops-web-20260929-1.tar`，31,843,840 字节，SHA256 为 `98f9c8179c5710c92d5ef8e9bb18dce07f3a24b53f3bef4217e9ad0013b2c5ba`。
- 生产 Web 已切换到 `douyin-ops-web:20260929-1`：线上预检（RDS TLS/权限及 OSS 私有 ACL）、镜像 SHA256、Web 健康检查、Nginx 配置、HTTPS readiness 和生产静态资源中的“一键复核”入口均已验证。API 与 worker 仍保持 `20260923-2`，未执行数据库迁移；回退备份位于 `/srv/douyin-ops/app/infra/production/web-release-20260929-1-final.kcGGuj`。
- macOS 只同步共享源码和版本；未构建通用包，也未完成 Apple Silicon/Intel 双架构真机门禁。

## 安装与回退

将 v0.1.13 解压到 v0.1.12 同级的新目录并继续复用 `../data`，不要覆盖旧目录。关闭旧助手及其可见 Chrome 后，再从新目录双击 `start-collector.cmd`；验证完成前保留 v0.1.12 用于回退。
