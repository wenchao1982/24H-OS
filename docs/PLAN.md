# 24H-OS 制作方案（v1）

> 说明：本方案基于对两个成熟产品的**源码实测**（不是文档转述）。文中所有数字和结论都标了出处：
> `路径:行号` 指代码位置，`命令 → 输出` 指本机实测。凡是我没有验证过的，都会写明"未验证"。
>
> 调研对象与坐标（2026-09-16）：
>
> | 代号 | 项目 | 版本 / 位置 |
> |---|---|---|
> | **核心** | Hermes Agent（上游 Python 核心，MIT） | 0.21.3，`~/24H-OS/runtime/core`（随包运行时里的源码树） |
> | **上游桌面** | Hermes Desktop（上游官方 Electron 壳） | 0.17.3 / Electron 40.10.2，`<核心>/apps/desktop` |
> | **Studio** | Ekko Studio（`EKKOLearnAI/hermes-studio`，Vue3+Koa+Electron） | 0.7.22，本地解包 `/tmp/src/hermes-studio-main` |
> | **我们** | 24H-OS | 0.1.0，`~/24H-OS` |

---

## 0. 摘要（先看这一页）

**形态**：24H-OS = **自研薄壳（Electron）+ 上游 Hermes 核心（外部运行时，不 fork）**。
我们不重写 agent，只做"运行时可分发 + 中文可用 + 桌面产品化"这三件事。

**三条已经验证的底座结论**（决定了后面的所有决策）：

1. **核心的能力面远大于我们已用的部分**：核心契约里有 **217 个 gateway 方法 / 69 个事件 / 12 个服务端请求**（实测 `tui_gateway.contracts.registry`），24 个 REST 路由文件里 **227 个端点**（`grep -c '@router\.(get|post|...)' hermes_cli/web_routers/*.py`）。
   我们目前只用了 **15 个方法（7%）、11 个事件（16%）、9 个 REST 端点**。
   → 产品路线应当以"把核心已有能力搬进 UI"为主，而不是自研功能。
2. **两种成熟壳走了两条路**：上游桌面把协议数据面**藏在主进程后面**（255 个 IPC 通道、`main.ts` 18,443 行）；Studio 把数据面**放在本地回环 Web 服务后面**（桌面 preload 只有 179 行，只管 token/窗口/浏览器/通知）。
   → 我们保留"IPC 代理"这条路（已跑通、可控），但**把 `window.hermes` 抽象成可替换传输层**，为将来"同一套 UI 也能当网页版/远程版"留口。
3. **运行时分发有三种做法**，各有代价（§5.1 详述）：随包内置（我们现在，371MB）、首启安装（上游桌面，thin installer）、首启下载（Studio，`hermes-<ver>-runtime` 资产）。
   → 近期保留随包（离线可用、国内网络最省事），中期加减量通道，**两者共用一套"运行时清单"**。

**五条拍板决策**：

| # | 决策 | 一句话依据 |
|---|---|---|
| R1 | 核心**不 fork**，差异只做在壳侧与插件包 | Studio 的原话："Do not patch tracked Hermes source during this build: Studio-specific integration belongs in Studio, and the clean checkout is what allows users to run the upstream `hermes update` command directly."（`ARCHITECTURE.md` 桌面运行时一节） |
| R2 | 契约**类型化**进壳（至少覆盖我们用的方法与事件） | 已因参数名写错踩过坑（`model.save_key` 的参数是 `slug` 不是 `provider`）；上游把契约从 Python 生成 TS（`scripts/gen_gateway_contracts.py` → 5,087 行 `gateway-contract.generated.ts`） |
| R3 | 运行时做成**可独立升级的资产**，并记清单（版本/ref/commit/平台/sha256） | Studio `runtime-config.mjs` 强制 version+ref+commit 三者原子且必须是 40 位 commit；`package-runtime.mjs` 产出 `.tar.gz + .sha256 + manifest schema 2` |
| R4 | 壳与核心**双向版本对齐** | 已有 `desktop_contract` 告警条；再补运行时清单里的 coreVersion 校验（换核心不静默） |
| R5 | 质量工程**三层验证**：协议层 / 界面层 / 打包层 | 上游有真装真验的打包测试（`scripts/test-desktop.mjs` 支持 dmg/nsis/fresh/existing）；Studio 在 `afterPack` 校验打包产物（`verify-packaged-webui.mjs`）。我们已有前两层，缺第三层 |

**商业化**：核心契约里**已内置账号/计费/订阅/免费额度**的方法族（`billing.*` 5 个、`subscription.*` 5 个、`free_tier.*` 3 个）。
**已实测（2026-09-16）**：方法本身没有开关、都能调，但数据与操作全部指向 Nous 官方云
（`portal.nousresearch.com`，token 取本机 provider `nous` 的登录态）；无账号只能拿到空态。
→ 结论与三条路见 [`CORE-CONTRACT.md`](CORE-CONTRACT.md)：二期优先评估"自建门户兼容后端"（基址是环境变量，核心零改动）。

---

## 1. 上游核心（Hermes Agent 0.21.3）架构解读

### 1.1 进程与入口

- 壳启动核心的命令：`hermes serve --host 127.0.0.1 --port 0`（端口 0 = 核心自选）。
  上游壳里等价代码：`apps/desktop/electron/backend-command.ts:21` `return [...head, 'serve', '--host', '127.0.0.1', '--port', '0']`。
- 就绪信号：核心往 stdout 打 `HERMES_(BACKEND|DASHBOARD)_READY port=<N>`；
  上游的解析器 `apps/desktop/electron/backend-ready.ts:6` 用 `^` 锚定的正则，`:12` 用 token 边界版（`(?<!\w)HERMES_...`）——因为子进程输出会被合并/拼接，`^` 会失配（注释里记了 issue #103792）。
