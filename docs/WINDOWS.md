# 在 Windows 上跑起来 / 出安装包

两条路，按你的目的选：

- **A. 只想看界面、聊两句** → 跟着「一、装环境」+「二、跑起来」走（约 15 分钟，其中构建运行时几分钟）
- **B. 要出能发给用户的安装包** → 再加「三、出安装包」

> ⚠️ **最重要的一条**：`runtime/`（核心运行时）**必须在目标平台上构建**。
> 在 NAS/Linux 上建的 `runtime/venv` 拿到 Windows 用不了（venv 里是 Linux 的 python 与二进制依赖）。
> 所以 Windows 上要本地跑一次 `build-runtime.ps1`。

---

## 一、装环境（只做一次）

用 **PowerShell**（Win10/11 自带）。推荐 `winget`：

```powershell
winget install OpenJS.NodeJS.LTS          # Node 20/22+（Electron 40 需要）
winget install Python.Python.3.12         # Python 3.11–3.13 都行，3.12 最稳
winget install Git.Git                    # git（也可直接下 ZIP，见下）
```

装完**关掉再重开 PowerShell**（让 PATH 生效），验证：

```powershell
node -v      # 期待 v20.x / v22.x
python -V    # 期待 Python 3.12.x
git --version
```

> Git 不是必须的：也可以直接在 GitHub 页面上 **Code → Download ZIP** 下载解压。

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

# 4) 自检（不需要图形界面；25 项断言应全绿）
$env:HERMES_HOME = "$env:TEMP\24h-smoke"
npm run smoke

# 5) 起界面
npm run dev
```

**首次在应用里要做的**：右上角 **设置** → 选服务商 → 填 **API Key** → 保存 → 回对话页发一句。
（壳把用户数据放在 `%APPDATA%\24H\hermes`，与你的其它 Hermes 安装互不干扰。）

### 常见卡点

| 现象 | 原因 / 处理 |
|---|---|
| `npm install` 只装了几十个包、`electron` 没装上 | `NODE_ENV=production` 会让 npm 跳过 devDependencies。按上面设成 `development` 并加 `--include=dev` |
| Electron 下载很慢/超时 | 必须设 `ELECTRON_MIRROR`（上面给了 npmmirror 地址） |
| `build-runtime.ps1` 报找不到 python 3.11–3.13 | 用 `-Python` 显式指定，例如 `-Python "C:\Python312\python.exe"` |
| `tar` 不存在 | Win10 1803+ 自带 `tar.exe`；老系统需装 Git for Windows 后用 Git Bash 跑 `scripts/build-runtime.sh` |
| pip 装依赖很慢/失败 | 默认走阿里云镜像；可加 `-Mirror https://pypi.tuna.tsinghua.edu.cn/simple/` |
| `npm run smoke` 报错误码 5032 | 正常 —— 表示还没配模型；这一步只验证协议通路 |
| 杀软拦 node/python 子进程 | 首次运行时允许；企业管控环境把 `C:\dev\24H-OS` 与 `%APPDATA%\24H` 加白 |

---

## 三、出安装包（要发给用户时）

```powershell
# 前提：第二步的 runtime\ 已构建好（安装包会把它一起打包进去）
npm run dist            # = electron-builder --win nsis → release\24H-0.1.0-x64.exe
```

产物在 `release\`。**发布前必须补两样**：

1. **图标**：放 `build\icon.ico`（256×256），否则用 Electron 默认图标；
2. **代码签名证书**：没有它用户会遇到 SmartScreen "未知发布者" 拦截。在 `package.json` 的
   `build.win` 里配 `certificateFile` / `certificatePassword`（或交给 CI 的环境变量）。

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
