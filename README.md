# 24H-OS（M3 原型）

[![CI](https://github.com/wenchao1982/24H-OS/actions/workflows/ci.yml/badge.svg)](https://github.com/wenchao1982/24H-OS/actions/workflows/ci.yml)

> 以 **Hermes** 为核心的多 agent 桌面工作台。
> M1 落地只读内核桥接层；M4 落地 **功能性 Skill 的 UI 宿主协议**（沙箱 iframe + postMessage RPC）
> 与一个可用的 **PPT demo skill**；**M2-core** 新增 **Agent 生命周期**（安装 / 更新 / 卸载 / 备份）
> 与一个静态 **小市场**；**M2 外壳**落地 **Electron 壳**（`electron/`，复用/拉起 server +
> 生产静态托管）。仍为 web-first：浏览器里即可开发调试，Electron 为桌面分发外壳。

## 项目定位

24H-OS 把本机的 `hermes` CLI 与 `~/.hermes` 文件系统抽象成一个"内核桥接层"，
再用一个桌面工作台来管理 **以 Hermes profile 为单位的 agent**：

- 一个 Hermes profile = 一个 Agent
- Agent 拥有：描述、模型、Skills、MCP Servers
- M1 只做**只读**展示；M2-core 起支持**安装 / 更新 / 卸载 / 备份**（dryRun 预览 + 确认执行）

## 架构图

```
┌─────────────────────────── 浏览器（或未来 Electron 外壳） ───────────────────────────┐
│                                                                                       │
│   web/  (React 18 + TypeScript + Vite)                                                │
│     App.tsx ── 顶部 Hermes 状态条 · 左侧 Agent 列表 · 右侧 Agent 详情                  │
│     pages/AgentDetail.tsx ── 描述 / 模型 / skills / MCP（只读，预留「编辑」）           │
│     api.ts ── fetch → http://localhost:4319                                          │
│                                                                                       │
└───────────────────────────────────────┬───────────────────────────────────────────────┘
                                         │  REST / JSON
                                         │  类型来自 shared/types.ts（前后端共享）
┌───────────────────────────────────────▼───────────────────────────────────────────────┐
│   server/  (Fastify，端口 4319) —— 内核桥接层                                          │
│                                                                                       │
│     routes/agents.ts   GET /api/agents · GET /api/agents/:id                          │
│     routes/hermes.ts   GET /api/hermes/status · /api/hermes/gateway[/start|/stop]     │
│     hermes/detect.ts   探测 CLI（env/PATH/~/.local/bin/~/.hermes/bin）+ 多 home      │
│     hermes/profiles.ts 读取 ~/.hermes/profiles/* 与 ~/.hermes 本身 → Agent 列表        │
│     hermes/gateway.ts  hermes serve 子进程 + WS JSON-RPC 客户端（M5.1）               │
│     hermes/complete.ts 模型补全降级链 gateway → `hermes -z` → stub（M5.1）            │
│     hermes/mock.ts     无 Hermes 时返回示例 agent                                      │
│     hermes/index.ts    聚合快照 { agents, status }（TTL 缓存 + 写后 invalidate）    │
│                                                                                       │
└───────────────────────────────────────┬───────────────────────────────────────────────┘
                                         │  只读访问（M1）
                                ┌────────▼────────┐
                                │  Hermes CLI /    │
                                │  ~/.hermes       │
                                └──────────────────┘
```

## 目录结构

```
24OS/
├─ package.json           # type: module，scripts: dev / dev:server / dev:web / typecheck / build / start
├─ tsconfig.json          # web + shared（strict, moduleResolution: Bundler, @shared/* 别名）
├─ tsconfig.node.json     # server + vite.config（Node 环境）
├─ vite.config.ts         # root → web/，alias @shared → shared/
├─ vitest.config.ts       # vitest（默认 Node，web/** 经 docblock 切 jsdom，@shared 别名）
├─ .github/workflows/ci.yml # CI：check（node 20/22）+ dist（tag/dispatch）
├─ scripts/
│  └─ build-server.mjs    # esbuild 打包 server → dist/server.cjs（单文件 CJS，全量内联）
├─ electron/
│  ├─ main.cjs            # Electron 主进程（复用/拉起 server；优先 dist/server.cjs）
│  └─ preload.cjs         # 最小 preload（仅 { platform }，无 Node/IPC）
├─ .gitignore
├─ README.md
├─ docs/
│  ├─ SKILL_UI_PROTOCOL.md # M4 Skill UI 宿主协议（24os-skill-ui/1）
│  ├─ CONFIG_EDITING.md    # M3 配置编辑（官方命令优先）
│  ├─ APP_MANIFEST.md      # M6 AppManifest + M7 hooks/outbound/WS
│  ├─ CRON.md              # M8 官方 Cron 薄封装 + 触发机制实证 + bots.yaml 迁移
│  ├─ CHANNELS.md          # M10 通道（channels）对齐 + 投递推荐 + Group Chat 决策
│  └─ PROFILE_ALIGN.md     # M9 Bot=Profile 对齐官方（SOUL / disabled_skills / 头像 / meta.json 降级）
├─ market/
│  ├─ index.json           # M2-core 小市场静态清单（可安装 distribution）
│  └─ apps/                # M6 内置 AppManifest（*.app.yaml）
│     ├─ ppt-maker.app.yaml
│     └─ outline-declarative.app.yaml
├─ shared/types.ts        # Agent / Skill / McpServer / HermesStatus / SkillUi* / Lifecycle* / Market* / AppManifest 等共享类型
├─ examples/
│  └─ skills/
│     ├─ ppt/             # M4 命令式 Skill demo（自带 HTML/JS，沙箱 iframe）
│     │  ├─ SKILL.md
│     │  └─ ui/{manifest.json,index.html,main.js,styles.css}
│     └─ outline/         # M4.1 声明式 Skill demo（零代码，只有 panel.yaml）
│        ├─ SKILL.md
│        └─ ui/{panel.yaml,templates/index.json}
├─ server/
│  ├─ index.ts            # Fastify 启动，注册路由，端口 4319（含生产静态托管接入）
│  ├─ paths.ts            # APP_ROOT 统一解析（源码 server/ 与打包 dist/server.cjs 同语义）
│  ├─ staticWeb.ts        # M2 外壳：web/dist 静态托管 + SPA fallback + 防穿越 + token 豁免
│  ├─ staticWeb.test.ts   # 静态托管 6 类断言单测（临时 dist fixture）
│  ├─ market.ts           # 读取 market/index.json + 合并 market/apps/*.app.yaml → MarketResponse
│  ├─ appmanifest/        # M6 AppManifest 编排
│  │  ├─ manifest.ts      # parse/validate（手写校验）+ builtin catalog
│  │  ├─ apply.ts         # install / update / uninstall / rollback
│  │  ├─ events.ts        # 极简事件总线（M7 executor 订阅）
│  │  ├─ sign.ts          # computeSourceSha256 / verifySign
│  │  ├─ store.ts         # ~/.24os/apps/<id>.json（原子写 + env 脱敏）
│  │  └─ *.test.ts
│  ├─ hooks/              # M7 hooks 执行体
│  │  ├─ executor.ts      # 订阅 app.* → ui.open/config.apply/notify + 环形日志
│  │  └─ outbound.ts      # HMAC-SHA256 签名 HTTP 推送（skipped 安全默认）
│  ├─ dashboard/
│  │  └─ bus.ts           # M7 Dashboard 广播总线（setBroadcast/broadcast）
│  ├─ hermes/
│  │  ├─ profiles.ts      # 用 yaml 库解析 config.yaml 产出结构化 Agent 列表
│  │  ├─ profiles.test.ts # YAML 解析 / 描述提取 单测
│  │  ├─ detect.ts        # 探测 hermes CLI 位置与多 home（M5.0）
│  │  ├─ detect.test.ts   # CLI 候选顺序 / home 探测 / live-mock 判定 单测
│  │  ├─ gateway.ts       # M5.1 hermes serve 子进程 + WS JSON-RPC（ping/capabilities/llm.oneshot）
│  │  ├─ gateway.test.ts  # 本地 mock WS 服务器：id 关联 / 事件 / 超时 / resolveGatewayEnv 单测
│  │  ├─ cron.ts          # M8 官方 Cron 薄封装（cron.manage RPC + cron.changed + 写前备份）
│  │  ├─ cron.test.ts     # mock gateway：list/add/pause/resume/remove/缓存失效/错误映射 单测
│  │  ├─ complete.ts      # M5.1 三级降级链 completePrompt（gateway→oneshot→stub）
│  │  ├─ complete.test.ts # 降级链 / profile 透传 / spawn 假 CLI 单测
│  │  ├─ cli.ts           # M2-core 安全执行层：spawn（不 shell）+ 子命令白名单 + dryRun
│  │  ├─ cli.test.ts      # 白名单 / dryRun / 结构化结果 单测（假 CLI）
│  │  ├─ lifecycle.ts     # M2-core install/update/delete/backup（含删除前备份）
│  │  ├─ lifecycle.test.ts# 生命周期校验 / 备份 / CONFIRM_REQUIRED 单测
│  │  ├─ errors.ts        # LifecycleError + 错误码 → HTTP 状态映射
│  │  ├─ mock.ts          # 降级示例数据
│  │  └─ index.ts         # 快照聚合 + TTL 缓存（invalidateAgentsCache 写后失效）
│  ├─ testUtils/
│  │  └─ fakeHermesCli.ts # 测试用假 hermes CLI（记录参数 + 模拟 export）
│  ├─ skillui/
│  │  ├─ discover.ts      # 扫描 skills 根，发现 ui/manifest.json(iframe) 或 ui/panel.yaml(声明式)
│  │  ├─ panel.ts         # M4.1 解析/校验 ui/panel.yaml（24os-skill-panel/1）
│  │  ├─ static.ts        # UI 静态托管路径安全 + CSP/MIME（含 yaml/yml/md）
│  │  ├─ broker.ts        # 能力 broker：capability/permission 门禁 + 工作区沙箱
│  │  ├─ tools.ts         # runTool 白名单实现（ppt.export → pptxgenjs）
│  │  └─ *.test.ts        # 发现 / panel 校验 / 静态安全 / broker / pptx 单测
│  └─ routes/
│     ├─ agents.ts        # GET /api/agents（合并 meta）、:id 详情、生命周期、skills 启停、/api/market*（M6）
│     ├─ agents.test.ts   # 路由层 fastify.inject 测试
│     ├─ marketApps.test.ts # M6 市场合并 / apps/:id / apply / agents/install 兼容
│     ├─ hermes.ts        # GET /api/hermes/status · /api/hermes/gateway[/start|/stop]
│     ├─ hermes.test.ts   # 状态 / gateway 路由（隔离真实 home）测试
│     ├─ skillUi.ts       # /api/skill-uis（含 disabled 标注）, /skill-ui/:id/*, /api/skill-host/invoke
│     ├─ ws.ts            # M7 GET /api/ws Dashboard WebSocket（鉴权同安全基线）
│     ├─ hooks.ts         # M7 GET /api/hooks/log
│     ├─ cron.ts          # M8 GET /api/cron/jobs + POST add/pause/resume/remove/run（confirm 门禁）
│     ├─ cron.test.ts     # confirm 门禁 / 参数透传 / 非法 name / 列表 测试
│     └─ m7Routes.test.ts # hooks 路由测试
└─ web/
   ├─ index.html          # Vite 入口（root = web/）
   ├─ main.tsx            # React 挂载
   ├─ App.tsx             # 整体布局（Agents / Skill 市场 / Agent 市场 / 定时 Tab + 安装入口）
   ├─ pages/AgentDetail.tsx
   ├─ components/SkillHost.tsx      # M4 命令式 Skill UI 宿主 + RPC broker + 调试面板
   ├─ components/DeclarativePanel.tsx # M4.1 声明式面板渲染（表单/模板/预览/SSE）
   ├─ components/CronPanel.tsx      # M8 定时任务视图（读官方 cron jobs + pause/resume/run/remove/add）
   ├─ components/Modal.tsx          # M2-core 通用确认弹窗
   ├─ components/CommandResult.tsx  # 命令 / exit / stdout / stderr 展示
   ├─ components/InstallAgentDialog.tsx # 安装表单 → dryRun 预览 → 确认执行
   ├─ components/StatusDrawer.tsx     # M7 Dashboard 状态抽屉（WS 事件条 + 指数退避重连）
   ├─ api.ts              # fetch 封装 → http://localhost:4319
   ├─ test-utils.ts       # 前端单测 fixture / 假 JSON·SSE Response（不连网络）
   ├─ **/*.test.{ts,tsx}  # 前端单测（docblock jsdom：api / 组件 / 页面 / App）
   └─ styles.css          # 暗色主题（手写 CSS）
├─ electron/
│  ├─ main.cjs            # M2 Electron 主进程（CommonJS + JSDoc，不进 tsconfig）
│  └─ preload.cjs         # contextBridge 仅暴露 { platform }（最小化，无 Node 能力）
```

## 如何运行

需要 **Node >= 20**（已在 Node 23 上验证）。

```bash
npm install

# 方式一：同时启动 server 与 web（推荐）
npm run dev
#   server → http://localhost:4319
#   web    → http://localhost:5173   ← 浏览器打开这个

# 方式二：分别启动
npm run dev:server   # Fastify 内核桥接层（tsx watch）
npm run dev:web      # Vite 前端（自动代理 /api → 4319）
```

浏览器访问 **http://localhost:5173**（或直接请求 **http://localhost:4319/api/agents**）。

### 其它脚本

```bash
npm run typecheck    # tsc 严格类型检查（web + server 两套配置）
npm test             # vitest 单元测试
npm run check        # typecheck + test（推荐的验证命令）
npm run build        # 构建 dist/web + dist/server.cjs + typecheck
npm run build:web    # 仅 vite build（产物 dist/web/）
npm run build:server # 仅 esbuild 打包 server（产物 dist/server.cjs，单文件 CJS）
npm run start        # 用 tsx 直接跑 server（生产原型模式）
npm run electron     # 启动 Electron 壳（main = electron/main.cjs）
npm run dev:desktop  # 先 build:web，再并发 dev:server + electron
npm run dist         # build + electron-builder --linux（产物 release/*.AppImage / *.deb）
```

### Electron 桌面壳（M2 外壳）

```bash
npm run build        # 先构建 web 产物（dist/web），server 才能静态托管
npm run electron     # 或 npm run dev:desktop（含 server）
```

- **启动策略**：探测 `http://127.0.0.1:<PORT>/api/health` 复用已运行的 server；
  不可用则以 `shell:false` 参数数组 spawn server，**存在 `dist/server.cjs` 时优先用系统 `node`
  启动该单文件产物（打包形态）**，否则回退 `tsx` 源码启动（读 `package.json#scripts.start`
  推导，dev 形态不回归），强制 `HOST=127.0.0.1`。窗口加载 `http://127.0.0.1:<PORT>`
  （server 已静态托管 `dist/web`）。
- **打包态路径解析**：系统 node 无法读取 asar 虚拟路径，故 `electron-builder` 用
  `asarUnpack` 把运行时需要真实文件路径的产物解包到 `resources/app.asar.unpacked/`；
  `electron/main.cjs` 以 `app.getAppPath()` 判定是否在 `app.asar` 内并映射到
  `app.asar.unpacked`（不硬编码 `resources/` 层级），以此解析入口脚本、`cwd` 与
  静态产物根（spawn 时显式传 `OS_WEB_DIST` 指向 unpacked `dist/web`，并以 `index.html`
  存在为前提）。dev/源码路径（无 `dist/server.cjs` → `tsx`）行为不变。

- **关闭策略**：仅当本进程拉起了 server 才 kill 子进程（复用的 dev server 不会误杀）；
  `SIGINT`/`SIGTERM` 同样走清理。
- **安全默认**：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`；
  preload 仅 `contextBridge.exposeInMainWorld('desktop', { platform })`。
- **headless（NAS 无显示器）**：无 `DISPLAY`/`WAYLAND_DISPLAY` 时先以
  `--ozone-platform=headless` 自举一次（避免 Chromium platform 初始化 SIGTRAP），
  `app.whenReady()` 后打印
  `headless 环境无法创建窗口，server 已就绪：http://127.0.0.1:<PORT>`
  并以 **退出码 0** 结束（清理自启 server，不留残留）。有显示器时正常开窗。
- **打包（electron-builder）**：已接入 electron-builder@26（配置见 `package.json#build`，
  `appId: im.24h.os`、`productName: 24H-OS`、`asar: true`、
  `asarUnpack: [dist/server.cjs, dist/web/**, market/**, examples/skills/**]`、
  `directories.output: release`，
  `files: electron/** + dist/server.cjs + dist/web/** + market/** + examples/skills/** + package.json`，
  `linux.target: [AppImage, deb]`，`linux.category: Utility`；未配置自定义 icon，使用 Electron 默认图标）：

  ```bash
  npm run dist         # = npm run build && electron-builder --linux
  ```

  产物：`release/24H-OS-<ver>.AppImage`、`release/<name>_<ver>_amd64.deb`、
  `release/linux-unpacked/`（内含 `resources/app.asar` 与
  `resources/app.asar.unpacked/`）。**asarUnpack 方案（而非 `asar:false`）**：保留 asar 主体
  （安装/完整性/启动更优），仅解包运行时必须为真实文件的 `dist/server.cjs`、`dist/web/**`，
  以及需要被系统 node `readFileSync`/`readdirSync` 读取的 `market/**`、`examples/skills/**`
  （系统 node 不认 asar 虚拟路径；`files` 必须同步包含这些路径，否则不会被打进包）。
  校验：
  - asar 内包含 `electron/main.cjs`、`electron/preload.cjs`、`package.json`（`dist/*`、`market/*`、`examples/*` 为解包占位）；
  - `release/linux-unpacked/resources/app.asar.unpacked/dist/server.cjs` 与
    `.../dist/web/index.html` 存在（系统 node 可直接执行）；
  - `.../app.asar.unpacked/market/index.json`、`.../market/apps/*.app.yaml`、
    `.../examples/skills/{ppt,outline}/ui/*` 存在。
  server 单文件产物由 `scripts/build-server.mjs`（esbuild）生成：**全量内联**（约 2.7 MB，
  无需运行时 node_modules）；若某依赖不兼容打包则自动回退 `packages:"external"` 并在日志注明。
  `import.meta.url` 由 esbuild `define` + banner shim 还原为产物自身路径；
  解包后 `server.cjs` 位于 `app.asar.unpacked/dist/`，`server/paths.ts#APP_ROOT` 自然解析到
  `app.asar.unpacked/`，`dist/web`、`market/**`、`examples/skills/**` 因此命中同一解包根
  （`electron/main.cjs` 亦显式传 `OS_WEB_DIST` 兜底；`OS_MARKET_FILE`/`OS_MARKET_APPS_DIR`/
  `OS_SKILL_ROOTS` 的默认值均基于 `APP_ROOT`，**故无需为子进程额外传这些 env**，用户显式设置的值不被覆盖）。

### 生产静态托管

`server/staticWeb.ts`：当 `dist/web/index.html`（或 `web/dist`，可用 `OS_WEB_DIST` 覆盖）存在时，
server 兼作静态站点：

- `GET /` 与未知路径 → 送 `index.html`（SPA fallback）；
- `GET /assets/*` 等 → 送文件（白名单扩展名）；
- `/api/*`、`/skill-ui/*` 保留给路由，未命中仍返回 JSON 404；
- 路径解析后必须仍在 dist 根内（防穿越，`/../secret` 一类返回 404）；
- **token 顺序**：启用静态托管且回环监听时，非 `/api`、`/skill-ui` 的 GET/HEAD
  可免 `x-24os-token`（浏览器加载页面无法带自定义头）；**非回环监听不豁免**（安全基线不放松）；
- 构建产物不存在时**行为不变**（纯 API 模式，dev 不受影响）。

## Hermes 依赖说明

`server/hermes/detect.ts` 启动时与每次快照刷新时探测（只读，不修改任何用户文件）：

- **CLI 候选顺序**：`OS_HERMES_CLI`（显式路径）→ `PATH` 里的 `hermes`（`which`）→
  `~/.local/bin/hermes` → `<home>/bin/hermes`。返回 `cliPath` 与 `cliSource`
  （`env` / `path` / `local-bin` / `hermes-bin`），因此**不在 PATH 上的安装也能被发现**。
  **显式无效即停**：`OS_HERMES_CLI` 已设置但指向不存在的路径 → CLI 视为不可用
  （`cliSource:"env"`、`cliPath:null`），**不**再回退 PATH / `~/.local/bin` 探测
  （与 `cli.ts#resolveHermesCli` 一致）。
- **HERMES_HOME 解析顺序**：`OS_HERMES_HOME` → `HERMES_HOME`（env）→ `~/.hermes`；
  另探测候选 home：`~/.hermes`、`~/hermes-desktop/home`（含 `config.yaml`/`profiles` 才算有效），
  状态里暴露 `activeHome` 与 `hermesHomes[]`。显式 home env **无效即停**（目录不存在也直接采用，
  不静默换家）。
- **live 模式**：找到 CLI，**或**探测到任一有效 hermes home（有配置 / profiles）→
  读取 `~/.hermes/profiles/<name>/`（每个目录一个 agent）；若没有命名 profile，
  则把生效 home 本身当作名为 `default` 的默认 profile。
- **mock 模式**：既无 CLI 又无任何有效 home → 返回 `server/hermes/mock.ts` 里的示例 agent，
  并在 `/api/hermes/status` 标记 `available:false, mode:"mock"` 与中文说明。
- 前端顶部状态条会显示 **LIVE / MOCK** 徽标与说明字符串；`HermesStatus` 新增
  `cliSource` / `activeHome` / `hermesHomes` 字段（旧字段保持兼容）。
- **CLI home 一致性（M5.x）**：若 `hermes` 是包装脚本（本机 `~/.local/bin/hermes`），
  `resolveCliHome()` 解析脚本里的 `export HERMES_HOME=...`，在无显式
  `OS_HERMES_HOME` / `HERMES_HOME` 时以其声明目录作为 `activeHome`，并纳入 `hermesHomes`。
  `profiles.ts` / `configEdit.ts` 与 CLI 使用**同一个** home，避免「CLI 写 A、文件回退写 B」。
- 本服务对 Hermes 的**只读探测与配置编辑**分开：探测/展示不写盘；配置编辑走 M3 的安全
  保证（confirm / 备份 / 原子写 / 密钥不回显），并**官方命令优先**（见下节）。

## 安全基线

内核桥接层默认按“仅本机可用”加固：

- **监听地址**：默认 `HOST=127.0.0.1`（不再默认 `0.0.0.0`），避免无意暴露到局域网。
- **CORS**：从环境变量 `OS_ALLOWED_ORIGINS`（逗号分隔）读取白名单，
  默认仅放行本地 Vite dev server：`http://localhost:5173,http://127.0.0.1:5173`。
  设为空字符串可完全关闭跨域响应头。
- **Token**：当 `HOST` 被设为非回环地址（如 `0.0.0.0`）时，**强制要求** `OS_TOKEN`，
  否则启动即报错退出；此时所有请求都必须带 `x-24os-token` 头，否则返回 `401`。
  默认回环监听下可不设置 token，但该代码路径始终可用。
- **错误结构**：全局错误处理器 + 未匹配路由统一返回 `shared/types.ts` 的 `ApiError`
  （`{ error, message }`）。

```bash
# 仅本机（默认，最安全）
npm run dev:server

# 需要局域网访问时：显式设置 token，再监听非回环地址
HOST=0.0.0.0 OS_TOKEN=$(openssl rand -hex 16) npm run dev:server
```

## 结构化类型

`shared/types.ts` 里的结构化类型已在 M1.1 落地：

- `Agent.skills: Skill[]`（`Skill { id, name, description?, path?, enabled? }`）
- `Agent.mcpServers: McpServer[]`（`McpServer { id, name, command?, args?, enabled? }`）

M3 起新增配置编辑相关类型：`AgentConfig`、`McpServerSpec`、`UpdateAgentConfigRequest`、
`AddMcpServerRequest`、`SetEnvRequest`、`SetSkillEnabledRequest`、`ConfigEditResult`（见 `shared/types.ts`）。
`McpServer` 增加 `url` / `headers` / `transport`，以支持 http 型 MCP server；
`Agent.tags?` 承接 meta 标签；`SkillUiInfo.disabled?` 标注被禁用的 skill UI。

`server/hermes/profiles.ts` 从 `config.yaml` / `agent.json` 解析出上述结构，
`mock.ts` 提供同构示例数据，`web/pages/AgentDetail.tsx` 直接渲染 skill 描述、
MCP command/args 与启用状态；`GET /api/agents` 列表与 `GET /api/agents/:id` 详情
返回结构化数据并**合并工作台 meta**（description / tags / skills 启停，优先级一致）。
`server/hermes/configEdit.ts` 负责配置的读写与安全落盘（含 skill 启停），
前端由 `web/components/AgentConfigEditor.tsx` 承载编辑界面；被禁用的 skill 在
AgentDetail / Skill 列表显示「已禁用」，且**不渲染打开入口**（服务端字段为准）。

## Skill UI 协议（24os-skill-ui/1）

> 差异化核心：Hermes 自身的 skill 只有 `SKILL.md`、没有 UI。24H-OS 让**功能性 skill 自带前端**，
> 由宿主在**沙箱 iframe**（`sandbox="allow-scripts"`）中加载，并通过 **postMessage RPC 桥**
> 按需注入能力（调模型 / 读写文件 / 跑工具）。完整细节见 [`docs/SKILL_UI_PROTOCOL.md`](docs/SKILL_UI_PROTOCOL.md)。

一个带 UI 的 skill 目录：

```
<skills-root>/<skillId>/
  SKILL.md
  ui/
    manifest.json   # 协议声明（protocol/id/title/entry/host/capabilities/permissions/size）
    index.html      # 入口（无内联脚本）
    main.js
    styles.css
```

`ui/manifest.json`（v1）：

```json
{
  "protocol": "24os-skill-ui/1",
  "id": "ppt",
  "title": "PPT 工作台",
  "entry": "index.html",
  "host": "iframe",
  "capabilities": ["callModel", "readFile", "writeFile", "runTool", "emitEvent", "resize"],
  "permissions": ["fs:read:workspace", "fs:write:workspace", "model:call", "tool:ppt.export"],
  "size": { "width": 980, "height": 660 }
}
```

**RPC 约定**（postMessage，按 `id` 关联请求/响应）：

- UI → 宿主：`{ __24os: true, id, method, params }`
- 宿主 → UI：`{ __24os: true, id, ok, result? , error? }`
- 握手：宿主在 iframe `load` 后发 `{ __24os: true, type: "host.init", payload: { protocol, capabilities, permissions, sessionNonce } }`；UI 就绪回 `{ __24os: true, type: "ui.ready" }`。
- 方法：`callModel`（M5.1 起走真实 Hermes，三级降级：gateway → `hermes -z` → stub，见下节）、`chatStream`（M5.2 起走 gateway 会话 SSE，事件经 `type:"event"` 转发，见 §M5.2）、`readFile`、`writeFile`、`runTool`、`emitEvent`、`resize`。

**安全边界**：

- 宿主校验 `event.source === iframe.contentWindow`、`__24os === true`，且 `method ∈ capabilities`；
- 静态托管防目录穿越，仅服务白名单扩展名（html/js/css/json/png/svg/woff2 + M4.1 的 yaml/yml/md）；
- 严格 CSP：`default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'` + `X-Content-Type-Options: nosniff`（UI 自身禁止联网，一切能力走 RPC）；
- broker 双重门禁（capability + permission）；`readFile`/`writeFile` 限制在 `~/.24os/workspace/<skillId>/`（防穿越）。

### PPT demo 怎么打开

仓库内置 demo：`examples/skills/ppt/`（三个模板、可编辑标题/要点、增删页、一键生成 PPTX）。

```bash
# 启动（默认会自动扫描仓库内 examples/skills）
npm run dev
#   server → http://localhost:4319
#   web    → http://localhost:5173   ← 浏览器打开这个
```

1. 打开 `http://localhost:5173`；
2. 左侧切换到 **「Skill 市场」** Tab → 点 `PPT 工作台` 的「打开 Skill UI」；
   或在 **Agents** 里选中一个含 `ppt` skill 的 agent（mock 的 `studio`），点 skill 行的「打开 Skill UI」；
3. 在弹出面板里编辑内容 → 「生成 PPTX」；生成文件位于
   `~/.24os/workspace/ppt/deck.pptx`（可用 `OS_WORKSPACE_ROOT` 覆盖根目录）；
4. 右侧是宿主**调试面板**（每次 RPC 的 method/摘要/耗时/结果 + 敏感能力提示），
   UI 内部也有对应的 RPC 日志区。

自定义 skill 根目录：

```bash
OS_SKILL_ROOTS=/abs/path/to/skills,$HOME/.hermes/skills npm run dev:server
```

### 声明式面板（24os-skill-panel/1，M4.1）

> 为不具备前端能力的 skill 作者提供**零代码** UI：只写一个 `ui/panel.yaml`，
> 宿主自动渲染表单 / 模板画廊 / 预览 / 动作按钮。**无任意 JS**，比 iframe 形态更安全。
> 与命令式形态**并存**：`ui/manifest.json` = 命令式（`uiHost:"iframe"`），
> `ui/panel.yaml` = 声明式（`uiHost:"declarative"`）；两者都有时**优先 manifest**。

```
<skills-root>/<skillId>/
  SKILL.md
  ui/
    panel.yaml          # 协议声明（protocol/skill/title/view/fields/templates/preview/actions）
    templates/index.json  # 可选：模板清单（select.options_from / 画廊）
```

`ui/panel.yaml`（v1）：

```yaml
protocol: 24os-skill-panel/1
skill: outline
title: 大纲生成
view: form              # form | wizard（wizard 当前按 form 渲染）
description: 选主题、定深度，一键生成大纲
fields:
  - key: topic
    label: 主题
    type: text          # text | textarea | select | slider | file
    required: true
    placeholder: 例如：AI 产品年度规划
  - key: depth
    label: 层级深度
    type: slider
    min: 1
    max: 4
    default: 2
  - key: template
    label: 结构模板
    type: select
    options_from: templates/index.json   # 相对 ui/ 的动态枚举
templates:
  dir: templates/
  index: templates/index.json
actions:
  - id: run
    label: 生成大纲
    kind: prompt        # 目前仅 prompt
    prompt: |           # {{field_key}} 插值
      请以「{{topic}}」为主题，生成 {{depth}} 级深度的结构化大纲。
```

**校验规则**：`protocol` 必须匹配；`fields[].type` 在枚举内；`select` 需有非空
`options` 或 `options_from`；`actions[].kind` 恒为 `prompt` 且 `prompt` 必填非空；
非法 panel.yaml 视为“无声明式 UI”（`validatePanel` 另返回带原因的失败）。校验为
**手写**（不引入 zod，保持依赖最小）。

**DeclarativePanel 支持的能力**：text / textarea / select（`options_from` 拉取 JSON）/
slider / file（仅本地读取为文本或 base64 data URL，**不上传**）；`templates/index.json`
缩略图画廊；`preview`（iframe / markdown）同源沙箱预览；动作按钮把插值后的 prompt
经 `POST /api/hermes/chat/stream`（SSE）流式展示（delta / 工具 / 审批 / 完成 / 错误，
可中断）；必填字段校验 + `{{key}}` 缺失策略（默认空串，可 keep / error）。

#### outline demo 怎么打开

仓库内置声明式 demo：`examples/skills/outline/`（无任何 JS/HTML）。

```bash
npm run dev
#   web → http://localhost:5173
```

1. 左侧 **「Skill 市场」** Tab → `大纲生成`（标注「声明式面板」）→「打开 Skill UI」；
2. 填主题 / 目标读者 / 层级深度 / 补充要求（结构模板可下拉或点画廊）；
3. 点「生成大纲」→ 右侧流式输出；未接真实 Hermes 时会降级提示。

### /api 新增端点

| 端点 | 说明 |
| --- | --- |
| `GET /api/skill-uis` | 列出所有自带 UI 的 skill（`SkillUiInfo[]`，含 `uiHost`；被 meta 禁用者标 `disabled:true`）。 |
| `GET /api/skill-uis/:id` | 单个 UI 信息（含 `disabled` 标注），未找到 404。 |
| `GET /api/skill-uis/:id/panel` | 声明式面板规范 `PanelSpec`；非声明式 / 未找到 → 404 `PANEL_NOT_FOUND`；**禁用 → 403 `SKILL_DISABLED`**。 |
| `GET /skill-ui/:id/*` | 静态托管该 skill 的 `ui/` 文件（防穿越 + 严格 CSP）。口径：skill 不存在 404 → **禁用 403 `SKILL_DISABLED`** → 文件缺失/越界 404（先判存在再判禁用；存在性已由列表 API 公开，403 不额外泄露且可与 404 区分）。 |
| `POST /api/skill-host/invoke` | 能力 broker：`{ skillId, method, params }` → `{ ok, result?, error? }`（未声明 capability/permission → 403；**禁用 → 403 `SKILL_DISABLED`**，iframe 与 declarative 都拦）。 |

skills 根发现顺序：`OS_SKILL_ROOTS` → 仓库 `examples/skills` → `<activeHome>/skills` → `<activeHome>/profiles/*/skills`。
`<activeHome>` 由 `detect.ts` 解析（M5.0b 起与 agent 来源一致，不再硬编码 `~/.hermes`）。
`GET /api/agents` 的 `Skill` 新增 `hasUi` / `uiId` 字段；被工作台 meta 标记
`enabled:false` 的 skill 在详情里 `enabled:false`（前端显示「已禁用」、不渲染打开入口），
对应 `SkillUiInfo` 也标 `disabled:true`。禁用判定统一在 `server/skillui/disabled.ts`
（`isSkillDisabled`，每次读盘、与列表 `disabled` 同口径），broker / panel / 静态三条路径强制拦截。

## Hermes TUI gateway 与模型补全（M5）

M5 把 Skill UI 的 `callModel` 从桩替换为**真实 Hermes**。主通道是 `hermes serve`
提供的 JSON-RPC over WebSocket（desktop/TUI 同款 gateway），并带三级降级。

### 契约（实测 + 源码确认）

WS 端点为 `ws://127.0.0.1:<port>/api/ws?token=<SESSION_TOKEN>`；token 由 `GET /`
的 HTML 注入 `window.__HERMES_SESSION_TOKEN__`。帧格式：

- 请求 `{ "jsonrpc":"2.0", "id", "method", "params" }`
- 响应 `{ "jsonrpc":"2.0", "id", "result" | "error" }`
- 通知 `{ "jsonrpc":"2.0", "method":"event", "params":{ "type", "session_id", "payload?" } }`

`complete` 最终使用方法 **`llm.oneshot`**（最简单可拿到文本的通道）：
params `{ input, profile?, max_tokens?, temperature? }` → result `{ text }`。
依据：`hermes-agent/tui_gateway/contracts/sessions.py` 的 `LlmOneshotParams` 与
`methods_session.py` 的 `@method("llm.oneshot")`；并已用一句极短 prompt 实机验证返回 `{text:"pong"}`。
另有 `ping`（`{pong:true}`）、`gateway.capabilities`（`{per_session_exclusive_submit}`）、
`tools.list` 可用，作为通道自检（见 `scripts/` 实测与 `gateway.test.ts`）。

### 三级降级链（`server/hermes/complete.ts`）

1. **gateway**：`ensureGateway(cliPath)` 幂等拉起 `hermes serve --port <OS_GATEWAY_PORT> --skip-build [--isolated]`，
   解析 stdout 的 `HERMES_BACKEND_READY port=<N>`，提取 token 后建立 WS，调用 `llm.oneshot`；
2. **oneshot**：gateway 不可用时 `spawn(cliPath, ["-p"? , profile, "-z", prompt])`（prompt 作为单个参数，无 shell），取 stdout；
3. **stub**：全不可用 → `[stub] ...` 文本。

每次返回附 `via: "gateway" | "oneshot" | "stub"`（`callModel` 的 result 含该字段），便于宿主调试面板显示。
所有 `spawn` 一律 `shell:false`。

### 端点与环境变量

| 端点 | 说明 |
| --- | --- |
| `GET /api/hermes/gateway` | gateway 状态：`{ running, port, connected, cliPath, via, lastError, message }`。 |
| `POST /api/hermes/gateway/start` | 幂等启动 gateway（非破坏性，不强制 confirm）；无 CLI → 503。 |
| `POST /api/hermes/gateway/stop` | 幂等停止由本进程拉起的 gateway。 |

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `OS_GATEWAY_PORT` | gateway 固定端口 | `0`（由 OS 自选；`hermes serve` 自身默认 9119） |
| `OS_GATEWAY_ISOLATED` | 设为 `1` 时加 `--isolated`（探测/测试用独立后端） | 关 |
| `OS_GATEWAY_START_TIMEOUT_MS` | 等待 `HERMES_BACKEND_READY` 的超时 | `30000` |
| `OS_CRON_TICKER` | `0` 关闭「serve 带 `HERMES_DESKTOP=1` 触发官方 cron ticker」 | 开 |

server 收到 `SIGINT` / `SIGTERM` 时会 `stop()` 自己拉起的 gateway，避免残留 `hermes serve` 进程。
新增错误码：`GATEWAY_UNAVAILABLE`(503) / `GATEWAY_TIMEOUT`(504) / `GATEWAY_RPC_ERROR`(502)。

### 会话与流式（M5.2）

`server/hermes/chat.ts#streamPrompt` 在 gateway 上串起
`session.create` → `prompt.submit` → 事件订阅 → `session.close`，并把原始帧归一化：

- **会话方法**（`GatewayClient`）：`createSession(params)`、`submitPrompt(sessionId, text)`、
  `interrupt(sessionId)`、`closeSession(sessionId)`；连接建立后自动发
  `client.capabilities { server_requests:true }`，否则收不到服务端请求。
- **归一化事件**（`ChatStreamEvent`，`shared/types.ts`）：
  `session` | `delta` | `message` | `thinking` | `tool.start` | `tool.complete` |
  `subagent` | `approval` | `clarify` | `done` | `error` | `raw`（未知类型原样透出）；
  `subagent.*` 事件单独归一化为 `type:"subagent"`（`phase`：`spawn_requested|start|progress|thinking|tool|complete`，
  未知 phase 保守为 `unknown`）；`request.cancel` 归入 `session`。
  映射依据 `tui_gateway/contracts/events.py` 与 `contracts/server_requests.py`。
- **审批策略（M5 交互式 + 安全默认）**：
  - `OS_GATEWAY_AUTO_APPROVE=1` → 立即 `once` / 第一个选项（`autoDecided:true`，不打断 UI）；
  - SSE（`interactive:true`）→ 挂起 pending，事件携带 `{chatId, id, choices?, prompt?}`，
    前端渲染决策卡片 → `POST /api/hermes/chat/decide` → `decideApproval` `respond` 回 gateway；
  - 非交互通道 → 立即安全默认 `deny` / 空答案；
  - 交互流超时（`decisionTimeoutMs`，默认 120s）/ 结束仍 pending → 自动安全默认兜底 +
    `decision.fallback` 事件（`reason: timeout|stream_end`）。
  依据 `ApprovalChoice`（`once/session/always/deny`，`contracts/server_requests.py`）。
- **模型（M5 热切换 + 昂贵模型二次确认）**：`streamPrompt({model})` → `session.create.model`
  （`contracts/sessions.py::SessionCreateParams`）+ 随后经 `switchSessionModel` 走
  `config.set {key:"model", session_id}` 的 **selection guard**（`contracts/config_free_tier_control.py`
  + `methods_config_set.py::_set_model`；running 会话为 `deferred` 下一 turn 生效）。
  **契约二次确认键 = `confirm_expensive_model`**（`ConfigSetParams`，Params `extra=forbid`
  —— 不能发未声明的 `force`；CLI 的 `config set --force` 只跳过 unknown-key 提示，与昂贵模型无关）。
  工作台对外的 `force` 选项映射为该键。流程：不带 force 且非 `OS_GATEWAY_AUTO_APPROVE=1` 时，
  昂贵模型 → `confirm_required` → SSE 透出 `session/model.confirm_required` 事件
  （payload `{ model, confirmRequired, confirmMessage }`）并 **interrupted 结束（不提交 prompt、不静默放行）**；
  前端 Modal 确认 → 带 `force:true` 重试 SSE；取消 → 明确提示。
  `OS_GATEWAY_AUTO_APPROVE=1` → 与审批策略一致自动 force。
  `completePrompt` 的 `hermes -z` 通道支持 `-m/--model`（`hermes_cli/_parser.py`）。
- **subagent（观测/控制 + 事件；无 spawn API）**：gateway v0.21.3 **没有直接 spawn/run RPC**；
  子代理由父会话内 LLM 调用**工具 `delegate_task`**在**同进程**内创建
  （`delegation.max_spawn_depth` 默认 1）。工作台 `server/hermes/subagent.ts` 薄封装官方
  **观测/控制** RPC（`subagent.list/tail/interrupt/steer`、`delegation.pause`），并透出
  `subagent.*` 事件为归一化 `type:"subagent"`。`getSubagentSupport()` →
  `{ spawnApi:false, controlApi:true, events:true, mechanism:"delegate_task (in-session tool)" }`。
  旧 `POST /api/hermes/subagent` 语义修正为 **501 `SPAWN_UNSUPPORTED` + 说明**（不调模型）。

| 端点 | 说明 |
| --- | --- |
| `POST /api/hermes/chat/stream` | SSE：body `{ profile?, prompt, chatId?, model?, force? }`，逐条 `data: <ChatStreamEvent>`；交互流（approval/clarify 待 decide，超时安全兜底）；客户端断开时 `interrupt` 并清理。`force:true` = 昂贵模型二次确认放行（确认后的重试）。 |
| `POST /api/hermes/chat/decide` | `{ chatId, type: "approval"\|"clarify", choice?, answer? }` → `{ ok, requestId, decision }`；400 `INVALID_VALUE` · 404 `CHAT_NOT_FOUND` · 409 `DECISION_RESOLVED`。（模型昂贵确认不经此端点——重试走 SSE body `force`。） |
| `GET /api/hermes/subagents?sessionId=<id>` | 列出该会话活跃子代理（`subagent.list`）；**无 sessionId 时按 0 条返回**（子代理按会话隔离）。只读。 |
| `GET /api/hermes/subagents/:id/tail?sessionId=<id>` | 最近 16KB 实时转录（`subagent.tail`）。只读。 |
| `POST /api/hermes/subagents/:id/steer` | `{ sessionId, text }` → 投递 steering（`subagent.steer`，**非破坏，不需 confirm**）。 |
| `POST /api/hermes/subagents/:id/interrupt` | `{ sessionId, confirm:true }` → 硬中断（`subagent.interrupt`，**控制面须 confirm**）。 |
| `POST /api/hermes/subagents/pause` | `{ paused?, confirm:true }` → 全局暂停/恢复 spawn（`delegation.pause`，**须 confirm**）。 |
| `POST /api/hermes/subagent` | 已废弃 spawn 入口：`{ profile?, prompt }` → **501 `SPAWN_UNSUPPORTED`** + 能力说明（不调模型）。 |

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `OS_GATEWAY_AUTO_APPROVE` | 设为 `1` 时**优先自动**放行审批（`approval→once`、`clarify→第一个选项`，不打断 UI）**并对昂贵模型切换自动 force**（`confirm_expensive_model:true`）；否则 SSE 交互流挂起待 `chat/decide`，非交互立即安全默认 deny | 关（SSE 交互等待 decide；非交互 deny） |

Skill UI 侧新增 `chatStream` capability（权限 `model:chat`）：`SkillHost.tsx` 读取该 SSE 并把事件以
`{ __24os:true, type:"event", event:"chat.delta"|"chat.done"|"chat.error"|…, payload }` 转发给 iframe；
宿主侧同步渲染审批/澄清卡片（M5）与模型下拉；broker 的 REST 路径则把流收集为 `{ text, status, events }`。

## Agent 生命周期 API（M2-core）

复用 Hermes 原生 CLI 能力，对 `~/.hermes` 里的 profile 做安装 / 更新 / 卸载 / 备份。
**本机可能没有 `hermes` CLI**，因此所有能力在「CLI 不可用」时都会优雅降级（返回明确错误码，不影响只读展示）。

| 端点 | 说明 |
| --- | --- |
| `POST /api/agents` | 安装。body `{ source, name?, alias?, confirm?, dryRun? }`。`source` 为 `http(s)://` / `git@` / `ssh://` URL 或**已存在的本地目录**。 |
| `POST /api/agents/:id/update` | 更新。body `{ confirm?, dryRun? }`。 |
| `DELETE /api/agents/:id` | 卸载。body `{ confirm?, backup?, dryRun? }`，`backup` 默认 `true`（删除前先 `export`）。 |
| `POST /api/agents/:id/backup` | 导出 profile 为 tar.gz。body `{ dryRun? }`（可选）。 |

统一返回 `LifecycleResult { ok, action, command, stdout, stderr, code, backupPath?, dryRun? }`；
错误沿用 `ApiError { error, message }`，`error` 为下列错误码：

| 错误码 | HTTP | 含义 |
| --- | --- | --- |
| `CONFIRM_REQUIRED` | 400 | 非 dryRun 的破坏性操作未带 `confirm:true`。 |
| `INVALID_SOURCE` | 400 | source 不是合法 URL 或已存在的本地目录。 |
| `INVALID_NAME` | 400 | name / id 不匹配 `^[a-z0-9][a-z0-9_-]{0,63}$`。 |
| `COMMAND_NOT_ALLOWED` | 400 | 命令不在子命令白名单内。 |
| `HERMES_CLI_UNAVAILABLE` | 503 | 未检测到可用 hermes CLI。 |
| `COMMAND_FAILED` | 502 | CLI 执行失败 / 超时 / 备份未生成。 |

**两段式确认（dryRun）**：前端先调 `dryRun:true` 拿到将执行的 `command`（此模式不要求 confirm、
即使无 CLI 也可预览），用户确认后再带 `confirm:true` 真正执行。

```bash
# 预览安装命令（不执行，无需 CLI）
curl -s -X POST localhost:4319/api/agents -H 'content-type: application/json' \
  -d '{"source":"https://github.com/hermes-profiles/code-reviewer.git","name":"reviewer","alias":true,"dryRun":true}'
# → {"ok":true,"action":"install","command":"hermes profile install ... --name reviewer --alias",...,"dryRun":true}

# 不带 confirm 直接执行 → 400 CONFIRM_REQUIRED
curl -s -X POST localhost:4319/api/agents -H 'content-type: application/json' \
  -d '{"source":"https://github.com/hermes-profiles/code-reviewer.git"}'
# → {"error":"CONFIRM_REQUIRED","message":"安装需要显式 confirm:true。"}

# 无 CLI 时备份 → 503 HERMES_CLI_UNAVAILABLE（优雅降级）
curl -s -X POST localhost:4319/api/agents/reviewer/backup -H 'content-type: application/json' -d '{}'
# → {"error":"HERMES_CLI_UNAVAILABLE", ...}
```

环境变量：`OS_HERMES_CLI`（覆盖 CLI 路径）、`OS_BACKUP_DIR`（备份目录，默认 `~/.24os/backups`）。

## Agent 配置编辑 API（M3 · M9 对齐官方 Profile）

让工作台把用户在 UI 里的修改**安全地落盘**到 agent：
模型（`config.yaml` 顶层 `model`）、人设（官方 `SOUL.md`）/ 短描述（官方 `profile.yaml`）
+ 标签（工作台自有元数据 `~/.24os/agents/<id>/meta.json`）、MCP servers（`config.yaml`
顶层 `mcp_servers`）、环境变量 / 密钥（`.env`）、头像（官方 `assets/avatar.*`）。
完整设计见 [`docs/CONFIG_EDITING.md`](docs/CONFIG_EDITING.md) 与
[`docs/PROFILE_ALIGN.md`](docs/PROFILE_ALIGN.md)。

### 写入策略：官方优先（M5.x CLI + M9 Profile RPC）

为避免与运行中的 Hermes 进程**并发写 config.yaml**，每个写操作**先尝试官方通道**，成功即
返回 `via:"cli"`（官方 CLI）或 `via:"rpc"`（官方 `profiles.configure`，复用已连接的共享
gateway）；官方不可用 / 失败才回退工作台文件写（`via:"file"`，保留备份 / 原子写）：

| 配置 | 官方通道 |
| --- | --- |
| 模型 | `hermes [-p <id>] config set model <value>`（cli） |
| MCP 增 / 改 | `hermes [-p <id>] config set mcp_servers.<name> <JSON spec>`（cli） |
| MCP 删 | `hermes [-p <id>] config unset mcp_servers.<name>`（cli） |
| env 设 / 删 | `hermes [-p <id>] config set\|unset <KEY> [<value>]`（cli） |
| 人设（soul） | `profiles.configure {soul}` → `SOUL.md`（rpc；回退写 SOUL.md） |
| 短描述 | `profiles.configure {description}` → `profile.yaml`（rpc；回退 meta.json） |
| skill 启停 | `profiles.configure {disabled_skills}` → `config.yaml skills.disabled`（rpc；回退 meta.json） |
| 标签 | ——（Hermes 无此字段，恒写 `meta.json`） |

`-p` 规则：`default`（或目录 == activeHome）不加，否则 `-p <id>`；参数一律走 `spawn(shell:false)`。
MCP 未用交互式 `mcp add`（discovery-first + 无 `mcp update`），详见 `docs/CONFIG_EDITING.md` §0.2。

| 端点 | 说明 |
| --- | --- |
| `GET /api/agents/:id/config` | 读取 `AgentConfig`（`envKeys` 只含键名，绝不返回值；含 `soul`）。 |
| `PATCH /api/agents/:id/config` | body `{ model?, description?, soul?, tags?, confirm? }`（soul → 官方 SOUL.md；description → 官方 profile.yaml）。 |
| `POST /api/agents/:id/mcp` | body `{ name, spec, confirm? }`，新增 MCP server。 |
| `PATCH /api/agents/:id/mcp/:name` | body `{ spec, confirm? }`，更新 MCP server。 |
| `DELETE /api/agents/:id/mcp/:name` | body `{ confirm? }`，删除 MCP server。 |
| `POST /api/agents/:id/env` | body `{ key, value, confirm? }`，设置环境变量。 |
| `DELETE /api/agents/:id/env/:key` | body `{ confirm? }`，删除环境变量。 |
| `POST /api/agents/:id/config/restore` | body `{ backupFileName, confirm? }`，从备份还原（可选）。 |
| `POST /api/agents/:id/skills` | body `{ name, enabled, confirm:true }`，skill 启停（官方 `disabled_skills` 优先，回退 `meta.json`；未知 skill → 400 `INVALID_SKILL`）。 |
| `GET /api/agents/:id/avatar` | 读取头像（官方 `profiles.get_asset`；未设置 `{ found:false }`）。 |
| `POST /api/agents/:id/avatar` | body `{ data, confirm:true }`，上传头像（**PNG/JPEG ≤256KB**，魔法字节嗅探）。 |

统一返回 `ConfigEditResult { ok, action, via, files, backups, message }`，其中 `via`
标示本次落盘通道（`"cli"` = 官方 CLI、`"rpc"` = 官方 Profile RPC、`"file"` = 工作台文件写；
官方通道成功时 `files`/`backups` 通常为空）。
错误沿用 `ApiError`，除上表错误码外新增：

| 错误码 | HTTP | 含义 |
| --- | --- | --- |
| `INVALID_KEY` | 400 | 环境变量名不匹配 `^[A-Z][A-Z0-9_]*$`。 |
| `INVALID_VALUE` | 400 | 值非法（如 model 为空、值含换行）。 |
| `INVALID_MCP_SERVER` | 400 | MCP 名 / spec 非法。 |
| `MCP_SERVER_EXISTS` | 409 | 新增时 MCP server 已存在。 |
| `MCP_SERVER_NOT_FOUND` | 404 | 更新 / 删除的 MCP server 不存在。 |
| `CONFIG_PARSE_FAILED` | 400 | `config.yaml` 无法解析，放弃写入以保护原文件。 |
| `PATH_TRAVERSAL` | 400 | 检测到路径穿越（id 或备份文件名）。 |
| `BACKUP_NOT_FOUND` | 404 | 备份文件不存在。 |
| `AGENT_NOT_FOUND` | 404 | 找不到对应 profile 目录。 |
| `INVALID_SKILL` | 400 | skill 启停时名字不在该 agent 已知 skills 列表中。 |
| `INVALID_ASSET` | 400 | 头像非法 / 过大（非 PNG/JPEG 或 >256KB）。 |
| `PROFILE_NOT_FOUND` | 404 | 官方 Profile RPC 报告 profile 不存在。 |
| `PROFILE_RPC_ERROR` | 502 | 官方 Profile RPC 返回业务错误。 |

**写操作保证**（文件回退路径）：

1. **confirm**：任何写操作未带 `confirm:true` → 400 `CONFIRM_REQUIRED`，不触碰磁盘；
2. **备份**：写前把目标文件复制到 `~/.24os/backups/<id>/<file>.<ISO时间戳>.bak`，
   每个文件最多保留 10 份（超出删最旧）（走官方 CLI 时由 Hermes 自身原子写，工作台不再备份）；
3. **原子写**：先写同目录临时文件再 `rename`，避免半截文件；
4. **密钥不回显**：env 相关响应只含键名，`message` 与日志均不含明文值；
5. **官方命令优先**：先试 `hermes config set/unset`（`via:"cli"`），失败才回退 1–4（`via:"file"`）。

```bash
# 未带 confirm → 400 CONFIRM_REQUIRED
curl -s -X PATCH localhost:4319/api/agents/demo/config -H 'content-type: application/json' \
  -d '{"model":"deepseek/deepseek-flash"}'
# → {"error":"CONFIRM_REQUIRED","message":"配置写操作需要显式 confirm:true。"}

# 带 confirm → 200，且生成备份、保留 config.yaml 其它字段与注释
curl -s -X PATCH localhost:4319/api/agents/demo/config -H 'content-type: application/json' \
  -d '{"model":"deepseek/deepseek-flash","description":"我的 agent","tags":["review"],"confirm":true}'

# 设置密钥（响应不含明文；CLI 可用时 via:"cli"，不可用时回退 .env 为 via:"file"）
curl -s -X POST localhost:4319/api/agents/demo/env -H 'content-type: application/json' \
  -d '{"key":"OPENAI_API_KEY","value":"sk-***","confirm":true}'
# → {"ok":true,"action":"set-env","via":"cli",...,"message":"已通过 hermes CLI 设置环境变量 OPENAI_API_KEY（值已隐藏）。"}
```

环境变量：`OS_META_DIR`（工作台元数据根，默认 `~/.24os/agents`）、
`OS_CONFIG_BACKUP_DIR` / `OS_BACKUP_DIR`（配置备份根，默认 `~/.24os/backups`）、
`HERMES_HOME` / `OS_HERMES_HOME`（Hermes 主目录）、`OS_HERMES_CLI`（CLI 路径；
指向不存在的路径会强制 `via:"file"`，便于测试回退路径）。

## 市场（market）

`GET /api/market` 读取仓库内 `market/index.json`，返回 `MarketEntry[]`
（字段 `id/name/description/source/version/tags`），并**合并** `market/apps/*.app.yaml`
（AppManifest）元信息：`uiHost`、`hooks`、`appManifest:true`（同 id 覆盖 version/name；
仅存在于 apps 的 App 会追加为新条目）。清单文件缺失或损坏时仍会列出 AppManifest 条目，
不报错。可用 `OS_MARKET_FILE` / `OS_MARKET_APPS_DIR` 覆盖路径（测试用）。

前端「Agent 市场」Tab 列出条目，点「安装」即用其 `source` 打开安装对话框。

### AppManifest（M6 · `24os-appmanifest/1`）

以官方 profile distributions 为底座的 App 交付清单（profile 模板 + skills + mcp + model + env + UI + hooks + plugins + 签名），
编排 install / update / uninstall / rollback。规范详见 [`docs/APP_MANIFEST.md`](docs/APP_MANIFEST.md)。

| 端点 | 说明 |
| --- | --- |
| `GET /api/market` | 静态清单 + AppManifest 元信息合并 |
| `GET /api/market/apps/:id` | 解析后的 AppManifest（404 `APP_NOT_FOUND`） |
| `POST /api/market/:id/apply` | body `{ mode: install\|update\|uninstall\|rollback, confirm? }` → `applyAppManifest` |
| `POST /api/agents/install` | 兼容入口：`{ type:"market", id, mode?, confirm? }` 委托 apply；否则同原 `installAgent` |

安全门禁与写保证：`confirm:true`（缺 → 400 `CONFIRM_REQUIRED` 不碰磁盘）→ update/uninstall 先备份
`~/.24os/backups` → `~/.24os/apps/<id>.json` **最后一步**原子写且 env 值脱敏为 `"***"` →
`emitAppEvent("app.install|update|uninstall|rollback")`（M7 executor 订阅后执行 hooks 并广播）。签名校验失败 → 400 `SIGN_MISMATCH`。

```bash
# 冒烟（隔离 HERMES_HOME + 假 CLI）
curl -s localhost:4319/api/market | jq '.entries[].id'
curl -s localhost:4319/api/market/apps/ppt-maker | jq .id
curl -s -X POST localhost:4319/api/market/ppt-maker/apply \
  -H 'Content-Type: application/json' -d '{"mode":"install"}'          # → 400 CONFIRM_REQUIRED
curl -s -X POST localhost:4319/api/market/ppt-maker/apply \
  -H 'Content-Type: application/json' -d '{"mode":"install","confirm":true}'
```

## Hooks / Dashboard WS（M7）

规范详见 [`docs/APP_MANIFEST.md`](docs/APP_MANIFEST.md) §5–§9。

### Hooks 执行体

`server/hooks/executor.ts` 订阅 `app.*` 事件（或直调 `runHook`），执行：

| Hook | 语义 | 广播 |
| --- | --- | --- |
| `ui.open` | 前端据 `skillId` 打开 Skill UI | `hook.ui.open` |
| `config.apply` | configEdit 官方命令优先重放 model/mcp/env | `hook.config.apply`（`via`） |
| `notify` | `outbound.pushNotify` HMAC 签名推送 | `hook.notify` |

环形日志（最近 100）→ `GET /api/hooks/log`；异常 catch 记录不抛穿。

**outbound 签名**：`x-24os-timestamp` + `x-24os-signature: sha256=<HMAC(token, ts.body)>`；
无 endpoint / 明文 token → `skipped`（不报错、不回显 token）。

### Dashboard WS（`GET /api/ws`）

- 协议：服务端→客户端 `{type, at, payload?}`；客户端 `{type:"ping"}` → `{type:"pong"}`；连上先收 `hello`。
- 鉴权同安全基线：回环匿名；非回环必须 `?token=` 或 `x-24os-token` == `OS_TOKEN`，否则 401。
- 广播：app 生命周期 / hook 结果 / gateway 状态 / `chat.delta|done|error` 摘要（**仅 len，无正文**）/ `cron.changed`。
- 30s 心跳；前端 `StatusDrawer` 最近 50 条事件 + 指数退避重连。

## 定时任务（M8 · 官方 Hermes Cron 薄封装）

> 完整说明见 [`docs/CRON.md`](docs/CRON.md)。**自研 `bots.yaml` + 30s 调度器已删除**；
> 定时完全交由 Hermes 官方 cron，工作台只做 UI + 触发器。

- **触发**：让 `hermes serve` 带 `HERMES_DESKTOP=1`（`gateway.ts#resolveGatewayEnv`，默认开，
  `OS_CRON_TICKER=0` 关闭）→ 官方内置 ticker（60s）执行 jobs。
- **RPC**：`server/hermes/cron.ts` 封装 `cron.manage`（list/add/remove/pause/resume）+
  订阅 `cron.changed`（失效缓存 + Dashboard WS 广播）+ 写前备份 `~/.24os/backups/cron/`。
- **API**：`GET /api/cron/jobs`；`POST /api/cron/jobs`（新增，`confirm:true`）；
  `POST /api/cron/jobs/:name/pause|resume|remove|run`（均 `confirm:true`）。
- **前端**：`web/components/CronPanel.tsx`（列表 + 暂停/恢复/立即运行/删除 + 新增表单 + ticker 状态）。
- **迁移**：原 `bots.yaml` 条目 → `hermes cron create "<schedule>" "<prompt>" --name <id>`（见 docs/CRON.md §4）。

## 测试与验证

- `server/**/*.test.ts` 使用 [Vitest](https://vitest.dev/)（`vitest.config.ts` 独立配置，
  纯 Node 环境，`@shared` 别名与运行时一致）。
- 覆盖：
  1. `config.yaml` 解析——多 section `default`、嵌套 `model.default`、顶层 `mcp_servers`、
     tab / 4 空格缩进、`mcp_servers: {}`、带引号的 key；
  2. markdown 描述提取——跳过标题与空行，取第一段正文；
  3. live / mock 模式判定（`decideMode`）；
  4. **M4 Skill UI**——发现（含 ui/manifest.json 才纳入，忽略无 UI / 协议不匹配 / 损坏 JSON）；
     静态托管安全（`../` 穿越被拒、非白名单扩展名被拒）；broker 门禁（未声明 capability → 403、
     工作区越界 → 403、未声明权限 → 403、非白名单工具 → 400）；`ppt.export` 生成非空 pptx；
     `callModel` 经 `completePrompt`（注入 stub）并透传 prompt/profile。
  4b. **M4.1 声明式面板**——`validatePanel` 合法/非法（错误 protocol、未知 type、
     select 缺 options、action 缺 prompt / kind 非 prompt、key 重复、min>max）；
     `parsePanelYaml` 解析仓库 `examples/skills/outline`；`interpolatePrompt` 多字段 /
     缺失 empty|keep|error / 0|false|空串；`discover` 的 `uiHost` 判定（panel→declarative、
     manifest→iframe、两者→iframe）；静态托管放行 yaml/yml/md 且穿越仍被拒；
     `GET /api/skill-uis`、`GET /api/skill-uis/:id/panel`（PanelSpec / 404）、
     `GET /skill-ui/:id/panel.yaml` 路由行为。
  5. **M2-core 生命周期**——用**假 hermes CLI**（临时目录里的可执行脚本，把参数写入 `calls.log`，
     并模拟 `profile export -o` 落盘）注入测试：命令白名单拒绝非法子命令（`COMMAND_NOT_ALLOWED`）、
     `CONFIRM_REQUIRED` / `INVALID_SOURCE` / `INVALID_NAME` / `HERMES_CLI_UNAVAILABLE`；
     install/update/delete 传给 CLI 的子命令正确；delete 先 `export` 备份再 `delete` 并产生 `backupPath`；
      dryRun 不真正执行（假 CLI 零调用）；以及路由层 `fastify.inject` 对
     `/api/agents`、`/api/agents/:id/update`、`DELETE /api/agents/:id`、`/api/agents/:id/backup`、`/api/market` 的行为。
  6. **M3 配置编辑**——全部使用**临时 hermesHome / backupDir / metaDir**（绝不触碰真实 `~/.hermes`）：
     `updateAgentConfig` 写 model 后其它键与**注释保留**、`CONFIRM_REQUIRED`、非法 id；
     MCP 增/改/删与其它字段保留；`setEnvVar` / `removeEnvVar` 增/替换/删行且保留其它行、
     非法 key 拒绝、**返回值不含明文**；备份 `.bak` 生成且每文件超过 10 份时删最旧；
     路径穿越（id / 备份文件名）被拒；路由层 `PATCH /api/agents/:id/config` 未 confirm → 4xx。
  7. **M5 探测 / gateway / 降级链**——`detect` 用临时 home 断言 CLI 候选顺序与 `cliSource`、
   `hermesHomes` / `activeHome`；`parseBackendReadyLine` / `parseSessionToken`；
   `GatewayClient` 用**本地 mock WS 服务器**验证 id 关联、事件通知回调、RPC 错误与超时、
   会话方法参数、服务端请求 `onRequest`/`respond`；
   `completePrompt` 注入假 CLI 验证 gateway→oneshot→stub 三级降级与 `via`、`-p` profile 透传。
   8. **M5.2 会话 / 流式**——`chat.test.ts` 用本地 mock gateway 验证事件归一化序列（delta→done）、
    未知事件透出 `raw`、审批默认 deny / `OS_GATEWAY_AUTO_APPROVE=1` 回 `once`、
    abort 触发 `session.interrupt`；`hermes.test.ts` 用 `fastify.inject` 验证 SSE 事件流与错误帧；
    `discover.test.ts` 验证 M5.0b 的 `activeHome` 影响 skill 扫描目录。
   9. **M6 AppManifest**——`manifest.test.ts` 合法/非法（id 正则、version、unknown hook、
      bad ui.host、protocol 不匹配、source/env）→ `INVALID_MANIFEST`；内置 catalog 含
      `ppt-maker` / `outline-declarative`；`apply.test.ts` 用假 CLI + 临时目录验证
      install（config set 调用、`apps/<id>.json` env 脱敏 `***`、`emit app.install`、skills 复制）、
      缺 confirm → `CONFIRM_REQUIRED` 不落盘、uninstall 先 export 备份再删、
      update 备份 + history、rollback 恢复上一版快照、sign 篡改 → `SIGN_MISMATCH`；
      `marketApps.test.ts` 覆盖 `/api/market` 合并、`/api/market/apps/:id`、
      `/api/market/:id/apply` confirm 门禁、`/api/agents/install` 兼容委托。
   10. **M7 hooks / WS**——`outbound.test.ts` HMAC 可复算、无 endpoint/token → `skipped`、
       mock fetch 断言签名头；`executor.test.ts` app.install → ui.open/notify 广播 + 异常记入 log；
       `ws.test.ts` 真实 server 收 hello / broadcast / ping→pong、`checkWsAuth` 非回环 401；
       `m7Routes.test.ts` `GET /api/hooks/log`。
   10b. **M8 官方 Cron**——`cron.test.ts`（mock gateway）：`cron.manage` list/add/pause/resume/remove
       参数与结果映射、TTL 缓存 + `cron.changed` 失效/广播、备份保留 10 份、RPC/工具级错误映射
       （`CRON_RPC_ERROR`/`CRON_UNAVAILABLE`/`CRON_JOB_NOT_FOUND`）、非法 name 不触发 RPC、
       run 走注入 CLI；`routes/cron.test.ts` confirm 门禁（缺失 → 400 且不调用）、非法 name 400、
       GET 列表映射；`gateway.test.ts` `resolveGatewayEnv` 注入/关闭 `HERMES_DESKTOP`。
   11. **M2 外壳静态托管**——`staticWeb.test.ts`（11 例，临时 dist fixture）：`resolveWebDistRoot`
       候选顺序（`OS_WEB_DIST` / `dist/web` / `web/dist`）；`/` → index.html、`/assets/app.js` → 200、
       `/foo/bar` → SPA fallback 200、`/../secret` 及编码穿越 → 404 拒；缺失带扩展名资源不 fallback；
       非白名单扩展名拒；`/api`、`/skill-ui` 保留路径不进 fallback；无 dist 时行为不变（纯 API 404）；
       `shouldBypassWebToken` 仅回环 + 静态 + GET/HEAD 豁免。
   12. **web 前端测试（jsdom）**——`web/**/*.test.tsx` 与 `web/api.test.ts` 顶部用
       `/** @vitest-environment jsdom */` docblock 切到 jsdom，每个文件
       `import "@testing-library/jest-dom/vitest"` 且 `afterEach(cleanup)`；`server/**` 仍为
       node 环境（**单配置**，未用已废弃的 `environmentMatchGlobs`，也无需 `test.projects`）。
       网络与模型全部 mock（假 `fetch` / 假 `Response` / 假 `WebSocket`），**不触碰
       `~/.hermes`**。覆盖：`web/api.ts`（每个导出函数的 URL/方法/query/body 关键字段
       `confirm`/`chatId`/`force`、错误 `ApiRequestError` 形状、非 JSON 响应、网络异常、
       `fetchModelOptions` 指定/聚合/降级）、`shared/panel.ts` 插值边界、
       `DeclarativePanel`（text/textarea/select/slider/file 渲染、必填拦截、`{{key}}` 插值、
       SSE delta/error/done、审批·澄清卡片与 `chat/decide`、`options_from` 动态选项与模板回填）、
       `SkillHost`（iframe 挂载与 `host.init` 握手、`ui.ready` 重发、RPC 按 id 关联与
       `/api/skill-host/invoke`、未声明能力拒绝、`SKILL_DISABLED`、chatStream SSE 转发、
       空 prompt 拒绝、昂贵模型确认取消/force 重试）、`StatusDrawer`（假 WebSocket：连接状态、
       事件摘要、非法帧忽略、退避重连、50 条上限）、`CronPanel`（加载官方 jobs、暂停/恢复、
       显示已暂停切换、创建表单、错误展示）、以及 `App`/`AgentDetail`/`Modal`/
       `CommandResult`/`InstallAgentDialog`/`AgentConfigEditor` 的渲染与交互断言。
- **验证命令统一为 `npm run check`**（等价于 `npm run typecheck && npm test`）。
  当前共 **509** 个用例：**server 391**（node）+ **web 110**（jsdom）+ **shared 8**（插值边界）。

```bash
npm run check            # 全量：typecheck + server(node) + web(jsdom) + shared
npx vitest run web/      # 仅前端用例
npx vitest run web/api.test.ts   # 单个文件
```

### CI（`.github/workflows/ci.yml`）

- **`check`**：`push`(main) / `pull_request` / `workflow_dispatch` 触发，`ubuntu-latest` ×
  node `[20, 22]`，`npm ci` → `npm run check` → `npm run build`，上传 `dist/web`、`dist/server.cjs`
  为 artifact；job 级 `ELECTRON_SKIP_BINARY_DOWNLOAD=1` 跳过 electron 二进制下载加速。
- **`dist`**：仅 `workflow_dispatch` 或 `refs/tags/v*`（push tag）触发，`npm ci`（**不**跳过
  electron 下载）→ `npm run dist`，上传 `release/*.AppImage`、`*.deb` 为 artifact。
- `concurrency` 取消同分支旧运行，`permissions: contents: read` 最小权限。

## 路线图（TODO）

- ~~**M4**：功能性 Skill UI 宿主协议（iframe + postMessage RPC 桥）~~ ✅ 已完成。
- ~~**M4.1**：声明式 Skill UI（`ui/panel.yaml`，零代码 `form`，与命令式并存；`uiHost` 判定 + `GET /api/skill-uis/:id/panel` + DeclarativePanel）~~ ✅ 已完成。
- ~~**M2-core**：`hermes profile install / update / delete / export` 对接 + 小市场 + 两段式 dryRun 确认~~ ✅ 已完成。
- ~~**M3**：Agent 配置编辑落盘（模型 / 描述 / MCP / 环境变量，含 confirm / 备份 / 原子写 / 回滚）~~ ✅ 已完成。
- ~~**M5.0**：`detect.ts` 增强——非 PATH CLI 探测、`OS_HERMES_HOME`/多 home、状态暴露探测结果~~ ✅ 已完成。
- ~~**M5.0b**：skillui 发现统一到 `detect` 解析的 `activeHome`~~ ✅ 已完成。
- ~~**M5.1**：TUI gateway（`hermes serve` JSON-RPC/WS）+ `callModel` 三级降级链（gateway → `hermes -z` → stub）~~ ✅ 已完成（`llm.oneshot` 通道）。
- ~~**M5.2**：会话（`session.create`/`prompt.submit`/`interrupt`/`close`）+ 流式事件 + SSE 路由 + 审批安全默认 + Skill UI `chatStream`~~ ✅ 已完成。
- ~~**M5.3**：交互式审批/clarify 授权（`chatId`/`decideApproval`/`chat/decide` + 前端决策卡片 + 安全兜底）、模型热切换（`session.create.model` + `config.set model` + SSE `model?` + 前端下拉 + `hermes -z -m`）、subagent 观测/控制与事件透出（见 M10）~~ ✅ 已完成。
- ~~**M6**：AppManifest（`24os-appmanifest/1`）安装/更新/卸载/回滚编排 + market 增强 + 签名 + 事件总线~~ ✅ 已完成。
- ~~**M7**：hooks 执行体（`ui.open`/`config.apply`/`notify`）+ Dashboard WS `/api/ws` + 前端状态抽屉~~ ✅ 已完成。
- ~~**M8**：定时任务改用**官方 Hermes Cron**（`cron.manage` 薄封装 + `cron.changed` 事件 + `HERMES_DESKTOP=1` 触发官方 ticker + `/api/cron/jobs` + CronPanel）；自研 `bots.yaml`/30s 调度器已删除~~ ✅ 已完成。
- ~~**M9**：**Bot=Profile 对齐官方**（`profiles.list/describe/configure/create/set_asset/get_asset` 薄封装；描述/persona 读写对齐 `SOUL.md`；skill 启停对齐 `disabled_skills`；头像 `GET/POST /api/agents/:id/avatar`；`meta.json` 降级为专有备注）~~ ✅ 已完成。
- ~~**M2 外壳**：Electron 壳（`electron/main.cjs` + `preload.cjs`，复用/拉起 server + 生产静态托管 + headless 退出 0）~~ ✅ 已完成。
- ~~**M2 杂项**：Skill 启停落盘（`POST /api/agents/:id/skills` + `skill-uis.disabled`）；CLI 变更后实时刷新（`invalidateAgentsCache`）；`GET /api/agents` 列表合并 meta description/tags；`OS_HERMES_CLI` 显式无效不回退~~ ✅ 已完成。
- ~~**M2 打包**：electron-builder（`package.json#build` + `scripts/build-server.mjs` + `npm run dist`，产出 AppImage/deb + asar）~~ ✅ 已完成。
- ~~**M2 打包修复**：`asarUnpack` 解包 `dist/server.cjs` / `dist/web/**` + `electron/main.cjs` 打包态路径映射（`app.asar` → `app.asar.unpacked`），修掉系统 node 无法读取 asar 的首启缺陷~~ ✅ 已完成。
- ~~**M10**：**subagent 观测/控制 + 事件透出**（`server/hermes/subagent.ts` 薄封装
  `subagent.list/tail/interrupt/steer`、`delegation.pause`；`GET /api/hermes/subagents` +
  `/api/hermes/subagents/:id/{tail,interrupt,steer}` + `/pause`；`chat.ts` 把 `subagent.*`
  归一化为 `type:"subagent"` 并 SSE 透出；`getSubagentSupport()` 语义为「无 spawn API，经会话内
  `delegate_task`」）；**通道对齐**（`docs/CHANNELS.md`：实测 `hermes gateway run` 无 token 退化
  为 "No messaging platforms enabled" 且保持运行、`hermes serve` 不启动平台适配器；推荐投递走官方
  `cron --deliver`）；**Group Chat 决策：不做**（属官方 Desktop 主战场）~~ ✅ 已完成。
- **M10+ 候选**：`session.resume`/`session.list` 等会话浏览；subagent **spawn**（官方契约待暴露，
  当前仅观测/控制面 + 事件透出）；昂贵模型 `confirm_expensive_model` 交互确认。
  ~~审批交互式授权、模型热切换~~ ✅ 已完成（M5.3）。
- **M11+（可选）**：Group Chat（官方 `groups.*` RPC + `hosted_room_*`；见 `docs/CHANNELS.md`，
  24H-OS 暂不实现 UI）。
- **M2+**：MCP 网关（连接/调试 MCP server）；模型切换。
- 代码内以 `TODO(M2+)` / `TODO(M5)` 注释标出了各扩展点。

## 已知偏差

- `index.html` 放在 `web/` 下（因为 Vite `root` 指向 `web/`），而非项目根目录。
- `build` = `vite build`（dist/web）+ `scripts/build-server.mjs`（dist/server.cjs，单文件 CJS）
  + `tsc --noEmit`。dev 仍由 `tsx` 直接执行 TS；打包/`node dist/server.cjs` 走 esbuild 产物。
- **打包后 server 由“系统 node”启动**（沿用现有 node 探测）：已用 `asarUnpack` 把
  `dist/server.cjs` / `dist/web/**` / `market/**` / `examples/skills/**` 解包到
  `resources/app.asar.unpacked/`，`electron/main.cjs` 经 `app.getAppPath()` 映射路径后 spawn；
  NAS 无显示器已实测**打包态 headless 首启**（起 server → `/api/health` 200 →
  `/api/market` 5 条含 `ppt-maker` → `/api/skill-uis` 含 `ppt`+`outline` → 退出 0，无残留）。
  未验证的是有显示器时的**开窗**路径（无 GUI 环境）。
- M5.1 的 `callModel` 已接入真实 Hermes：默认走 gateway 的 `llm.oneshot`；gateway 不可用时
  降级为 `hermes -z`，再不可用才回退 `[stub]`。`llm.oneshot` 是**无状态**补全（无会话上下文，
  契约无 model 字段；model 覆盖仅作用于 `hermes -z` 通道）。
  会话/流式/交互式审批/模型热切已完成（M5.2/M5.3）；subagent 无 spawn RPC（M10：能力经会话内
  `delegate_task` 工具，工作台提供观测/控制 + 事件透出）。
- 通道（channels）：工作台**不实现平台适配器**，只对齐官方。平台适配器由独立的
  `hermes gateway` 进程持有；`hermes serve`（工作台的 gateway）不启用平台。因此 Bot 输出投递
  **推荐官方 `cron --deliver <platform:chat_id|bot-chat[:profile]>`**（已集成 `cron.manage`），
  自研 `hooks.outbound`（HMAC webhook）仅作第三方 HTTP 回调扩展。详见 `docs/CHANNELS.md`。
- M5.0 的 `detect.ts` 会探测 `~/.local/bin/hermes` 等非 PATH 位置；`resolveHermesCli` 与
  `resolveCliPathSync` 在 `OS_HERMES_CLI` 已设置但路径不存在时都返回“不可用”
  （`cliSource:"env"` / `cliPath:null`），**不再回退到自动探测**（与 `cli.ts` 对齐，便于测试隔离）。
- M4.1 的 `panel.yaml` 校验为**手写**（未引入 zod），与既有 `parseManifest` 风格一致、依赖最小；
  非法 panel 视为“无声明式 UI”，`GET .../panel` 返回 404。
- 声明式面板**不支持任意 JS**，因此 `ui/panel.yaml` 形态不会被 broker 的 capability/permission
  授权（broker 只服务 iframe 形态的 manifest）；`wizard` 视图目前按 `form` 渲染。
- `runTool` 目前仅白名单中的 `ppt.export`；`emitEvent` / `resize` 为 no-op（返回 ok）。
- 权限提示在 prototype 中**自动放行**并记录日志，尚未接入交互式授权。
- M2-core 生命周期依赖真实 `hermes` CLI；本机未安装 CLI 时，除 `dryRun` 预览外均返回
  `HERMES_CLI_UNAVAILABLE`（这是有意的优雅降级）。`OS_HERMES_CLI` 可指向自定义 CLI 便于本地验证。
- 生命周期操作直接改变 `~/.hermes`（安装/更新/删除）；删除默认先备份到 `~/.24os/backups/`，
  备份失败会中止删除。前端对破坏性操作强制两段式（dryRun 预览 + 确认弹窗）。
- M9 起**一个 Hermes profile = 一个 Bot**：人设（persona）对齐官方 `SOUL.md`
  （`profiles.configure {soul}` 优先、`via:"rpc"`；RPC 不可用回退文件写），短描述对齐官方
  `profile.yaml`，skill 启停对齐官方 `config.yaml skills.disabled`，头像对齐官方
  `assets/avatar.*`（`GET/POST /api/agents/:id/avatar`，PNG/JPEG ≤256KB）。
  `~/.24os/agents/<id>/meta.json` **降级为「24H-OS 专有备注」**（`tags` + 官方不可用时的回退副本）；
  列表/详情读取优先级：官方 `description` → 官方 `SOUL.md` 摘要 → meta → config 派生。
  详见 [`docs/PROFILE_ALIGN.md`](docs/PROFILE_ALIGN.md)。
- 官方 Profile RPC（`profiles.configure`）的写路径**复用已连接的共享 gateway**，不为一次配置
  保存额外 `spawn hermes serve`；未运行时直接走文件回退（写的是官方同款 artifact）。`via`
  区分 `"rpc"` / `"cli"` / `"file"`。
- `setEnvVar` 在检测到 `hermes` CLI 时优先执行 `hermes config set <KEY> <VALUE>`（值作为单个
  参数、无 shell）；CLI 不可用或失败时回退为直接编辑 `.env`。为保证密钥不外泄，无论走哪条
  路径，响应都不回显命令与明文值。当前环境下默认无 CLI，实际走 `.env` 直写路径。
- `restoreBackup` 通过备份文件名（`<file>.<ISO 时间戳>.bak`）推断原始文件名并限定在白名单内
  （含 `SOUL.md`），还原前会对当前文件再备份一次；仅作为可选回滚能力，前端暂未提供入口。
- M2-core 的 `deleteAgent` 曾存在「返回的 `backupPath` 与 `backupAgent` 实际写入路径因跨毫秒
  生成而不一致」的缺陷，已在 M3 一并修复（改为复用实际备份路径）。