- 鉴权：`GET /` 的 HTML 内联 `window.__HERMES_SESSION_TOKEN__`；REST 用 `Authorization: Bearer`；WS 用 `?token=`。

### 1.2 两个数据面：REST 与 gateway(WS JSON-RPC)

| 面 | 位置 | 规模（实测） | 用途 |
|---|---|---|---|
| REST | `hermes_cli/web_routers/*.py`（24 个文件） | **227 个端点** | 文件、配置、模型设置、搜索、健康检查… |
| gateway | `hermes_cli/web_routers/chat_ws.py:569 @router.websocket("/api/ws")` | **217 方法 / 69 事件 / 12 服务端请求** | 会话、对话、审批、工具、插件、项目、账号… |

**契约是"核心定义、客户端消费"**：契约模型写在 `tui_gateway/contracts/`（pydantic），
由 `scripts/gen_gateway_contracts.py` 生成 TS + OpenRPC 给桌面用：
`apps/shared/src/gateway-contract.generated.ts`（**5,087 行**）、`gateway-events.ts`（52 行）。
→ 这是"壳可以不猜协议"的机制保障。

### 1.3 能力面清单（按方法族，实测计数）

```
session 30   groups 18   pet 15   projects 15   mcp 11   profiles 7   vault 7
wake 6   billing 5   subscription 5   browser 5   subagent 4   image 4
bot_relay 4   learning 4   handoff 3   connectors 3   config 3   free_tier 3
model 3   prompt 3   approval 3   voice 3   spawn_tree 3   process 3   …
```

对我们直接有用的族：

- `session.*`（30）：会话全生命周期（create/list/history/resume/interrupt/close/delete/title/cwd.set/usage/undo/compress/branch/foreign.import…）
- `model.*` / `config.*` / `profiles.*`：模型、配置、多身份
- `projects.*`（15）：把"工作目录"升级成"项目"（含 repo 发现、树、活跃项目）
- `tools.*` / `toolsets.*` / `plugins.*` / `skills.*` / `mcp.*`：工具与扩展
- `approval.*`（3）：危险命令审批（要弹 UI）
- `voice.*`（3）：录音/tts
- `billing.*` / `subscription.*` / `free_tier.*`：账号与计费（商业化二期）
- `usage.bars` / `insights.*` / `learning.*`：用量与"越用越懂你"

### 1.4 扩展资产（决定我们的差异化空间）

- 模型服务商插件：`plugins/model-providers/` **40 个**（含 deepseek/alibaba/minimax/xiaomi/zai/stepfun/kimi 等）。
- 技能：`skills/` **14 类**（apple、devops、creative、autonomous-ai-agents…）。
- 这两类都是"目录即插件"的形态 → 我们可以**只加不减**（加国产 provider/中文技能包），不动核心代码。

---

## 2. 上游官方桌面（apps/desktop 0.17.3）架构解读

### 2.1 规模（实测）

| 指标 | 数值 |
|---|---|
| 主进程 `electron/` | **344 个 TS 文件 / 90,420 行**，其中 `main.ts` **18,443 行** |
| 渲染层 `src/` | **2,115 个文件 / 477,802 行** |
| 预加载 `electron/preload.ts` | 574 行 |
| IPC 通道 | `hermes:*` 前缀 **255 个**；`main.ts` 里 124 处 `ipcMain.handle/on` |
| e2e | **45 个 Playwright spec** |
| i18n | 6 语言：en 4,503 行 / zh 4,401 行（另有 zh-hant、ja、ar、ru）；插件另有 `plugin-i18n.ts` |

### 2.2 关键机制（我们可以直接抄的）

1. **数据面在主进程后面**：渲染层不直连 HTTP。
   `preload.ts:261 api: request => ipcRenderer.invoke('hermes:api', request)` → `main.ts:16795 ipcMain.handle('hermes:api', …)`。
   好处：token 不出主进程、可做策略与审计、渲染层拿到的都是结构化结果。代价：通道数爆炸（255 个）、`main.ts` 变成 18k 行巨石。
2. **HTTP 传输策略被单独抽出来**（`electron/api-transport.ts`）：keep-alive 连接池（JSON 50 路 / 下载 8 路分开，避免大文件下载把交互请求挤死）；
   重试策略按动词区分——**非幂等动词只有在"确定没送到服务端"时才重试**（`ECONNRESET` 不重试，否则会重复提交 prompt）。
   → 我们的 `gateway.js`/`runtime.js` 目前没有这层，属于"低负载够用、高并发会疼"。
3. **后端生命周期是有状态机的**：`backend-ownership.ts`（355 行）单实例归属、`backend-claim`（抢注）、`backend-recycle`（回收）、
   `backend-release-gate.ts`（**更新前先把后端静默**，避免更新打断在跑的对话）。
4. **更新机制**：`electron/updater-process.ts`（469 行）+ `scripts/desktop-update/{windows.ps1,posix.sh,repro.sh}`（含失败重试策略 `retry-policy.ps1`）。
5. **安装器与"首启安装核心"**：`apps/bootstrap-installer` 是 **Tauri**（`src-tauri/tauri.conf.json`：productName `Hermes`、identifier `com.nousresearch.hermes.setup`、版本 0.21.1），
   配合 `build/install-stamp.json`（由 `scripts/write-build-stamp.mjs` 写入的 ref/commit），首启执行 `install.sh|ps1 --commit <SHA>`。
   **重要事实**：上游的 Windows 安装包**不再内置 Python 载荷**——`scripts/test-desktop.mjs:17-18` 注释写明"thin installer 只带 Electron 壳 + extraResources，Python 载荷改成首启拉取"。
