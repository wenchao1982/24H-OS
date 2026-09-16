# 24H-OS

Electron 桌面壳，后端使用 [Hermes Agent](https://github.com/NousResearch/hermes-agent) 作为核心运行时
（以独立进程方式调用，不在本仓库内）。

- 许可：**Business Source License 1.1**（见 `LICENSE`）；运行时依赖归属见 `NOTICE`。

## 目录

```
electron/runtime.js   运行时管理：解析 python → 启动核心 → 解析就绪端口 → 健康检查/鉴权调用
electron/main.js      主进程：开窗、启动核心、IPC、退出时收尾
electron/preload.js   预加载：暴露最小 window.hermes API 面
src/                  渲染进程（无 Node 权限）
```

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

## 与核心的对接契约（实测于 Hermes 0.21.0）

| 环节 | 事实 |
|---|---|
| 启动命令 | `<python> -m hermes_cli.main serve --host 127.0.0.1 --port 0`（端口 0 = 核心自选，避免冲突） |
| 就绪信号 | 核心往 **stdout** 打 `HERMES_BACKEND_READY port=<N>`；随后 stderr 还有 `Hermes backend listening on 127.0.0.1:<N>` |
| 健康检查 | `GET /api/health` → `{"ok":true,"version":"0.21.0","auth_required":false}`（无需鉴权） |
| 鉴权 | `GET /` 的 HTML 里内联 `window.__HERMES_SESSION_TOKEN__="<token>"`；需要鉴权的接口带 header `Authorization: Bearer <token>`（实测 `/api/status` → 200） |
| 协议参考 | `GET /openapi.json`（265 个端点）、`GET /docs`（Swagger UI） |
| 用户数据 | 壳把 `HERMES_HOME` 指向 `app.getPath('userData')/hermes`，可用环境变量覆盖 |

## 打包（下一步）

1. 打运行时：`uv venv` + `uv pip install hermes-agent`（只装必需 extras），整个目录放进
   electron-builder 的 `extraResources` → `resources/runtime/`；
2. `appId` / `productName` / 图标 / NSIS 语言 按品牌配置；
3. Windows 代码签名（否则用户会遇到 SmartScreen 拦截）。
