# Windows 抖音采集助手

## 首次启动

1. 解压版本包，不要直接在压缩包内运行。
2. 管理员预配置的正式包已经包含 `.env`，普通用户无需修改；若包中没有 `.env`，再将 `.env.example` 复制为 `.env` 并填写公司的 HTTPS 管理后台地址。默认数据目录是版本目录外的 `../data`，升级时不会覆盖登录画像、DPAPI 设备令牌或待同步队列。
3. 双击 `start-collector.cmd`。启动器只使用包内 `runtime/node.exe`，不要求电脑预装 Node.js。
4. 打开 `http://127.0.0.1:43127`，输入设备名称和管理员生成的一次性配对码，确认“已连接团队”。创建并选择独立推荐圈层画像。
5. 点击“打开抖音登录”，先人工完成登录并确认推荐内容；验证码只能人工处理，这一步不会开始采集。
6. 在管理后台保存筛选任务并“创建运行”，回到本地控制页刷新任务。低可信度页面默认永不导致暂停，也可主动设置连续暂停次数；运行中可以即时修改。该设置不降低 0.75 解析阈值，低可信度页面始终跳过且不入库。只有本地明确开始或继续才会执行采集，后台创建任务、自动刷新和助手重启均不会自动采集。
7. 同步或证据上传失败时，先修复网络/OSS，再继续原运行。本机有待同步证据时不要删除数据目录、换画像或重新配对。

源码本地调试请按 `docs/local-development.md` 使用 `npm run dev:local`，不要同时启动分发包。本轮源码改动不代表已有 ZIP 已更新，分发前须重新打包和执行冒烟验证。

## 升级

1. 先在本地控制页暂停或终止当前任务，等待待同步队列清空，再关闭采集助手窗口。
2. 将新版本解压到与旧版本同级的新目录，不要覆盖旧目录。
3. 复制旧版本 `.env` 到新目录。确认 `COLLECTOR_DATA_DIR` 仍指向同一个版本外数据目录。
4. 启动新版本，确认画像、配对状态和待同步数量正常。服务端若要求更高版本，旧版本只显示升级阻断，不会继续提交。
5. 新版本验证完成前保留旧版本目录；需要回退时关闭新版本并重新启动旧版本。不得复制或共享 `data/secrets/device-token.dpapi`，该文件只能由原 Windows 用户解密。

## 打包与冒烟验证

在仓库根目录执行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build-collector-windows.ps1 `
  -ApiBaseUrl "https://ops.example.com" `
  -CaCertificatePath "release/collector-server-ca.pem"
powershell -ExecutionPolicy Bypass -File scripts/test-collector-windows-package.ps1 -PackagePath artifacts/collector-windows-v0.1.1.zip
```

`CaCertificatePath` 只接受公开 CA/服务器证书，构建器会将它作为 `NODE_EXTRA_CA_CERTS` 随包分发，不得打包私钥。使用公开可信 CA 的域名时可以省略此参数。

冒烟脚本在全新临时目录中使用包内 Node，验证 DPAPI 配对令牌、持久画像、可见 Chrome 启动以及本地控制页。测试数据完成后删除，不读取系统 Chrome/Edge 日常画像。
