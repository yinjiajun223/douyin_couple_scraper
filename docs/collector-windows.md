# Windows 抖音采集助手

## 首次启动

1. 解压版本包，不要直接在压缩包内运行。
2. 管理员预配置的正式包已经内置服务器地址，并附带可见的 `collector.env` 供故障核对；普通用户不需要创建或修改任何配置文件。默认数据目录是版本目录外的 `../data`，升级时不会覆盖登录画像、DPAPI 设备令牌或待同步队列。
3. 双击 `start-collector.cmd`。启动器只使用包内 `runtime/node.exe`，不要求电脑预装 Node.js。
4. 打开 `http://127.0.0.1:43127`，输入设备名称和管理员生成的一次性配对码，确认“已连接团队”。创建并选择独立推荐圈层画像。
5. 点击“打开抖音登录”，先人工完成登录并确认推荐内容；验证码只能人工处理，这一步不会开始采集。
6. 在管理后台保存筛选任务并“创建运行”，回到本地控制页刷新任务。低可信度页面默认永不导致暂停，也可主动设置连续暂停次数；运行中可以即时修改。该设置不降低 0.75 解析阈值，低可信度页面始终跳过且不入库。只有本地明确开始或继续才会执行采集，后台创建任务、自动刷新和助手重启均不会自动采集。
7. 同步或证据上传失败时，先修复网络/OSS，再继续原运行。本机有待同步证据时不要删除数据目录、换画像或重新配对。

源码本地调试请按 `docs/local-development.md` 使用 `npm run dev:local`，不要同时启动分发包。本轮源码改动不代表已有 ZIP 已更新，分发前须重新打包和执行冒烟验证。

## 升级

1. 先在本地控制页暂停或终止当前任务，等待待同步队列清空，再关闭采集助手窗口。
2. 将新版本解压到与旧版本同级的新目录，不要覆盖旧目录。
3. 不要复制旧版配置；新包已经内置当前服务器地址。确认新版本仍使用同级的 `../data` 数据目录。
4. 启动新版本，确认画像、配对状态和待同步数量正常。服务端若要求更高版本，旧版本只显示升级阻断，不会继续提交。
5. 新版本验证完成前保留旧版本目录；需要回退时关闭新版本并重新启动旧版本。不得复制或共享 `data/secrets/device-token.dpapi`，该文件只能由原 Windows 用户解密。

## 打包与冒烟验证

在仓库根目录执行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build-collector-windows.ps1 `
  -ApiBaseUrl "https://ops.example.com" `
  -CaCertificatePath "release/collector-server-ca.pem"
powershell -ExecutionPolicy Bypass -File scripts/test-collector-windows-package.ps1 -PackagePath artifacts/collector-windows-v0.1.4.zip
powershell -ExecutionPolicy Bypass -File scripts/test-collector-windows-launcher.ps1 -PackagePath artifacts/collector-windows-v0.1.4.zip
```

`CaCertificatePath` 只接受公开 CA/服务器证书，构建器会将它作为 `NODE_EXTRA_CA_CERTS` 随包分发，不得打包私钥。使用公开可信 CA 的域名时可以省略此参数。

冒烟脚本在全新临时目录中使用包内 Node，验证 DPAPI 配对令牌、持久画像、可见 Chrome 启动以及本地控制页。测试数据完成后删除，不读取系统 Chrome/Edge 日常画像。

启动器测试会真实运行 `start-collector.cmd`，确认 CMD 在采集器运行期间保持打开，且本地控制服务就绪。启动器不再使用固定延迟打开页面；采集器监听成功后才调用默认浏览器。若进程异常退出，CMD 会保留错误信息并等待用户确认。

`artifacts/` 仅用于本机构建并保持 Git 忽略。正式分发包及 SHA256 应由仓库的 `Collector release` Actions 工作流上传到 GitHub Releases；不要把 ZIP 直接提交到源码历史，也不要只依赖某一台构建电脑长期保存。