6. **打包矩阵**：mac dmg+zip（`hardenedRuntime`、`notarize: true`）、win nsis+msi（`signAndEditExecutable: false`）、linux AppImage/deb/rpm；`nsis.oneClick=false, perMachine=false`。
7. **打包测试**：`scripts/test-desktop.mjs` 支持 `dmg / nsis / fresh / existing` 四种模式——**装真包、跑首启、验证已有数据升级**。
8. **设计系统**：`DESIGN.md` 定了 token、单一原语、三态（空/错/加载）、键盘与取消、动效与性能；
   原则原文可引："Tokens, not literals"、"One primitive per concern"、"Immediate feedback"（`DESIGN.md:25-` 起 Principles 1-7）。
9. **插件信任边界要说清楚**：渲染层插件是**全权限**加载的，`integrity` 只证明"字节没被换过"，**不是沙箱**
   （`src/contrib/runtime-loader.ts:24` 原文："`integrity` only proves the bytes match a hash — it does NOT sandbox"）。
   → 一期不做第三方插件市场。

### 2.3 代价（我们不要复制的部分）

- 18k 行的 `main.ts`、255 个通道：为云端账号、多 profile、群组、内置浏览器、宠物（pet.*）、计费等**大而全**需求付出的复杂度。我们现阶段用不上。
- 自带"浏览器/预览/宠物/群聊"这些重资产如果照搬，会让 5 个人月的产品变成 20 个人月。

---

## 3. Ekko Studio（0.7.22）架构解读

### 3.1 monorepo 边界（`ARCHITECTURE.md` 原文表格）

| 包 | 职责 |
|---|---|
| `packages/client` | Vue 3 UI、路由、Pinia、API 封装、i18n |
| `packages/server` | Koa HTTP API、鉴权、Socket.IO、SQLite、文件、**Hermes 运行时集成** |
| `packages/ekko-agent` | 自有 agent 运行时（profile/provider/tool/memory/skills） |
| `packages/desktop` | **Electron 壳、本地 Web UI 服务引导、更新器、随包 Python/Hermes 运行时** |
| `packages/skills` / `esp32-c3` | 技能与硬件端（边缘） |

服务端规模：**534 个 TS / 130,767 行**，模块目录 `modules/{studio,hermes,ekko,coding-agents}`；
长连接走 Socket.IO（命名空间实测：`/chat-run`、`/group-chat`、`/group-chat-agent-relay`、`/terminal`）；状态落 SQLite。

### 3.2 桌面壳怎么做的（关键差异）

- **预加载只有 179 行**，暴露的是 `window.hermesDesktop`：拿 token、窗口控制、系统通知、打开外部链接、内置浏览器标签页、宠物窗……
  （`packages/desktop/src/preload/index.ts:12-` 起，一条业务协议都没有）。
- **渲染层就是 Web UI**：主进程起一个本地 Koa 服务（`webui-server.ts`，随机回环端口 `webui-port.ts`，`getServerUrl()` → `http://127.0.0.1:<port>`），窗口加载它。
  → 同一套 UI 天然可做"网页版/远程版"。
- **驱动 Hermes 核心的方式不是 gateway，而是"agent bridge"**：Python 侧 `bridge_runtime/bridge_pool/bridge_broker/bridge_transport`，
  用 **Unix domain socket**（`ipc://…`；`bridge_transport.py` 里还专门处理了 macOS 104 / Linux 108 字节的 `sun_path` 上限，超长回退 TCP）。
  → 这条路的动机是"多 agent 运行时统一纳管"（Studio 还接 Claude Code / Codex / OpenCode 等），代价是要自建一层进程池与协议。
- **反向暴露自己**：Studio 通过 MCP 把自身能力开放给 agent（`bin/ekko-studio-mcp.mjs` + `api/browser/devices/use` 四个 MCP 服务器）。
  → 这是"agent 能用产品能力"的形态，我们二/三期可借鉴（例如让 agent 能操作 24H-OS 自己的面板）。

### 3.3 运行时分发与更新（我们最该学的部分）

- **版本钉死且原子**：`scripts/runtime-config.mjs` 顶部
  `DEFAULT_HERMES_VERSION='0.20.6'` / `DEFAULT_HERMES_SOURCE_REF='v2026.8.27'` / `DEFAULT_HERMES_SOURCE_COMMIT='5fc308a…'`；
  覆盖时三者必须同时给（`throw 'Hermes source overrides are atomic; missing …'`），且 commit 必须是 **40 位**。
- **运行时是独立发布物**：桌面包里不含 Python，首启按清单下载 `hermes-runtime-hermes-agent-<ver>-<platform>.tar.gz`
  （默认源 `https://download.ekkolearnai.com`，可回落到 GitHub releases 资产），下载流程有阶段：`resolve → download → verify → extract → ready`（`runtime-manager.ts:108`），失败可迁移/重试（`migratePendingRuntimeRoot`）。
- **运行时的固定布局**（`ARCHITECTURE.md` 桌面运行时一节）：
  `python/`（上游 git checkout + `base/`（Windows 用 python-build-standalone）+ `venv/` + `agent-browser/` + `node/` + `ms-playwright/`）+ `node/` + `git/`（Windows 是 MinGit）+ `runtime-manifest.json`。
  **Windows 必踩的坑**：PEP 405 的 `pyvenv.cfg` 里 `home` 必须是绝对路径，所以构建/打包/迁移三处都要重写它（`scripts/python-runtime-layout.mjs:19 configWithPythonHome`、`:32` Windows 用 `../base`）。
- **资产带校验**：`scripts/package-runtime.mjs` 产出 `tar.gz + .sha256`，并写 `runtime-manifest.json`（`schema: 2` + `hermesAgentVersion` + `asset{name,url}`）。
- **打包后自检**：`scripts/verify-packaged-webui.mjs` 挂在 electron-builder 的 `afterPack`，逐个检查打包产物里是否真的包含必需文件（例如 22 个内置技能目录）。
- **壳自更新**：`src/main/updater.ts` 用 `electron-updater`（`autoDownload=false`、`autoInstallOnAppQuit=true`、generic 源），下载完由用户确认后 `quitAndInstall()`。
- **命令行垫片**：`cli-shim.ts` 在 `PATH` 里安装 `ekko-studio` / `ekko-studio-mcp`（Windows 用 `.cmd` + PowerShell sidecar），
  `ekko-studio cli …` 直接跑随包 Hermes CLI，`ekko-studio web …` 跑 Web UI CLI。→ 桌面产品自带 CLI，是专业感的一部分。
