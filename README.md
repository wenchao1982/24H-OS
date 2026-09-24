# 24H-OS（M2-core 原型）

> 以 **Hermes** 为核心的多 agent 桌面工作台。
> M1 落地只读内核桥接层；M4 落地 **功能性 Skill 的 UI 宿主协议**（沙箱 iframe + postMessage RPC）
> 与一个可用的 **PPT demo skill**；**M2-core** 新增 **Agent 生命周期**（安装 / 更新 / 卸载 / 备份）
> 与一个静态 **小市场**。仍为 web-first：浏览器里即可开发调试，Electron 仅作为后续外壳。

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
│     routes/hermes.ts   GET /api/hermes/status · GET /api/health                       │
│     hermes/detect.ts   探测 which hermes / hermes --version / ~/.hermes               │
│     hermes/profiles.ts 读取 ~/.hermes/profiles/* 与 ~/.hermes 本身 → Agent 列表        │
│     hermes/mock.ts     无 Hermes 时返回示例 agent                                      │
│     hermes/index.ts    聚合快照 { agents, status }（带缓存）                           │
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
├─ vitest.config.ts       # vitest（Node 环境，@shared 别名，测试发现）
├─ .gitignore
├─ README.md
├─ docs/
│  └─ SKILL_UI_PROTOCOL.md # M4 Skill UI 宿主协议（24os-skill-ui/1）
├─ market/
│  └─ index.json          # M2-core 小市场静态清单（可安装 distribution）
├─ shared/types.ts        # Agent / Skill / McpServer / HermesStatus / SkillUi* / Lifecycle* / Market* 等共享类型
├─ examples/
│  └─ skills/ppt/         # M4 功能性 Skill demo（PPT 工作台）
│     ├─ SKILL.md
│     └─ ui/{manifest.json,index.html,main.js,styles.css}
├─ server/
│  ├─ index.ts            # Fastify 启动，注册路由，端口 4319
│  ├─ market.ts           # 读取 market/index.json → MarketResponse（缺失/损坏降级为空）
│  ├─ hermes/
│  │  ├─ profiles.ts      # 用 yaml 库解析 config.yaml 产出结构化 Agent 列表
│  │  ├─ profiles.test.ts # YAML 解析 / 描述提取 单测
│  │  ├─ detect.ts        # 探测 hermes 是否可用
│  │  ├─ detect.test.ts   # live / mock 模式判定 单测
│  │  ├─ cli.ts           # M2-core 安全执行层：spawn（不 shell）+ 子命令白名单 + dryRun
│  │  ├─ cli.test.ts      # 白名单 / dryRun / 结构化结果 单测（假 CLI）
│  │  ├─ lifecycle.ts     # M2-core install/update/delete/backup（含删除前备份）
│  │  ├─ lifecycle.test.ts# 生命周期校验 / 备份 / CONFIRM_REQUIRED 单测
│  │  ├─ errors.ts        # LifecycleError + 错误码 → HTTP 状态映射
│  │  ├─ mock.ts          # 降级示例数据
│  │  └─ index.ts         # 快照聚合 + 缓存（变更后可 refreshSnapshot）
│  ├─ testUtils/
│  │  └─ fakeHermesCli.ts # 测试用假 hermes CLI（记录参数 + 模拟 export）
│  ├─ skillui/
│  │  ├─ discover.ts      # 扫描 skills 根，发现含 ui/manifest.json 的 skill
│  │  ├─ static.ts        # UI 静态托管路径安全 + CSP/MIME
│  │  ├─ broker.ts        # 能力 broker：capability/permission 门禁 + 工作区沙箱
│  │  ├─ tools.ts         # runTool 白名单实现（ppt.export → pptxgenjs）
│  │  └─ *.test.ts        # 发现 / 静态安全 / broker 门禁 / pptx 生成 单测
│  └─ routes/
│     ├─ agents.ts        # GET /api/agents, GET /api/agents/:id, M2-core 生命周期 + /api/market
│     ├─ agents.test.ts   # 路由层 fastify.inject 测试
│     ├─ hermes.ts        # GET /api/hermes/status
│     └─ skillUi.ts       # /api/skill-uis, /skill-ui/:id/*, /api/skill-host/invoke
└─ web/
   ├─ index.html          # Vite 入口（root = web/）
   ├─ main.tsx            # React 挂载
   ├─ App.tsx             # 整体布局（Agents / Skill 市场 / Agent 市场 Tab + 安装入口）
   ├─ pages/AgentDetail.tsx
   ├─ components/SkillHost.tsx      # M4 Skill UI 宿主 + RPC broker + 调试面板
   ├─ components/Modal.tsx          # M2-core 通用确认弹窗
   ├─ components/CommandResult.tsx  # 命令 / exit / stdout / stderr 展示
   ├─ components/InstallAgentDialog.tsx # 安装表单 → dryRun 预览 → 确认执行
   ├─ api.ts              # fetch 封装 → http://localhost:4319
   └─ styles.css          # 暗色主题（手写 CSS）
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
npm test             # vitest 单元测试（解析 / 描述提取 / 模式判定）
npm run check        # typecheck + test（推荐的验证命令）
npm run build        # vite build（产物 dist/web/）+ typecheck
npm run start        # 用 tsx 直接跑 server（生产原型模式）
```

## Hermes 依赖说明

- 后端启动时会 `detect.ts`：`which hermes` / `hermes --version`，并检查 `~/.hermes`。
- **live 模式**：检测到 `hermes` CLI，或存在可解析的 `~/.hermes` 配置 →
  读取 `~/.hermes/profiles/<name>/`（每个目录一个 agent）；若没有命名 profile，
  则把 `~/.hermes` 本身当作名为 `default` 的默认 profile。
- **mock 模式**：既无 CLI 又无 `~/.hermes` → 返回 `server/hermes/mock.ts` 里的示例 agent，
  并在 `/api/hermes/status` 标记 `available:false, mode:"mock"` 与中文说明。
- 前端顶部状态条会显示 **LIVE / MOCK** 徽标与说明字符串。
- 本服务对 Hermes **只读**，不会修改 `~/.hermes` 下任何文件。

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

`server/hermes/profiles.ts` 从 `config.yaml` / `agent.json` 解析出上述结构，
`mock.ts` 提供同构示例数据，`web/pages/AgentDetail.tsx` 直接渲染 skill 描述、
MCP command/args 与启用状态；`GET /api/agents/:id` 返回结构化详情。

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
- 方法：`callModel`（M4 桩，`TODO(M5)` 接 Hermes TUI gateway）、`readFile`、`writeFile`、`runTool`、`emitEvent`、`resize`。

**安全边界**：

- 宿主校验 `event.source === iframe.contentWindow`、`__24os === true`，且 `method ∈ capabilities`；
- 静态托管防目录穿越，仅服务白名单扩展名（html/js/css/json/png/svg/woff2）；
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

### /api 新增端点

| 端点 | 说明 |
| --- | --- |
| `GET /api/skill-uis` | 列出所有自带 UI 的 skill（`SkillUiInfo[]`）。 |
| `GET /api/skill-uis/:id` | 单个 UI 信息，未找到 404。 |
| `GET /skill-ui/:id/*` | 静态托管该 skill 的 `ui/` 文件（防穿越 + 严格 CSP）。 |
| `POST /api/skill-host/invoke` | 能力 broker：`{ skillId, method, params }` → `{ ok, result?, error? }`（未声明 capability/permission → 403）。 |

skills 根发现顺序：`OS_SKILL_ROOTS` → 仓库 `examples/skills` → `~/.hermes/skills` → `~/.hermes/profiles/*/skills`。
`GET /api/agents` 的 `Skill` 新增 `hasUi` / `uiId` 字段。

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

## 市场（market）

`GET /api/market` 读取仓库内 `market/index.json`，返回静态的 `MarketEntry[]`
（字段 `id/name/description/source/version/tags`）。文件缺失或损坏时降级为 `{ entries: [], message }`，不报错。
前端「Agent 市场」Tab 列出条目，点「安装」即用其 `source` 打开安装对话框（同一 dryRun → 确认流程）。
可用 `OS_MARKET_FILE` 覆盖清单路径（测试用）。

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
     `callModel` 桩。
  5. **M2-core 生命周期**——用**假 hermes CLI**（临时目录里的可执行脚本，把参数写入 `calls.log`，
     并模拟 `profile export -o` 落盘）注入测试：命令白名单拒绝非法子命令（`COMMAND_NOT_ALLOWED`）、
     `CONFIRM_REQUIRED` / `INVALID_SOURCE` / `INVALID_NAME` / `HERMES_CLI_UNAVAILABLE`；
     install/update/delete 传给 CLI 的子命令正确；delete 先 `export` 备份再 `delete` 并产生 `backupPath`；
     dryRun 不真正执行（假 CLI 零调用）；以及路由层 `fastify.inject` 对
     `/api/agents`、`/api/agents/:id/update`、`DELETE /api/agents/:id`、`/api/agents/:id/backup`、`/api/market` 的行为。
- **验证命令统一为 `npm run check`**（等价于 `npm run typecheck && npm test`）。

```bash
npm run check
```

## 路线图（TODO）

- ~~**M4**：功能性 Skill UI 宿主协议（iframe + postMessage RPC 桥）~~ ✅ 已完成。
- ~~**M2-core**：`hermes profile install / update / delete / export` 对接 + 小市场 + 两段式 dryRun 确认~~ ✅ 已完成。
- **M2（剩余）**：Electron 外壳；Agent 编辑（模型 / skills / MCP）真正落盘；CLI 变更后的实时刷新优化。
- **M5**：通信层升级——对接 `hermes serve`（TUI gateway JSON-RPC）替换 `callModel` 桩，获得
  session 管理、流式事件、审批/clarify、subagent、模型热切换。
- **M2+**：Skill 安装/启停；MCP 网关（连接/调试 MCP server）；模型切换。
- 代码内以 `TODO(M2+)` / `TODO(M5)` 注释标出了各扩展点。

## 已知偏差

- `index.html` 放在 `web/` 下（因为 Vite `root` 指向 `web/`），而非项目根目录。
- `build` 采用 `vite build` + `tsc --noEmit`；server 不产出编译产物，运行时由 `tsx` 直接执行 TS。
- M4 的 `callModel` 为**桩实现**（返回 `[stub]` 文本），真实模型接入留待 M5（`TODO(M5)`）。
- `runTool` 目前仅白名单中的 `ppt.export`；`emitEvent` / `resize` 为 no-op（返回 ok）。
- 权限提示在 prototype 中**自动放行**并记录日志，尚未接入交互式授权。
- M2-core 生命周期依赖真实 `hermes` CLI；本机未安装 CLI 时，除 `dryRun` 预览外均返回
  `HERMES_CLI_UNAVAILABLE`（这是有意的优雅降级）。`OS_HERMES_CLI` 可指向自定义 CLI 便于本地验证。
- 生命周期操作直接改变 `~/.hermes`（安装/更新/删除）；删除默认先备份到 `~/.24os/backups/`，
  备份失败会中止删除。前端对破坏性操作强制两段式（dryRun 预览 + 确认弹窗）。
