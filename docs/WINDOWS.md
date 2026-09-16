# 在 Windows 上跑起来 / 出安装包

两条路，按你的目的选：

- **A. 只想看界面、聊两句** → 跟着「一、装环境」+「二、跑起来」走（约 15 分钟，其中构建运行时几分钟）
- **B. 要出能发给用户的安装包** → 再加「三、出安装包」

> ⚠️ **最重要的一条**：`runtime/`（核心运行时）**必须在目标平台上构建**。
> 在 NAS/Linux 上建的 `runtime/venv` 拿到 Windows 用不了（venv 里是 Linux 的 python 与二进制依赖）。
> 所以 Windows 上要本地跑一次 `build-runtime.ps1`。

---

## 一、装环境（只做一次）

用 **PowerShell**（Win10/11 自带）。

### 方式 1：winget（先修源）

`winget` 默认会去查 `msstore` 源；该源在国内常解析不到，于是报
`WinHttpSendRequest: 12007 无法解析服务器的名称或地址 (0x80072ee7)` —— **包本身没问题**，只是要指定源：

```powershell
# 一劳永逸：禁掉用不上的 msstore 源
winget source remove msstore

winget install OpenJS.NodeJS.LTS      # Node 20/22+
winget install Python.Python.3.12     # Python 3.11–3.13，3.12 最稳
winget install Git.Git
```

或每次显式指定源（不删源也行）：

```powershell
winget install --source winget --accept-package-agreements --accept-source-agreements OpenJS.NodeJS.LTS
```

### 方式 2：直接下镜像安装器（winget 装得慢/失败时用这个）

以下三个地址**实测可达**（npmmirror 镜像），双击安装即可。装 Python 时务必勾选
**Add python.exe to PATH**；Git 用默认选项。

| 组件 | 下载地址 |
|---|---|
| Node.js 22.20.0 (x64) | `https://registry.npmmirror.com/-/binary/node/latest-v22.x/node-v22.20.0-x64.msi` |
| Python 3.12.9 (amd64) | `https://registry.npmmirror.com/-/binary/python/3.12.9/python-3.12.9-amd64.exe` |
| Git for Windows 2.55.0 | `https://registry.npmmirror.com/-/binary/git-for-windows/v2.55.0.windows.1/Git-2.55.0-64-bit.exe` |

PowerShell 里直接下：

```powershell
cd $env:USERPROFILE\Downloads
curl.exe -L -o node.msi  https://registry.npmmirror.com/-/binary/node/latest-v22.x/node-v22.20.0-x64.msi
curl.exe -L -o python.exe https://registry.npmmirror.com/-/binary/python/3.12.9/python-3.12.9-amd64.exe
curl.exe -L -o git.exe   https://registry.npmmirror.com/-/binary/git-for-windows/v2.55.0.windows.1/Git-2.55.0-64-bit.exe
# 然后逐个双击安装
```

装完**关掉再重开 PowerShell**（让 PATH 生效），验证：

```powershell
node -v      # 期待 v22.x
python -V    # 期待 Python 3.12.x
git --version
```

> Git 不是必须的（只是用来 clone）：也可以在 GitHub 页面上 **Code → Download ZIP** 下载解压。

---

## 二、跑起来（开发模式）

```powershell
# 1) 拿代码（路径别带空格和中文，后面 Python/NSIS 都会舒服很多）
cd C:\dev
git clone https://github.com/wenchao1982/24H-OS.git
cd 24H-OS

# 2) 装 Node 依赖（三个要点：NODE_ENV 必须是 development、要 --include=dev、Electron 走国内镜像）
$env:NODE_ENV = "development"
$env:ELECTRON_MIRROR = "https://registry.npmmirror.com/-/binary/electron/"
npm install --include=dev

# 3) 构建随包运行时（拉核心源码 + 装依赖，几分钟；产物 runtime\ 约 300–400 MB）
powershell -ExecutionPolicy Bypass -File scripts\build-runtime.ps1 -Ref main

# 4) 自检（不需要图形界面；36 项断言应全绿）
npm run smoke          # 默认就写临时 home，不会动你自己的 Hermes 配置

# 4b) 界面层冒烟（可选：用无头浏览器验「弹层关得掉、列表加载得上」）
$env:CHROME = "C:\dev\chrome-headless-shell\chrome-headless-shell.exe"
npm run ui-smoke       # 没装 puppeteer-core / 没设 CHROME 就自动跳过，不算失败

# 5) 起界面
npm run dev
```