- **数据目录分离**（`ARCHITECTURE.md`）：Web UI 自己的状态在 `~/.hermes-web-ui`（`HERMES_WEB_UI_HOME` / `HERMES_WEBUI_STATE_DIR` 可覆盖），
  Hermes 状态在 `~/.hermes`，**两者不许混**。

---

## 4. 24H-OS 目标架构

### 4.1 分层与职责

```
┌──────────────────────────────────────────────────────────────┐
│ 渲染层（UI）  src/                                            │
│  · 会话列表 / 对话流 / 文件与预览 / 设置 / 引导                │
│  · 只认 window.hermes.* 这一层抽象（传输可替换 → 将来可做网页） │
└───────────────┬──────────────────────────────────────────────┘
                │ preload（CJS，白名单）
┌───────────────▼──────────────────────────────────────────────┐
│ 主进程（壳）  electron/                                       │
│  main.js    窗口 / IPC 白名单 / 生命周期 / 退出收尾            │
│  runtime.js 运行时解析 → 启动核心 → READY 握手 → token → REST  │
│  gateway.js WS JSON-RPC：调用 / 事件 / 重连                    │
│  （新增）updater.js 壳自更新；（新增）manifest.js 运行时清单校验│
└───────────────┬──────────────────────────────────────────────┘
                │ 本地回环：HTTP(REST) + WS(JSON-RPC)
┌───────────────▼──────────────────────────────────────────────┐
│ 核心（外部运行时，不改源码）                                   │
│  hermes serve · /api/ws(217 方法/69 事件) · REST(227 端点)     │
│  模型服务商 40 个 · 技能 14 类 · cron / 审批 / 项目 / 账号      │
└──────────────────────────────────────────────────────────────┘
```

**为什么这样切**（依据）：

- 数据面放主进程后面（我们已这么做）：token 不出壳、渲染层拿不到裸网口、错误码可在壳里翻译成中文（现在的 `explainError()`）。
- 但**不做**上游那种 255 通道：我们只暴露"方法级"白名单（现在 preload 是 29 个方法 + 7 个事件），
  新增能力优先走"通用 `api` 通道 + 方法白名单"，而不是一个功能一个通道。
- 渲染层与传输解耦：`window.hermes` 今天由 IPC 实现，将来可由"HTTP/WS 直连"实现（Studio 证明可行），这样同一套 UI 能变成网页版/远程版。

### 4.2 启动时序（目标）

```
壳启动 → 解析运行时（env > resources/runtime > <repo>/runtime > PATH）
      → spawn python -m hermes_cli.main serve --host 127.0.0.1 --port 0
      → 等待 stdout 里 HERMES_BACKEND_READY port=N（带超时 + 取消）
      → GET /api/health 自检
      → GET / 取 token → WS /api/ws?token= 建通道
      → 读 model.options / session.list → 渲染首屏
```
现状：这条链路已通（`npm run smoke` 36/36）。
待补：**分阶段进度**（上游有 `hermes:boot-progress`）、失败可操作（重试 / 打开日志 / 换运行时目录）。

### 4.3 数据与目录（对齐 Studio 的分层原则）

| 数据 | 位置 | 说明 |
|---|---|---|
| 核心数据（会话、配置、key、技能） | `HERMES_HOME` = `%APPDATA%\24H\hermes`（我们已这样设） | 壳不落盘会话，全部交给核心 |
| 壳自身数据（窗口位置、最近目录、UI 偏好） | Electron `userData`（与 HERMES_HOME 同根、不同子目录） | 与核心数据**分开** |
| 运行时 | 打包内置 `resources/runtime`（近期）；将来 `userData/runtime/<version>`（下载态） | 见 §5.1 |

---

## 5. 分发与打包方案

### 5.1 三种运行时分发模式对照（选型）

| 模式 | 谁在用 | 安装包体积 | 首启网络 | 升级核心 | 离线可用 |
|---|---|---|---|---|---|
| A. 随包内置 | **我们现状**（371MB 运行时打进 NSIS） | 大（300MB+） | 不需要 | 要重装壳 | ✅ |
| B. 首启安装核心 | 上游桌面（thin installer + `install.sh --commit`） | 小 | 必须（拉核心源码） | `hermes update` | ❌ |
| C. 首启下载运行时资产 | Studio（`hermes-<ver>-runtime.tar.gz` + sha256 + manifest） | 小 | 必须（拉资产） | 换资产即可 | ❌ |

**选型**：**近期 A（保交付）→ 中期 A+C 并存**。
理由：我们的用户是中文环境、网络不确定性高，"装完能离线聊"是卖点；但**核心升级不能靠重装壳**，
所以必须把 §3.3 那套"清单 + 资产 + sha256"补上，将来同一个包既能用内置运行时，也能换下载的运行时。

### 5.2 运行时清单（必须尽早补的机制）

在 `runtime/` 里落一个 `runtime-manifest.json`（构建时生成，随包发出）：

```json
{
  "schema": 1, "coreVersion": "0.21.3", "coreRef": "main", "coreCommit": "<40位>",
  "python": "3.12", "platform": "win-x64", "layout": "venv+core-source",
  "builtAt": "2026-09-16T…Z", "sha256": "<资产的 sha256>"
}
```
（现状：`runtime/.24h-os-runtime.json` 已有 coreRef/coreVersion/builtAt/python/pipMirror/layout —— 缺 commit、platform、sha256。）

壳启动时校验：清单的 `coreVersion` 与我们编译期期望的 `desktop_contract` **双向对齐**，不一致就弹告警条（不静默）。

