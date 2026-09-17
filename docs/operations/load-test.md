# 2 核 4GB 服务器低并发验收

在 staging 或低峰期运行，不直接压测真实抖音页面。先执行 `node scripts/load-test.mjs --duration 300 --concurrency 4`，同时每 5 秒记录一次 `sh scripts/observe-production-load.sh .env.production` 和阿里云 RDS 连接/CPU 指标。

接受阈值：HTTP 错误率低于 1%，p95 低于 800ms；整机 CPU 连续 5 分钟低于 70%，全部容器内存总量低于 3GB且无 OOM/重启；RDS 连接少于实例上限 80%；后台任务 `queued + retry` 在停止入流后持续下降且 10 分钟内回到基线。worker 默认并发 1，确认稳定后才能升到 2。

验收还需同时确认：Compose 只有网关映射 80/443；服务器 `top` 不出现 Chrome/Chromium/Playwright；API 日志只出现 OSS 签名与确认请求，不出现图片请求体；Windows collector 的 PUT 目标 host 是 OSS endpoint。记录日期、镜像 digest、流量参数、p95/错误率、CPU 峰值、内存峰值、队列开始/结束值和结论。