**首次在应用里要做的**：右上角 **设置** → 选服务商 → 填 **API Key** → 保存 → 回对话页发一句。
（壳把用户数据放在 `%APPDATA%\24H\hermes`，与你的其它 Hermes 安装互不干扰。）

### 常见卡点

| 现象 | 原因 / 处理 |
|---|---|
| 设置里"服务商"只有 Mixture of Agents / OpenCode Free，填 Key 报 `保存 Key 失败：unknown provider: moa` | 这两个是虚拟/内置 provider，不接受 API Key。老版本壳用 `model.options`（不带 `include_unconfigured=1`）取目录，全新安装时只能看到它们。现已改为取完整目录并只列"可填 Key"的服务商（DeepSeek）；拉最新代码即可 |
| `npm install` 只装了几十个包、`electron` 没装上 | `NODE_ENV=production` 会让 npm 跳过 devDependencies。按上面设成 `development` 并加 `--include=dev` |
| Electron 下载很慢/超时 | 必须设 `ELECTRON_MIRROR`（上面给了 npmmirror 地址） |
| `build-runtime.ps1` 报找不到 python 3.11–3.13 | 用 `-Python` 显式指定，例如 `-Python "C:\Python312\python.exe"` |
| `tar` 不存在 | Win10 1803+ 自带 `tar.exe`；老系统需装 Git for Windows 后用 Git Bash 跑 `scripts/build-runtime.sh` |
| pip 装依赖很慢/失败 | 默认走阿里云镜像；可加 `-Mirror https://pypi.tuna.tsinghua.edu.cn/simple/` |
| `npm run smoke` 报错误码 5032 | 正常 —— 表示还没配模型；这一步只验证协议通路 |
| `npm install` 提示 `electron@40.10.2 (postinstall: node install.js)` **未被 allowScripts 覆盖** | npm 11 默认拦截依赖安装脚本 → Electron 二进制没下载，`npm run dev` 会失败。见下方「Electron 二进制」小节 |
| `curl` 报 `CRYPT_E_NO_REVOCATION_CHECK (0x80092012)` | Windows 版 curl 走 schannel，CRL/OCSP 不可达时如此。加 `--ssl-no-revoke`（`build-runtime.ps1` 已内置） |
| `npm : 无法加载文件 ... npm.ps1，因为在此系统上禁止运行脚本` | PowerShell 执行策略。`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned -Force`，或改用 `npm.cmd` |
| 杀软拦 node/python 子进程 | 首次运行时允许；企业管控环境把 `C:\dev\24H-OS` 与 `%APPDATA%\24H` 加白 |
| 界面显示「核心 启动中…」很久不动 | 首次启动要建运行时环境 + 被 Defender 扫 300MB 运行时，可能 1–2 分钟。点右上「日志」看核心输出；超过 3 分钟（壳的超时）会弹红色横幅并给「重试」。建议把项目目录与 `%APPDATA%\24H` 加入 Defender 排除项 |

### 界面层冒烟要的那个无头浏览器（可选）

`npm run ui-smoke` 用真浏览器（不需要图形界面）打开 `src/index.html`，专测协议层测不到的界面问题
（弹层藏没藏住、点关闭关不关得掉、核心晚就绪时列表会不会一直转圈）。要两份东西：

```powershell
# ① puppeteer-core（只是驱动，很小；走国内镜像）
npm i -D puppeteer-core --registry=https://registry.npmmirror.com --no-audit --no-fund
# ② chrome-headless-shell（win64，约 120MB，解压即用，不用装浏览器）
curl.exe --ssl-no-revoke -L -o hs.zip https://cdn.npmmirror.com/binaries/chrome-for-testing/141.0.7390.65/win64/chrome-headless-shell-win64.zip
Expand-Archive -Path .\hs.zip -DestinationPath C:\dev -Force
$env:CHROME = "C:\dev\chrome-headless-shell-win64\chrome-headless-shell.exe"
npm run ui-smoke
```

### 让 Windows Defender 别拖慢启动（强烈建议）

```powershell
# 以管理员 PowerShell 运行
Add-MpPreference -ExclusionPath "C:\dev\24H-OS"
Add-MpPreference -ExclusionPath "$env:APPDATA\24H"
```

首次启动时 Defender 会逐个扫描运行时里的几万个文件，这是"核心启动中"卡很久的头号原因。

### Electron 二进制没装上怎么办

`npm install` 结尾如果出现：