### 5.3 Windows 打包（我们现在最缺的一环）

- 目标：**NSIS x64**（`nsis.oneClick=false / perMachine=false / allowToChangeInstallationDirectory`）——与两个参照一致。
- 安装器预写 `display.language: zh`（已做 `build/installer.nsh`）。
- **图标**：`build/icon.png`（1024 母版）+ `build/icon.ico`（7 尺寸，`npm run icons` 生成）。
- **代码签名（Authenticode）**：配置已写进 `build.win.signtoolOptions`（sha256 + RFC3161 时间戳），
  证书走 `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD`；**证书本身还没买**——这是 M1 唯一的外部依赖。
  参照产品 mac 侧开了 notarize，Windows 侧上游反而关掉自动改签（`signAndEditExecutable: false`），说明签名要走独立流程。
- **打包后自检**：已落地 `scripts/after-pack.mjs`（afterPack 钩子）+ `npm run verify:package`（含"随包 python 真拉起"）。

### 5.4 安装后的第一次体验（首启引导）

参照两边：上游有首启向导（选服务商/模型）；Studio 有运行时下载进度页。
我们的目标流程（缺什么补什么）：

1. 核心就绪 → 若 `provider_configured=false`：顶部横幅 + 设置页引导（**已做**）。
2. 设置页：服务商单选（40 个 + 国产补充）→ 填 key（**已做**）→ 单模型下拉（**已做**）。
3. 填完 key → 自动发一条"你好"验证通路（**待做**，能立刻把"配好了吗"变成事实）。
4. 失败要说人话：把 `5032 No inference provider configured` 翻成"还没配模型"（**已做**）；把网络错误也翻译（**待做**）。

---

## 6. 功能设计（每条：目标 → 依据 → 实现要点 → 验收）

> 依据列里的"核心方法"指可直接调用的 gateway 方法/事件；"参照"指两个成熟产品里的对应实现。

### F0 界面与设计系统（M1 交付出品，已完成）
- **目标**：第一眼像"能卖的产品"，不是脚手架。
- **依据**：上游 `apps/desktop/DESIGN.md`（token 化、单一原语、扁平不套盒、三态齐全、浮层才有阴影）；
  Ekko Studio `packages/client/styles`（中性墨色、细分隔线、rd 8/6、字号 14 —— 克制而不花哨）。
- **实现**：`src/styles.css` 单文件设计系统（颜色/字号/间距/圆角/阴影/层级全部 token 化，深色 + 浅色）；
  助手回复 Markdown 渲染；文件图标 CSS 绘制；主题偏好存壳的 `userData/ui-prefs.json`。
- **验收**：`npm run ui-smoke` 新增"主题能切""Markdown 渲染成真元素"两条断言（现 19/19）。

### F1 启动与就绪（M1，已完成 80%）
- **目标**：装完打开就能用；核心慢启动时界面不"卡死"。
- **依据**：核心 `serve` + READY 握手；上游 `backend-ready.ts`（合并输出的正则坑）、`hermes:boot-progress`；Studio 的运行时 `resolve→…→ready` 阶段。
- **实现要点**：分阶段进度条（解析运行时/启动核心/握手/连通道/读会话）；失败三板斧（重试、看日志、换运行时目录）；**窗口比核心先就绪也要能自愈**（我们已修过一次：`afterCoreReady()`）。
- **验收**：`npm run ui-smoke` 断言"核心晚就绪时列表能补加载"；手工：冷启动首屏 < 3s 出骨架、就绪后自动填数据。

### F2 对话（M1，已完成）
- **目标**：流式输出、思考过程可折叠、工具调用可见、可中断。
- **依据**：事件 `message.delta/reasoning.delta/thinking.delta/tool.start/tool.complete/message.complete/error`（我们处理了 11/69）；上游 UI 把"工具活动"做成一等公民。
- **实现要点**：错误码翻译（4001/4023/5032 已做）；长回复虚拟滚动（未做，消息 >200 条会卡）；"上下文用量"显示（核心有 `session.usage`、`session.context_breakdown`，未接）。
- **验收**：`npm run smoke` 的 prompt/事件闭环断言；手工：发一条长任务，中途点停止能真的停。

### F3 会话管理（M2，已完成 85%）
- **依据**：`session.*` 30 个方法；核心规则"活跃会话不可删（4023）→ 先 close 再 delete"、"运行时回收后 4001 要 resume 恢复"（我们已内建）。
- **待补**：会话导出/导入（`session.foreign.import/list/preview`）、会话分支（`session.branch`）、撤销（`session.undo`）、压缩（`session.compress`）——**核心已有，接 UI 即可**。

### F4 模型与服务商（M2，已完成 80%；**当前只对外提供 DeepSeek**）
- **本版范围决定**：只暴露 DeepSeek（`PROVIDER_ALLOWLIST = ['deepseek']`，未命中时退回显示全部，避免界面死路）。
  产品理由：一个模型 + 一个 key 是一条能讲清楚的首启路径；其余服务商走"高级 → 自定义端点"。
- **依据**：上游 40 个 provider 插件目录；我们额外需要官方没有的国产服务商（此前调研结论：`ai302 / ark(火山方舟) / compshare / hunyuan / longcat / modelscope / qianfan / siliconflow` 这 8 个上游没有）。
- **实现要点**：设置页已有"单选服务商 + key + 自定义 OpenAI 兼容端点"；补"连通性测试"（发一条 `ping`-级请求并显示延迟）、"多 key 轮换"（二期）。
- **验收**：填 key → 保存 → 发消息成功（Windows 手工回归清单第 6 步）。

