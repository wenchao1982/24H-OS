# 24H-OS

Electron 桌面壳，后端使用 [Hermes Agent](https://github.com/NousResearch/hermes-agent) 作为核心运行时
（以独立进程方式调用，不在本仓库内）。

- 许可：**Business Source License 1.1**（见 `LICENSE`）；运行时依赖归属见 `NOTICE`。

## 目录

```
electron/runtime.js   运行时管理：解析 python → 启动核心 → 解析就绪端口 → REST（token 现取）
electron/gateway.js   WS JSON-RPC 通道：调用/事件/自动重连（对话走这里）
electron/main.js      主进程：开窗、启动核心、建立通道、IPC 白名单、退出收尾
electron/preload.js   预加载：暴露最小 window.hermes API 面
src/                  渲染进程：会话列表 + 对话流（流式）+ 模型选择 + 设置（无 Node 权限）
scripts/smoke.mjs     无界面冒烟测试（协议层端到端）
```

## 功能（M1）

- 会话：新建 / 列表 / 切换 / 历史恢复（运行时被回收时自动 `session.resume` 恢复）
- 对话：流式输出、思考过程折叠、工具调用卡片（可展开）、停止生成
- 模型：从核心读服务商与模型，可切换默认模型；设置页可保存 API Key（写进核心配置）
- 运行状态：核心状态点、端口、WS 通道状态、可展开的核心日志抽屉

## 开发

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

**两个必须处理的错误码**：

- **4001 `session not found`** —— 运行时不持有该会话（WS 断开后被回收/LRU 驱逐）。客户端应拿
  **stored session id**（`session.list` 里的 `id`）走 `session.resume` 取回新的运行时 `session_id`，
  再重试原调用。`electron/main.js` 的 `gwCall` 已内建这个恢复动作。
- **5032 `No inference provider configured`** —— 还没配模型/key。UI 要把它翻译成人话并引导去设置页。

## 自检

```bash
npm run smoke     # 无图形环境也能跑：启动核心 → token → WS → 会话 → 发消息 → 事件闭环 → 恢复路径
npm run probe     # 更轻量：只验证核心启动 + 健康检查 + 一次鉴权调用
```

`npm run smoke` 覆盖 16 项断言（含 4001/resume 恢复路径）。本机未配置模型时，`prompt.submit`
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

**发布前必须补的**：

- `build/icon.ico`（256×256）—— 否则用 Electron 默认图标；
- **Windows 代码签名证书** —— 没有它用户会遇到 SmartScreen 拦截。签名配置放在 `package.json` 的
  `build.win`（`certificateFile` / `certificatePassword`，或用环境变量交给 CI）。
