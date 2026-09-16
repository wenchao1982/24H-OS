# 24H-OS

Electron 桌面壳，后端使用 [Hermes Agent](https://github.com/NousResearch/hermes-agent) 作为核心运行时
（以独立进程方式调用，不在本仓库内）。

- 许可：**Business Source License 1.1**（见 `LICENSE`）；运行时依赖归属见 `NOTICE`。

## 文档

- **[`docs/PLAN.md`](docs/PLAN.md) — 24H-OS 制作方案 v1**：上游 Hermes Desktop / Ekko Studio 桌面版架构解读 + 本产品的分层、分发、功能、里程碑（每条结论都带 `路径:行号` 出处）
- [`docs/WINDOWS.md`](docs/WINDOWS.md) — 在 Windows 上跑起来 / 出安装包
- [`docs/PROGRESS.md`](docs/PROGRESS.md) — **进度与排期**（M0–M4 状态表、M1 收口清单、按日排期、依赖卡点）
- [`docs/CORE-CONTRACT.md`](docs/CORE-CONTRACT.md) — 核心契约实测：billing/subscription/free_tier 到底开不开放，以及我们的三条路

## 目录

```
electron/runtime.js   运行时管理：解析 python → 启动核心 → 解析就绪端口 → REST（token 现取）
electron/gateway.js   WS JSON-RPC 通道：调用/事件/自动重连（对话走这里）
electron/main.js      主进程：开窗、启动核心、建立通道、IPC 白名单、退出收尾
electron/preload.cjs  预加载：暴露最小 window.hermes API 面（**必须 CJS**，见文件头注释）
src/                  渲染进程：会话列表 + 对话流（流式）+ 模型选择 + 设置（无 Node 权限）
scripts/smoke.mjs     无界面冒烟测试（协议层端到端；`-- --static` 只跑静态护栏，CI 用）
scripts/ui-smoke.mjs  界面层冒烟（无头浏览器真渲染 index.html）
scripts/after-pack.mjs / verify-package.mjs   打包时与打包后的自检
scripts/gen-contract.mjs      从核心抓契约快照 → electron/contract.generated.json
scripts/make-icons.py         从 build/icon.png 生成 build/icon.ico
.github/workflows/ci.yml       CI：静态护栏 + 契约比对 + 界面层冒烟
```

## 功能

**M1（对话闭环）**

- 会话：新建 / 列表 / 切换 / 历史恢复（运行时被回收时自动 `session.resume` 恢复）
- 对话：流式输出、思考过程折叠、工具调用卡片（可展开）、停止生成
- 模型：从核心读服务商与模型，可切换默认模型；设置页可保存 API Key（写进核心配置）。
  **当前版本只对外提供 DeepSeek**（`src/renderer.js` 的 `PROVIDER_ALLOWLIST`）：设置页只列 DeepSeek，
  其它服务商走「高级 → 自定义 OpenAI 兼容端点」接入
- 运行状态：核心状态点、端口、WS 通道状态、可展开的核心日志抽屉
- 健壮性：桌面契约版本对齐告警、未配模型引导、会话工作目录

**M3（界面与信息架构）**

- 设计系统：`src/styles.css` 单文件 token 化（颜色/圆角/间距/阴影/层级），深色 + 浅色两套，
  默认跟随系统；「设置 → 外观」与顶栏按钮、命令面板共用同一处状态（偏好存壳的 `userData/ui-prefs.json`）
- **一级导航**：对话 / 技能 / 任务 / 用量 / 设置 —— 技能列核心的 58 个技能（按组中文分类）、
  任务读 `cron.manage`、用量读 `insights.get`
- **右侧面板合流**：文件 / 预览 / 日志 三个标签（原来文件在右栏、日志在底部抽屉，位置不统一）
- **命令面板（Ctrl/Cmd + K）**：把新建会话、切模型、开关面板、切主题、导出、撤销、分叉、诊断复制、
  重启核心、检查更新等动作收进一个可搜索列表（动作与界面按钮共用同一批函数）
- **设置分五个分节**：服务商与模型 / 外观 / 数据与目录 / 诊断 / 高级（自定义端点、更新、重启核心）
- 助手回复走 Markdown 渲染（围栏代码块、表格、列表、引用、行内码、粗体、链接）
- 会话行「⋯」是**系统原生菜单**（重命名 / 复制 id / 导出 Markdown / 分叉 / 撤销上一轮 / 删除）
- 输入区上方显示**上下文用量**（`session.usage`：占比、tokens、成本、tok/s），核心推 `session.usage` 事件时自动更新
- 错误提示中文化：未配模型 / 会话被回收 / Key 失效 / 限流 / 网络不通 / 余额不足 都有对应人话

**M2（会话与文件）**

- 会话搜索（侧栏搜索框，走 `/api/sessions/search`）
- 会话改名（行内编辑 → `session.title`）与删除（`session.close` → `session.delete`）
- 文件面板：列目录（`/api/fs/list`）、预览文本与图片（`/api/files/read` 的 `data_url`）、跟随会话工作目录

## 开发

> **Windows 用户看这里 → [`docs/WINDOWS.md`](docs/WINDOWS.md)**：装环境、跑起来、出安装包的完整步骤与卡点。

```bash
npm install          # 国内网络可加：ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/
npm run probe        # 不需要图形环境：验证"启动核心 → 拿到端口 → 健康检查 → 鉴权调用"整条链路
npm run dev          # 打开窗口（需要图形环境）
```

`npm run probe` 需要能找到一个 Hermes 运行时，按下面顺序解析：

1. 环境变量 `HERMES_RUNTIME_PYTHON`（开发时最方便，指向任意一个 Hermes venv 的 python）
2. `resources/runtime/…`（打包后随壳发行的运行时）
3. `<仓库根>/runtime/…`（本地开发：把运行时放这里）
4. PATH 里的 `hermes`（用户机器上已装过 Hermes 的情况）

例：

```bash
HERMES_RUNTIME_PYTHON=/path/to/hermes/venv/bin/python npm run probe
```

### 两个已知的本地环境坑

- **`NODE_ENV=production` 会让 `npm install` 跳过 devDependencies**（Electron 装不上，输出
  只说 "audited 1 package"）。装依赖时用 `NODE_ENV=development npm install --include=dev`。
- **国内网络装 Electron 二进制**要指镜像：
  `ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/ npm install`。

## 与核心的对接契约（实测于 Hermes 0.21.0）

### 启动与鉴权

| 环节 | 事实 |
|---|---|
| 启动命令 | `<python> -m hermes_cli.main serve --host 127.0.0.1 --port 0`（端口 0 = 核心自选，避免冲突） |
| 就绪信号 | 核心往 **stdout** 打 `HERMES_BACKEND_READY port=<N>` |
| 健康检查 | `GET /api/health` → `{"ok":true,"version":"0.21.0","auth_required":false}`（无需鉴权） |
| 会话 token | `GET /` 的 HTML 内联 `window.__HERMES_SESSION_TOKEN__="<token>"` |
| REST 鉴权 | header `Authorization: Bearer <token>`（实测 `/api/status`、`/api/config` 200） |
| WS 鉴权 | `ws://127.0.0.1:<port>/api/ws?token=<token>`（回环用 token 查询参数） |
| 协议参考 | `/openapi.json`（265 个端点）、`/docs` |
| 用户数据 | 壳把 `HERMES_HOME` 指向 `app.getPath('userData')/hermes`，可用环境变量覆盖 |

### 实时通道（WS JSON-RPC）—— 对话走这里，不走 REST

```
请求  {"jsonrpc":"2.0","id":N,"method":"prompt.submit","params":{…}}
应答  {"jsonrpc":"2.0","id":N,"result":{…}} | {"jsonrpc":"2.0","id":N,"error":{"code":…,"message":…}}
事件  {"jsonrpc":"2.0","method":"event","params":{"type":"message.delta","session_id":"…","payload":{…}}}
```

用到的**方法**：`gateway.capabilities`、`session.create|list|activate|resume|history|interrupt|title`、
`prompt.submit`、`model.options|set|save_key`。

用到的**事件**：`gateway.ready`、`sessions.changed`、`session.info`、`turn.started`、
`message.delta`、`reasoning.delta`、`thinking.delta`、`tool.start`、`tool.complete`、
`message.complete`、`error`。
（`message.delta` / `reasoning.delta` / `thinking.delta` 的 payload 都是 `{text}`，核心侧以 ~30fps 合批。）

**REST 补充**（文件面板与会话搜索，实测 0.21.3）：

| 端点 | 参数 | 返回 |
|---|---|---|
| `GET /api/fs/list` | `path`（必填，缺则 422） | `{entries:[{name,path,isDirectory}]}` |
| `GET /api/files/read` | `path` | `{name,path,size,mime_type,data_url,…}`（`data_url` 是 base64 data URL） |
| `GET /api/sessions/search` | `q` | `{results:[…]}` |

**设置相关的载荷形状**（严格契约，参数名写错会被拒，踩过一次）：

| 动作 | 通道 | 参数 |
|---|---|---|
| 保存 API Key | WS `model.save_key` | `{ slug, api_key }`（**不是** `provider`/`key`） |
| 设置默认模型 | **REST** `POST /api/model/set` | `{ scope: "main", provider, model }` |
| 自定义 OpenAI 兼容端点 | REST `POST /api/providers/custom-endpoints` | `{ name, base_url, model, api_key?, make_default? }` |
| 更新配置 | REST `PUT /api/config` | `{ config, profile? }` |

注意 **WS 里没有 `model.set`** —— 设置模型只能走 REST。契约定义在核心的
`tui_gateway/contracts/`（Pydantic，严格模式），所以参数名必须以那份为准。

**会话生命周期规则**（实测）：

- `session.close` 把会话从活跃集合摘除，返回 `{closed:true}`；已关闭再调返回 `{closed:false}`（幂等）
- **活跃会话不可删** → `session.delete` 返回 **4023 `cannot delete an active session`**，所以客户端顺序必须是
  `close` → `delete`
- 只有真正落盘（跑过一轮对话）的会话才能被列出/删除；未落盘的删会得到 **4007 `session not found`**

**两个必须处理的错误码**：

- **4001 `session not found`** —— 运行时不持有该会话（WS 断开后被回收/LRU 驱逐）。客户端应拿
  **stored session id**（`session.list` 里的 `id`）走 `session.resume` 取回新的运行时 `session_id`，
  再重试原调用。`electron/main.js` 的 `gwCall` 已内建这个恢复动作。
- **5032 `No inference provider configured`** —— 还没配模型/key。UI 把它翻译成人话并引导去设置页。

**桌面契约版本**：`session.create` 的 `info.desktop_contract` 是核心给壳的协议版本号
（实测 **0.21.0 → 6，0.21.3 → 7**）。壳把它与编译期期望值比对，过旧/过新都会弹顶部告警条 ——
这样"换了别的版本核心"不会变成静默不兼容。

## 自检

```bash
npm run smoke              # 无图形环境也能跑：启动核心 → token → WS → 会话 → 发消息 → 事件闭环 → 恢复路径
npm run smoke -- --static  # 只跑静态护栏（含与核心契约的比对），CI 用，不需要运行时
npm run probe              # 更轻量：只验证核心启动 + 健康检查 + 一次鉴权调用
npm run ui-smoke           # 界面层：用 chrome-headless-shell 打开 src/index.html，验导航/面板/命令面板/设置分节
npm run verify:package     # 打包后：asar / 随包运行时能不能真的跑起来 / 安装包名字与 sha256
node scripts/gen-contract.mjs     # 重新抓核心契约（升级核心后跑一次）
node scripts/contract-probe.mjs   # 契约体检：核心到底给我们开放了哪些方法（含账号/计费）
```

`npm run ui-smoke` 是界面层的护栏：它用真的浏览器渲染 `src/index.html`（`window.hermes` 用桩顶掉），
专测协议层测不到、但用户一眼就看得见的那类问题 —— 带 `hidden` 的弹层有没有真藏住、点「关闭」关不关得掉、
窗口比核心先就绪时（常态）模型/会话列表会不会一直停在「读取中…」、IPC 的 `{ok,data}` 拆没拆。
需要 `chrome-headless-shell`（`CHROME=` 指向它）和 `puppeteer-core`（`npm i -D puppeteer-core`）；
两者缺一个就自动跳过、不算失败。`--before` 参数会改用 `git HEAD` 里的旧文件跑一遍做对照。

`npm run smoke` 覆盖 36 项断言（含 4001/resume 恢复路径和界面层护栏），并且**默认把核心的
`HERMES_HOME` 指向一个临时目录** —— 这条链路会真写配置（存 key、写自定义端点），隔离之后
跑测试不会动你自己那份 profile（要跑真实 home 就显式 `HERMES_HOME=... npm run smoke`）。
本机实测：隔离 home 下 **36/36 通过**；对着已配好模型的 home 跑时，`prompt.submit` 之后
会在 6 秒窗口内收不到 turn 结束信号（那是模型服务商可达性问题，不是通路问题）。本机未配置模型时，`prompt.submit`
会以 `message.complete(status=error)` 收尾、`session.interrupt` 返回 5032 —— 这两项按"环境未就绪"
处理，不代表通路有问题。

## 打包（Windows 安装包）

```bash
PYTHON=python3.12 scripts/build-runtime.sh main   # ① 构建运行时 → runtime/（随包发出）
NODE_ENV=development npm install --include=dev    # ② 装依赖（含 electron-builder）
scripts/package-win.sh                            # ③ 出 NSIS 安装包 → release/
```

**为什么运行时从源码构建**：PyPI 上 `hermes-agent` 最新只到 **0.19.0（2026-07-20）**，而核心仓库已到
0.21.x —— 0.20+ 只在 git 里发。所以 `build-runtime.sh` 用 codeload 拉源码树、在独立 venv 里从源码安装
（依赖走 pip 镜像），产出 `runtime/`，再由 electron-builder 通过 `extraResources` 放进安装包。

**安装包里的默认中文**：`build/installer.nsh` 在安装时把 `display.language: zh` 写进
`%APPDATA%\24H\hermes\config.yaml`（正是壳使用的 `HERMES_HOME`），用户装完即是中文；已存在配置则不覆盖。

**为什么是"venv + 源码树"两份**：Hermes 的 `setup.py` **拒绝构建 wheel/sdist**
（`Building wheels or sdists for hermes-agent is not supported.`），官方只支持 shell installer / Docker /
Nix / 开发用 editable。所以随包运行时 = 依赖装进 `runtime/venv`，核心源码树放 `runtime/core`，
壳启动时用 `PYTHONPATH=runtime/core` 跑 `python -m hermes_cli.main serve …`（`electron/runtime.js` 自动识别该布局）。

**实测（2026-09-16）**：`scripts/build-runtime.sh main` 产出 **371 MB** 运行时（核心 0.21.3 + Python 3.12），
`npm run smoke` 对这**自带运行时**跑出 **16/16 通过** —— 即"离线、不依赖上游安装器"这条路是通的。

**发布前必须补的**（详细步骤见 [`docs/WINDOWS.md`](docs/WINDOWS.md) §三）：

- ~~图标~~ → **已有**：`build/icon.png`（1024 母版）+ `build/icon.ico`（7 个尺寸）；换图跑 `npm run icons`；
- **Windows 代码签名证书**（唯一还缺的）—— 没有它用户会遇到 SmartScreen 拦截。配置已写好
  （`build.win.signtoolOptions`），证书走 `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` 环境变量；
- 打包自检已就位：`afterPack` 钩子（`scripts/after-pack.mjs`）+ `npm run verify:package`。