### F5 文件与预览（M2，已完成基本盘）
- **依据**：REST `/api/fs/list`、`/api/files/read`（返回 `data_url`）；上游有"右侧预览面板 + 内置浏览器"；Studio 桌面甚至有完整浏览器模块（书签/下载/标注）。
- **实现要点**：一期保持"目录树 + 文本/图片预览"（已做）；二期加"网页预览标签"（用 Electron 的 `WebContentsView` 或外链），**不**做完整浏览器。
- **验收**：点开会话工作目录 → 列目录 → 预览 md/图片；越权路径要拒绝（待补：路径白名单/根目录约束）。

### F6 设置与引导（已完成）
- **现状**：设置拆成五个分节（服务商与模型 / 外观 / 数据与目录 / 诊断 / 高级）；诊断分节列出
  核心版本、桌面契约、运行时清单（coreVersion/commit/platform）、路径，并提供「复制诊断信息」。
- **依据**：上游设置页是"短任务弹层"（`DESIGN.md` Information architecture）；排障必须能一键拿到现场信息。
- **依据**：上游设置页含 provider/model/tools/credentials；我们设置页现在 5 个区块。
- **待补**：语言切换（先 zh 固定）、数据目录位置显示与打开、日志导出、诊断信息一键复制（版本/运行时清单/契约版本）——**排障必需**。

### F7 语音（M4，可选）
- **依据**：核心 `voice.record` / `voice.tts` / `voice.toggle`；Studio 桌面预置 `sherpa-onnx-node`、`node-edge-tts`。
- **判断**：这是"锦上添花"，权重低；等 M3 之后再评估。

### F8 技能与插件（M3 起步）
- **依据**：核心 `skills/`（14 类）、`plugins.model-providers`（40 个）、`skills.manage/plugins.manage/mcp.*`。
- **要点**：一期只做"内置技能 + 官方 provider"，**不给第三方插件开全权限**（`runtime-loader.ts:24` 的教训）；把"国产 provider 包 + 中文技能"作为我们的差异化资产，以**插件包**形式发行（上游明确建议：add-on 走独立插件包，别进核心树）。
- **验收**：干净机器安装后，设置页能列出国产 8 家；选中任一家填 key 能发消息。

### F9 自动化（三期评估，不在 v1 范围）
- 核心有 `cron.manage`、`subagent.*`、`handoff.*`；Studio 有可视化工作流。**先不做**——工作流的复杂度与"个人助手"定位不匹配，等有明确付费场景再说。

### F10 更新（M3，壳侧已接线；差一个分发源）
- **壳**：`electron-updater` + 自建静态源（国内对象存储；参照 Studio 的 `download.ekkolearnai.com` 与 `autoDownload=false`）。
- **核心运行时**：走 §5.2 的清单 + 资产（参照 Studio 的 sha256 + manifest）。
- **回滚**：更新后启动失败 → 自动退回上一份运行时目录（参照 Studio `migratePendingRuntimeRoot` 的"待用目录"思路）。
- **现状（已完成的部分）**：`electron-updater` 已进 dependencies；「设置 → 高级 → 检查更新」在**没配更新源**时会
  明确说"未配置更新源"（而不是报错）；运行时清单已带 `coreCommit` / `coreTreeSha256` / `platform`；
  **运行时回退**已实现并实测：当前 `runtime/` 起不来时自动改用 `runtime.prev`（把坏的 runtime 和好的
  runtime.prev 摆在一起，壳成功回退并启动，日志给出原因）。
- **还差**：把 `build.publish` 指向自己的分发源（对象存储/CDN），并做一次真实的"装 v1 → 升 v2"验证。
- **验收**：装 v1 → 升 v2 → 数据（会话/key）不丢；再升级一次运行时资产，核心版本号变化且 UI 不崩。

### F11 一级导航与命令面板（已完成，原计划在 §12 的 2、3 步）
- 左轨：对话 / 技能 / 任务 / 用量 / 设置；技能 58 个按组分类，任务读 `cron.manage`，用量读 `insights.get`。
- 命令面板 `Ctrl/Cmd + K`：28 条命令（含按模型动态生成的"切换模型"），支持过滤与键盘上下选择。
- 契约比对发现并修掉一个真问题：渲染层原来监听 `turn.started`，而核心声明的是 `message.start` —— 等于回合开始事件一直没接上。

### F12 托盘/多窗口（M4，可选）
- 参照 Studio 的 `group-chat-agent-popup`、托盘图标族；上游有 `pet.*`（不做）。

---

## 7. 质量工程与验收标准

### 7.1 三层验证（现状）

| 层 | 工具 | 现状 | 覆盖什么 |
|---|---|---|---|
| 协议层 | `npm run smoke` | **36/36** | 核心启动/握手/token/WS/会话/事件/文件/搜索/错误码/恢复路径 + 界面层静态护栏 |
| 界面层 | `npm run ui-smoke` | **17/17** | 真浏览器渲染 `index.html`：弹层隐藏与关闭、核心晚就绪补加载、IPC `{ok,data}` 拆包 |
| 打包层 | `scripts/after-pack.mjs` + `npm run verify:package` | **已建（本机在 Linux 解包产物上验证通过）** | asar 入口文件齐不齐、随包运行时能不能真跑（拉起 python import 核心包）、安装包名字/sha256 |
| 打包层（真机） | — | **缺** | 真装真验：安装 → 首启 → 发消息 → 卸载（参照 `test-desktop.mjs` 的 fresh/existing 两种模式） |

### 7.2 打包层验收清单（Windows，手工 + 脚本化）

1. 干净机器（或虚拟机）跑 `24H-<ver>-x64.exe`，中文安装界面（`installer.nsh` 已写 zh）。
2. 首启不弹 SmartScreen（**需签名**）。
3. 首启 5s 内出界面骨架，30s 内核心就绪（写运行时清单里的实测值）。
4. 设置里列出服务商 → 填 key → 保存 → 发一句 → 有回复。
5. 关窗再开：会话历史还在（数据在 `%APPDATA%\24H\hermes`）。
6. 卸载后 `%APPDATA%\24H` 的去留符合预期（现在是保留，需在文档里写明）。
7. 无残留进程（核心子进程要跟着退出；**已知风险**：壳被强杀会留下孤儿核心进程，需加"父进程看门狗"，参照 Studio 的 `_start_parent_process_watchdog`）。