```
npm warn allow-scripts 2 packages have install scripts not yet covered by allowScripts:
npm warn allow-scripts   electron@40.10.2 (postinstall: node install.js)
```

说明 npm 11 的脚本审批机制拦住了 Electron 的 postinstall（**二进制没下载**）。任一方式解决：

```powershell
# 方式 1：批准后重建
npm approve-scripts electron
npm approve-scripts electron-winstaller
npm rebuild electron

# 方式 2：直接跑它的安装脚本（记得带镜像变量）
$env:ELECTRON_MIRROR = "https://registry.npmmirror.com/-/binary/electron/"
node .\node_modules\electron\install.js

# 验证（能打印版本号就成功）
.\node_modules\electron\dist\electron.exe --version
```

> 本仓库的 `package.json` 已经用 `allowScripts` 预先批准了这两个包；如果你的 npm 版本更早有这个提示，
> 按上面任一方式处理即可。

---

## 三、出安装包（要发给用户时）

```powershell
# 前提：第二步的 runtime\ 已构建好（安装包会把它一起打包进去）
npm run dist            # = electron-builder --win nsis → release\24H-0.1.0-x64.exe
npm run verify:package  # 产物体检：asar / 随包运行时 / 安装包名字与 sha256
```

产物在 `release\`。打包过程有**两道自动检查**（不通过直接报错，不会静默出一个坏包）：

- `scripts/after-pack.mjs`（electron-builder 的 afterPack 钩子）：检查 asar 里有没有壳的入口文件、
  `resources\runtime\` 里有没有核心源码树 + venv + 运行时清单，并打印运行时的核心版本与体积。
  **故意跳过**运行时检查用 `$env:SKIP_RUNTIME_CHECK = "1"`（例如只想快速验证界面）。
- `npm run verify:package`：检查解包目录与安装包，并**真的把随包 python 拉起来 import 一次核心包**
  （venv 是可搬迁的，文件在 ≠ 能跑）。

### 3.1 图标

`build\icon.png` 是 1024×1024 母版，`build\icon.ico` 由它生成（含 16/24/32/48/64/128/256 七个尺寸）。
换品牌只改母版：

```powershell
python -m pip install pillow        # 国内：--index-url https://mirrors.aliyun.com/pypi/simple/
npm run icons                       # 从 build\icon.png 重新生成 build\icon.ico
```

### 3.2 代码签名（用户不看到"未知发布者"的前提）

拿证书：国内可用沃通/天威诚信的 OV 代码签名证书，或直接用微软 **Azure Trusted Signing**
（不用自己管 .pfx，适合 CI）。**没有签名，用户第一次装包一定会看到 SmartScreen 拦截。**

配置已经写好（`package.json` 的 `build.win.signtoolOptions`：sha256 + RFC3161 时间戳），
证书本身**走环境变量，不要写进仓库**：

```powershell
# 方式 1：本地出签名包（.pfx + 口令）
$env:WIN_CSC_LINK = "C:\path\to\cert.pfx"      # 也可以是 https 地址或 base64
$env:WIN_CSC_KEY_PASSWORD = "口令"
npm run dist

# 方式 2：Azure Trusted Signing（在 build.win.azureSignOptions 里填 endpoint/账号/证书配置文件，
#          并先 az login）—— 细节以 electron-builder 文档为准
```

验签（装包前后都能查）：

```powershell
Get-AuthenticodeSignature .\release\24H-0.1.0-x64.exe | Format-List Status, SignerCertificate
# Status 期望 Valid
```

内测阶段允许不签名：`build.win.forceCodeSigning` 保持 `false`；要"没签名就不许出包"，
命令行加 `-c.win.forceCodeSigning=true`。

安装包的行为（已在配置里写好）：

- 安装时把 `display.language: zh` 写进 `%APPDATA%\24H\hermes\config.yaml` → **用户装完即是中文**（已存在配置不覆盖）；
- 非一键安装、可改安装目录、开始菜单快捷方式名 `24H`；
- 卸载**不删**用户数据（保留 `%APPDATA%\24H`），提示保留位置。

---

## 四、以后换核心版本怎么办

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-runtime.ps1 -Ref <上游 ref 或 tag>
npm run smoke      # 先跑闸门，确认壳与新核心仍兼容（契约版本/事件/错误码）
npm run dev
```

`npm run smoke` 就是你的**升级闸门**：25 项断言覆盖启动握手、鉴权、会话生命周期、事件流、
错误码与文件接口 —— 换核心后先跑它，比手工点界面靠谱。
