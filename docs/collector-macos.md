# macOS 抖音采集助手

macOS 助手与 Windows 助手使用相同的团队任务和本地控制页。设备令牌保存在当前 macOS 用户的“钥匙串访问”中；抖音 Cookie、验证码和独立浏览器画像仍只保存在本机。

## 普通用户首次启动

1. 领取文件名含 `macos-universal` 的 `.tar.gz` 通用包及 `.sha256` 文件。该包同时兼容 Apple Silicon（M1/M2/M3/M4 等）和 Intel。
2. 安装 Google Chrome，然后完整解压发布包；不要直接在压缩包内运行。
3. 核对管理员提供的 SHA256。文件名和校验值必须完全一致。
4. 双击 `start-collector.command`。首次打开若被 Gatekeeper 拦截，先确认校验值，再在 Finder 中按住 Control 点击该文件，选择“打开”；不要对来源不明的软件关闭系统安全保护。
5. 浏览器会打开 `http://127.0.0.1:43127`。输入设备名称和管理员生成的一次性配对码，直到页面显示“已连接团队”。
6. 创建并选择独立推荐圈层画像，点击“打开抖音登录”，在可见 Chrome 中人工登录并处理验证码。
7. 在管理后台创建运行，回到本机控制页刷新任务并点击“人工开始”。服务器不会远程启动本机浏览器。

正式包内已经包含 Node.js、非秘密连接配置和必要的公开 CA，普通用户不需要安装 Node、npm、Python 或编译工具。必须保持启动后的“终端”窗口开启；关闭窗口会停止助手。

## 升级

1. 暂停或终止当前运行，等待待同步队列清空，再关闭助手终端窗口。
2. 将新版本解压到旧版本同级的新目录，不要覆盖旧版本。
3. 不要复制旧版配置；新包已经包含可见的 `collector.env`，并继续使用同级的 `../data` 数据目录。
4. 启动新版本，确认配对、画像和待同步数量正常。
5. 验证完成前保留旧版本目录。钥匙串令牌与数据目录绑定，不要复制给其他 macOS 用户或其他电脑；换电脑应重新配对。

## 架构兼容

- Apple Silicon 启动时自动选择包内 `runtime/arm64/node`。
- Intel 启动时自动选择包内 `runtime/x64/node`。

普通用户不需要判断或选择架构。管理员仍须分别在 Apple Silicon 和 Intel 真机上验证同一个通用包；一类机器通过不代表另一类已经验收。

## 管理员构建

构建必须在 macOS 上进行，以保留两套运行时和 `.command` 文件的可执行权限。构建机需要 Node.js 22.12+、npm、Xcode Command Line Tools 和 Chrome。以下命令构建当前 IP + 自签名证书环境的通用包：

```bash
cd /path/to/douyin_couple_scraper
npm ci --ignore-scripts --no-audit --no-fund
bash scripts/build-collector-macos.sh \
  --version 0.1.3 \
  --architecture universal \
  --api-base-url 'https://106.12.56.109' \
  --ca-certificate 'release/collector-server-ca.pem'
```

脚本会从 Node.js 官方站点分别下载 `arm64` 和 `x64` 固定版本运行时，使用官方 `SHASUMS256.txt` 逐一校验后放进同一个包；不会把数据库、OSS 或生产环境秘密写入发布包。`--architecture arm64` 或 `x64` 仍可用于内部诊断，但正式分发使用 `universal`。

使用公开可信 CA 的域名时省略 `--ca-certificate`。自签名环境只能携带公开服务器证书，不能打包私钥，也不能关闭 TLS 验证。

## 真机冒烟验证

先在 Apple Silicon Mac 上运行，再将同一个包复制到 Intel Mac 重复运行：

```bash
cd /path/to/douyin_couple_scraper
bash scripts/test-collector-macos-package.sh \
  --package 'artifacts/collector-macos-universal-v0.1.3.tar.gz'
```

验证内容包括：包内 Node 可执行、Keychain 设备令牌往返、独立画像创建、可见 Chrome 启动和本地控制页。测试使用临时数据目录，结束时删除对应的测试钥匙串项目。若测试机暂时没有 Chrome，可以加 `--skip-visible-chrome` 做不完整检查，但该结果不能作为正式发布验收。

自动测试通过后，还必须用一个真实的一次性配对码完成小范围人工试运行。面向不熟悉终端的外部用户大规模分发前，建议进一步制作 Developer ID 签名并经 Apple 公证的 `.app`/`.dmg`；当前 `.command` 包适用于已知来源、已核对 SHA256 的团队内分发。

## 常见问题

### 双击后提示没有权限

管理员先确认包是在 macOS 上构建且真机冒烟脚本已通过。不要用 Windows 解压后重新压缩，因为这会丢失 Unix 可执行权限。

### 系统提示无法验证开发者

先向管理员核对 SHA256；一致时使用 Finder 的 Control + 点击“打开”。不要运行网上提供的全局关闭 Gatekeeper 命令。

### 钥匙串弹出授权提示

首次保存或读取设备令牌时，macOS 可能要求解锁当前登录钥匙串，这是正常行为。不要把钥匙串密码或设备令牌发给管理员。

### 页面打不开或显示 `fetch failed`

确认终端窗口仍在运行，检查 43127 端口、电脑代理/Fake-IP、服务器地址和 TLS 证书。禁止使用关闭证书校验的方式绕过错误。