### 7.3 CI

- 现在：本地脚本 + 文档（无 runner）。
- 目标：`smoke` + `ui-smoke` 进 CI（Linux 容器可跑，无需图形）；打包做在 Windows runner 或手动触发（参照 Studio 的 `desktop-release.yml` 手动 dispatch + 平台分矩阵）。

---

## 8. 里程碑

| 阶段 | 内容 | 验收（机械） | 预估 |
|---|---|---|---|
| **M0 现状** | 壳 + 对话 + 会话 + 文件；协议/界面两层冒烟 | smoke 36/36、ui-smoke 17/17 | 已完成 |
| **M1 交付**（当前冲刺） | Windows 真机跑通 GUI；~~图标~~ ✓；~~打包自检~~ ✓；代码签名证书（待买）；`npm run dist` 出包；打包层验收清单跑一遍 | 干净 Win 上装包能用（§7.2 全绿） | 1–2 周 |
| **M2 打磨** | 启动进度与失败引导；错误中文化全覆盖；上下文用量；会话导出/撤销/分支；诊断一键复制 | 新增断言 + 手工清单 | 2–3 周 |
| **M3 运行时通道** | 运行时清单 + sha256 + 资产发布；壳自更新（electron-updater）；核心独立升级与回滚；国产 provider 包 | 装 v1 → 升 v2 → 数据不丢；换运行时核心版本变化 | 3–4 周 |
| **M4 商业化二期** | 账号/额度（先评估核心 `billing.*/subscription.*/free_tier.*` 是否可用）；多设备/远程；语音 | 付费闭环可走通（或明确"自建后端"的最小方案） | 待评估 |

---

## 9. 风险与"不做"清单

**风险**

1. **Windows 侧从未在真机跑过打包与首启** —— 目前所有结论都来自 Linux/NAS 与静态分析。M1 必须先把这个空白补上。
2. **运行时随包 371MB**：NSIS 出包体积、上传带宽、用户下载体验都是压力；中期必须转向资产化。
3. **核心升级会打脸**：核心 0.21.x 的契约版本从 6 → 7（`desktop_contract`），方法面很大，升级要做"契约对照 + 冒烟"（我们的 `EXPECTED_DESKTOP_CONTRACT` 就是为此）。
4. **Windows 上的 python venv 布局**：Studio 的经验是"`pyvenv.cfg` 的 `home` 必须是绝对路径"，构建/打包/迁移都要重写——我们的 `build-runtime.ps1` 还没在 Windows 上跑过。
5. **孤儿核心进程**：壳非正常退出时核心会残留（本机已观察到一次，PID 1361550 PPid=1）。要加父进程看门狗。
6. **中文网络**：npm/pip/electron/镜像全依赖 npmmirror/国内源；文档已记录，但 CI 与打包机要固化镜像变量。

**不做（v1 明确排除）**

- ❌ 自研 agent 内核／fork 核心（Reasoning：Studio 明确保持 checkout 干净；fork 会失去上游更新）
- ❌ 群聊/多 agent 编排（Studio 的 18 个 `groups.*` 方法留给它）
- ❌ 内置完整浏览器、宠物、可视化工作流
- ❌ 第三方插件市场（信任边界未解决前不开）
- ❌ 移动端

---

## 10. 附录：证据索引

**核心（`~/24H-OS/runtime/core`）**
- gateway 方法/事件/服务端请求计数：`PYTHONPATH=. ../venv/bin/python -c "from tui_gateway.contracts.registry import EVENTS, METHODS, SERVER_REQUESTS; …"` → `217 / 69 / 12`
- WS 端点：`hermes_cli/web_routers/chat_ws.py:569`
- REST 端点数：`grep -rhoE "@router\.(get|post|put|patch|delete)\(" hermes_cli/web_routers/*.py | wc -l` → `227`（24 个文件）
- 契约生成：`scripts/gen_gateway_contracts.py`（Pydantic → TS/OpenRPC）；产物 `apps/shared/src/gateway-contract.generated.ts`（5,087 行）、`gateway-events.ts`（52 行）
- provider 插件：`ls plugins/model-providers | wc -l` → `40`；技能：`ls skills | wc -l` → `14`

**上游桌面（`apps/desktop`）**
- 规模：`find electron -name '*.ts' | xargs wc -l` → `344 文件 / 90,420 行`；`main.ts` 18,443 行；`src/` 2,115 文件 / 477,802 行；e2e 45 个 spec
- 通道：`grep -rhoE 'hermes:[a-zA-Z0-9:_-]+' electron src | sort -u | wc -l` → `255`
- 数据面：`electron/preload.ts:261`、`electron/main.ts:16795`
- 传输策略：`electron/api-transport.ts`（keep-alive 池 + 非幂等动词不盲目重试）
- 就绪解析：`electron/backend-command.ts:21`、`electron/backend-ready.ts:6,12`
- 生命周期：`electron/backend-ownership.ts`（355 行）、`backend-release-gate.ts`、`backend-recycle.ts`
- 更新：`electron/updater-process.ts`（469 行）+ `scripts/desktop-update/{windows.ps1,posix.sh,retry-policy.ps1}`
- 安装器：`apps/bootstrap-installer/src-tauri/tauri.conf.json`（0.21.1，identifier `com.nousresearch.hermes.setup`）；thin 说明见 `scripts/test-desktop.mjs:16-19`
- 设计系统：`apps/desktop/DESIGN.md`（Principles 1–7，`:25-` 起）；i18n `src/i18n/{en,zh,zh-hant,ja,ar,ru}.ts`（en 4,503 / zh 4,401 行）
- 插件信任边界：`src/contrib/runtime-loader.ts:24`

**Studio（`/tmp/src/hermes-studio-main`）**
- 包边界与数据归属：`ARCHITECTURE.md`（Package Boundaries / State And Data Ownership / Desktop Hermes Runtime 三节）
- 版本原子钉住：`packages/desktop/scripts/runtime-config.mjs:1-4,26-45`
- 运行时下载与阶段：`packages/desktop/src/main/runtime-manager.ts:108,344,377-401,759-800`
- 运行时布局与 Windows `pyvenv.cfg`：`ARCHITECTURE.md` + `packages/desktop/scripts/python-runtime-layout.mjs:19,32`
- 资产与清单：`packages/desktop/scripts/package-runtime.mjs:109,178-193,199-200`
- 打包后自检：`packages/desktop/scripts/verify-packaged-webui.mjs`（挂在 `electron-builder.yml` 的 `afterPack`）
- 桌面预加载只有原生能力：`packages/desktop/src/preload/index.ts:12-`（179 行）
- 本地 Web 服务：`packages/desktop/src/main/webui-server.ts:527,531`、`webui-port.ts`
- 核心接入方式（bridge）：`packages/server/src/modules/hermes/services/bridge/python/{hermes_bridge,bridge_transport}.py`（`ipc://` / sun_path 104、108）
- 自更新：`packages/desktop/src/main/updater.ts`（electron-updater）
- 命令行垫片：`packages/desktop/src/main/cli-shim.ts:21-22,74-79`
- 服务端规模与命名空间：`find packages/server/src -name '*.ts' | xargs wc -l` → `534 / 130,767`；`of('/chat-run' | '/group-chat' | '/group-chat-agent-relay' | '/terminal')`

**24H-OS（本仓）**
- 代码规模：`wc -l electron/*.{js,cjs} src/*.{js,css,html}`（main 192 / runtime 262 / gateway 137 / preload 69 / renderer 857 / styles 154 / index 118）
- 已用能力：15 个 WS 方法、11 个事件、9 个 REST 端点（`electron/main.js` 的 `handle(...)` 列表）
- 验证：`npm run smoke` 36/36、`npm run ui-smoke` 17/17
- 运行时：`runtime/.24h-os-runtime.json`（coreRef/coreVersion/builtAt/python/pipMirror/layout）

---

## 11. 变更记录

- 2026-09-16：M1 部分落地 —— 图标（`build/icon.png` + `build/icon.ico` + `npm run icons`）、
  签名配置（`build.win.signtoolOptions`，证书走 `WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD`）、
  打包自检（`scripts/after-pack.mjs` + `npm run verify:package`，已在本机 Linux 解包产物上验证）；
  核心契约"是否开放"已实测并单列 [`CORE-CONTRACT.md`](CORE-CONTRACT.md)。
- 2026-09-16（第二次）：界面重做 —— token 化设计系统 + 深浅两色 + Markdown 渲染 + CSS 文件图标；
  模型范围收窄为"只对外提供 DeepSeek"；主题偏好落到壳的 `userData/ui-prefs.json`（新增
  `ui:prefs:get/set` 两个 IPC 通道）。ui-smoke 19/19、smoke 38/38。

---

## 12. 界面信息架构（菜单改版计划）

现状：顶栏只有 `文件 / 日志 / 外观 / 设置` 四个入口，左栏只有会话列表，设置页是"一屏到底"。
这是 **v1 骨架**，不是最终形态 —— 判断依据是能力面：核心有 217 个 gateway 方法，我们只用 15 个，
`skills.manage / cron.manage / profiles.* / projects.* / insights.get / usage.bars / mcp.*` 这些现成能力
目前**在界面上没有入口**（`node scripts/contract-probe.mjs` 实测都能调）。

参照两家的做法（`apps/desktop/DESIGN.md` 的 Information architecture 一节）：
**对话是主界面；技能/消息/产出这类"名词"要有自己的一级入口；设置/命令面板这类"短任务"才是弹层。**

分三步走：

### 第 1 步（M2 内，先让现有入口立住）
- **设置页分节**：`服务商与模型 / 外观 / 数据与目录（HERMES_HOME、工作目录、打开所在文件夹）/ 诊断（版本、运行时清单、契约版本、一键复制）/ 高级（自定义端点、重启核心）`
- **会话行操作升级**：悬浮出「⋯」菜单 → 重命名 / 复制 session id / 导出 md / 打开工作目录 / 删除；顶部加「导出全部会话」
- **右侧面板合流**：文件 / 预览 / 日志 三个都收进同一个右侧抽屉，用标签切换（现在日志是底部抽屉、文件是第三栏，位置不统一）

### 第 2 步（M2 末–M3，加一级导航）
- 左栏顶部加一级导航（图标 + 文字）：**对话 / 技能 / 任务 / 用量 / 设置**
  - 技能 → `skills.manage`（核心自带 58 个技能，实测）
  - 任务 → `cron.manage`（定时任务）
  - 用量 → `insights.get` + `usage.bars`（核心已提供数据模型）
- 对话页保持"会话列表 + 对话流"，与一级导航不冲突

### 第 3 步（M3+，命令面板）
- `Ctrl/Cmd + K` 命令面板：把上面所有动作（新建会话、切模型、打开设置、导出、切主题、重启核心…）收进一个可搜索的列表。
- 这不是"装饰"：上游桌面把它当主入口（Command Center），因为功能一多，顶栏按钮一定会崩。

**验收**（每一步都要能机械验证）：
- 第 1 步：ui-smoke 增加"设置页有 5 个分节""会话行能出菜单""右侧面板标签可切"三类断言
- 第 2 步：ui-smoke 增加"一级导航 5 项且能切页""技能页列出核心技能数 > 0"
- 第 3 步：ui-smoke 增加"Ctrl+K 打开面板、输入能过滤、回车执行"
