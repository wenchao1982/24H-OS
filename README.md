# 24H-OS（M3 原型）

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
│     routes/hermes.ts   GET /api/hermes/status · /api/hermes/gateway[/start|/stop]     │
│     hermes/detect.ts   探测 CLI（env/PATH/~/.local/bin/~/.hermes/bin）+ 多 home      │
│     hermes/profiles.ts 读取 ~/.hermes/profiles/* 与 ~/.hermes 本身 → Agent 列表        │
│     hermes/gateway.ts  hermes serve 子进程 + WS JSON-RPC 客户端（M5.1）               │
│     hermes/complete.ts 模型补全降级链 gateway → `hermes -z` → stub（M5.1）            │
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
│  └─ skills/
│     ├─ ppt/             # M4 命令式 Skill demo（自带 HTML/JS，沙箱 iframe）
│     │  ├─ SKILL.md
│     │  └─ ui/{manifest.json,index.html,main.js,styles.css}
│     └─ outline/         # M4.1 声明式 Skill demo（零代码，只有 panel.yaml）
│        ├─ SKILL.md
│        └─ ui/{panel.yaml,templates/index.json}
├─ server/
│  ├─ index.ts            # Fastify 启动，注册路由，端口 4319
│  ├─ market.ts           # 读取 market/index.json → MarketResponse（缺失/损坏降级为空）
│  ├─ hermes/
│  │  ├─ profiles.ts      # 用 yaml 库解析 config.yaml 产出结构化 Agent 列表
│  │  ├─ profiles.test.ts # YAML 解析 / 描述提取 单测
│  │  ├─ detect.ts        # 探测 hermes CLI 位置与多 home（M5.0）
│  │  ├─ detect.test.ts   # CLI 候选顺序 / home 探测 / live-mock 判定 单测
│  │  ├─ gateway.ts       # M5.1 hermes serve 子进程 + WS JSON-RPC（ping/capabilities/llm.oneshot）
│  │  ├─ gateway.test.ts  # 本地 mock WS 服务器：id 关联 / 事件 / 超时 单测
│  │  ├─ complete.ts      # M5.1 三级降级链 completePrompt（gateway→oneshot→stub）
│  │  ├─ complete.test.ts # 降级链 / profile 透传 / spawn 假 CLI 单测
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
│  │  ├─ discover.ts      # 扫描 skills 根，发现 ui/manifest.json(iframe) 或 ui/panel.yaml(声明式)
│  │  ├─ panel.ts         # M4.1 解析/校验 ui/panel.yaml（24os-skill-panel/1）
│  │  ├─ static.ts        # UI 静态托管路径安全 + CSP/MIME（含 yaml/yml/md）
│  │  ├─ broker.ts        # 能力 broker：capability/permission 门禁 + 工作区沙箱
│  │  ├─ tools.ts         # runTool 白名单实现（ppt.export → pptxgenjs）
│  │  └─ *.test.ts        # 发现 / panel 校验 / 静态安全 / broker / pptx 单测
│  └─ routes/
│     ├─ agents.ts        # GET /api/agents, GET /api/agents/:id, M2-core 生命周期 + /api/market
│     ├─ agents.test.ts   # 路由层 fastify.inject 测试
│     ├─ hermes.ts        # GET /api/hermes/status · /api/hermes/gateway[/start|/stop]
│     ├─ hermes.test.ts   # 状态 / gateway 路由（隔离真实 home）测试
│     └─ skillUi.ts       # /api/skill-uis, /skill-ui/:id/*, /api/skill-host/invoke
└─ web/
   ├─ index.html          # Vite 入口（root = web/）
   ├─ main.tsx            # React 挂载
   ├─ App.tsx             # 整体布局（Agents / Skill 市场 / Agent 市场 Tab + 安装入口）
   ├─ pages/AgentDetail.tsx
   ├─ components/SkillHost.tsx      # M4 命令式 Skill UI 宿主 + RPC broker + 调试面板
   ├─ components/DeclarativePanel.tsx # M4.1 声明式面板渲染（表单/模板/预览/SSE）
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

`server/hermes/detect.ts` 启动时与每次快照刷新时探测（只读，不修改任何用户文件）：

- **CLI 候选顺序**：`OS_HERMES_CLI`（显式路径）→ `PATH` 里的 `hermes`（`which`）→
  `~/.local/bin/hermes` → `<home>/bin/hermes`。返回 `cliPath` 与 `cliSource`
  （`env` / `path` / `local-bin` / `hermes-bin`），因此**不在 PATH 上的安装也能被发现**。
- **HERMES_HOME 解析顺序**：`OS_HERMES_HOME` → `HERMES_HOME`（env）→ `~/.hermes`；
  另探测候选 home：`~/.hermes`、`~/hermes-desktop/home`（含 `config.yaml`/`profiles` 才算有效），
  状态里暴露 `activeHome` 与 `hermesHomes[]`。
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
`AddMcpServerRequest`、`SetEnvRequest`、`ConfigEditResult`（见 `shared/types.ts`）。
`McpServer` 增加 `url` / `headers` / `transport`，以支持 http 型 MCP server。

`server/hermes/profiles.ts` 从 `config.yaml` / `agent.json` 解析出上述结构，
`mock.ts` 提供同构示例数据，`web/pages/AgentDetail.tsx` 直接渲染 skill 描述、
MCP command/args 与启用状态；`GET /api/agents/:id` 返回结构化详情。
`server/hermes/configEdit.ts` 负责配置的读写与安全落盘，前端由
`web/components/AgentConfigEditor.tsx` 承载编辑界面。

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
| `GET /api/skill-uis` | 列出所有自带 UI 的 skill（`SkillUiInfo[]`，含 `uiHost`）。 |
| `GET /api/skill-uis/:id` | 单个 UI 信息，未找到 404。 |
| `GET /api/skill-uis/:id/panel` | 声明式面板规范 `PanelSpec`；非声明式 / 未找到 → 404 `PANEL_NOT_FOUND`。 |
| `GET /skill-ui/:id/*` | 静态托管该 skill 的 `ui/` 文件（防穿越 + 严格 CSP）。 |
| `POST /api/skill-host/invoke` | 能力 broker：`{ skillId, method, params }` → `{ ok, result?, error? }`（未声明 capability/permission → 403）。 |

skills 根发现顺序：`OS_SKILL_ROOTS` → 仓库 `examples/skills` → `<activeHome>/skills` → `<activeHome>/profiles/*/skills`。
`<activeHome>` 由 `detect.ts` 解析（M5.0b 起与 agent 来源一致，不再硬编码 `~/.hermes`）。
`GET /api/agents` 的 `Skill` 新增 `hasUi` / `uiId` 字段。

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
  `approval` | `clarify` | `done` | `error` | `raw`（未知类型原样透出）。
  映射依据 `tui_gateway/contracts/events.py` 与 `contracts/server_requests.py`。
- **审批策略（安全默认）**：`approval` 回 `deny`、`clarify` 回空答案（跳过）；
  仅 `OS_GATEWAY_AUTO_APPROVE=1` 时 `approval` 回 `once`、`clarify` 回第一个选项。
  无论决策如何事件都先透出。依据 `ApprovalChoice`（`once/session/always/deny`）。

| 端点 | 说明 |
| --- | --- |
| `POST /api/hermes/chat/stream` | SSE：body `{ profile?, prompt }`，逐条 `data: <ChatStreamEvent>`，`done`/`error` 后结束；客户端断开时 `interrupt` 并清理。 |

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `OS_GATEWAY_AUTO_APPROVE` | 设为 `1` 时自动放行审批（`approval→once`、`clarify→第一个选项`） | 关（deny） |

Skill UI 侧新增 `chatStream` capability（权限 `model:chat`）：`SkillHost.tsx` 读取该 SSE 并把事件以
`{ __24os:true, type:"event", event:"chat.delta"|"chat.done"|"chat.error"|…, payload }` 转发给 iframe；
broker 的 REST 路径则把流收集为 `{ text, status, events }`。

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

## Agent 配置编辑 API（M3）

让工作台把用户在 UI 里的修改**安全地落盘**到 agent：
模型（`config.yaml` 顶层 `model`）、功能描述 / 标签（工作台自有元数据
`~/.24os/agents/<id>/meta.json`）、MCP servers（`config.yaml` 顶层 `mcp_servers`）、
环境变量 / 密钥（`.env`）。完整设计见 [`docs/CONFIG_EDITING.md`](docs/CONFIG_EDITING.md)。

### 写入策略：官方命令优先（M5.x）

为避免与运行中的 Hermes 进程**并发写 config.yaml**，每个写操作**先尝试官方命令**，成功即
返回 `via:"cli"`；CLI 不可用或命令失败才回退工作台文件写（`via:"file"`，保留备份 / 原子写）：

| 配置 | 官方命令 |
| --- | --- |
| 模型 | `hermes [-p <id>] config set model <value>` |
| MCP 增 / 改 | `hermes [-p <id>] config set mcp_servers.<name> <JSON spec>` |
| MCP 删 | `hermes [-p <id>] config unset mcp_servers.<name>` |
| env 设 / 删 | `hermes [-p <id>] config set|unset <KEY> [<value>]` |
| 描述 / 标签 | ——（非 Hermes 字段，恒写 `meta.json`） |

`-p` 规则：`default`（或目录 == activeHome）不加，否则 `-p <id>`；参数一律走 `spawn(shell:false)`。
MCP 未用交互式 `mcp add`（discovery-first + 无 `mcp update`），详见 `docs/CONFIG_EDITING.md` §0.2。

| 端点 | 说明 |
| --- | --- |
| `GET /api/agents/:id/config` | 读取 `AgentConfig`（`envKeys` 只含键名，绝不返回值）。 |
| `PATCH /api/agents/:id/config` | body `{ model?, description?, tags?, confirm? }`。 |
| `POST /api/agents/:id/mcp` | body `{ name, spec, confirm? }`，新增 MCP server。 |
| `PATCH /api/agents/:id/mcp/:name` | body `{ spec, confirm? }`，更新 MCP server。 |
| `DELETE /api/agents/:id/mcp/:name` | body `{ confirm? }`，删除 MCP server。 |
| `POST /api/agents/:id/env` | body `{ key, value, confirm? }`，设置环境变量。 |
| `DELETE /api/agents/:id/env/:key` | body `{ confirm? }`，删除环境变量。 |
| `POST /api/agents/:id/config/restore` | body `{ backupFileName, confirm? }`，从备份还原（可选）。 |

统一返回 `ConfigEditResult { ok, action, via, files, backups, message }`，其中 `via`
标示本次落盘通道（`"cli"` = 官方命令，`"file"` = 工作台文件写；`"cli"` 时 `files`/`backups` 通常为空）。
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
- **验证命令统一为 `npm run check`**（等价于 `npm run typecheck && npm test`）。
  当前共 **200** 个用例。

```bash
npm run check
```

## 路线图（TODO）

- ~~**M4**：功能性 Skill UI 宿主协议（iframe + postMessage RPC 桥）~~ ✅ 已完成。
- ~~**M4.1**：声明式 Skill UI（`ui/panel.yaml`，零代码 `form`，与命令式并存；`uiHost` 判定 + `GET /api/skill-uis/:id/panel` + DeclarativePanel）~~ ✅ 已完成。
- ~~**M2-core**：`hermes profile install / update / delete / export` 对接 + 小市场 + 两段式 dryRun 确认~~ ✅ 已完成。
- ~~**M3**：Agent 配置编辑落盘（模型 / 描述 / MCP / 环境变量，含 confirm / 备份 / 原子写 / 回滚）~~ ✅ 已完成。
- ~~**M5.0**：`detect.ts` 增强——非 PATH CLI 探测、`OS_HERMES_HOME`/多 home、状态暴露探测结果~~ ✅ 已完成。
- ~~**M5.0b**：skillui 发现统一到 `detect` 解析的 `activeHome`~~ ✅ 已完成。
- ~~**M5.1**：TUI gateway（`hermes serve` JSON-RPC/WS）+ `callModel` 三级降级链（gateway → `hermes -z` → stub）~~ ✅ 已完成（`llm.oneshot` 通道）。
- ~~**M5.2**：会话（`session.create`/`prompt.submit`/`interrupt`/`close`）+ 流式事件 + SSE 路由 + 审批安全默认 + Skill UI `chatStream`~~ ✅ 已完成。
- **M2（剩余）**：Electron 外壳；Skill 的安装/启停落盘；CLI 变更后的实时刷新优化。
- **M5（剩余）**：`session.resume`/`session.list` 等会话浏览、subagent、模型热切换；审批的交互式授权（当前自动 deny / `OS_GATEWAY_AUTO_APPROVE=1` 放行）。
- **M2+**：Skill 安装/启停；MCP 网关（连接/调试 MCP server）；模型切换。
- 代码内以 `TODO(M2+)` / `TODO(M5)` 注释标出了各扩展点。

## 已知偏差

- `index.html` 放在 `web/` 下（因为 Vite `root` 指向 `web/`），而非项目根目录。
- `build` 采用 `vite build` + `tsc --noEmit`；server 不产出编译产物，运行时由 `tsx` 直接执行 TS。
- M5.1 的 `callModel` 已接入真实 Hermes：默认走 gateway 的 `llm.oneshot`；gateway 不可用时
  降级为 `hermes -z`，再不可用才回退 `[stub]`。`llm.oneshot` 是**无状态**补全（无会话上下文），
  会话/流式/审批等仍属 M5 剩余项。
- M5.0 的 `detect.ts` 会探测 `~/.local/bin/hermes` 等非 PATH 位置；`resolveHermesCli` 在
  `OS_HERMES_CLI` 已设置但路径不存在时返回“不可用”，不再回退到自动探测（便于测试隔离）。
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
- M3 配置编辑的**描述 / 标签**存放在工作台自有元数据 `~/.24os/agents/<id>/meta.json`，
  未写入 Hermes 自身文件（避免猜测其内部字段）；`GET /api/agents` 列表的描述仍来自
  `AGENT.md`/`README.md` 等，暂未合并 meta.json（后续可对齐）。
- `setEnvVar` 在检测到 `hermes` CLI 时优先执行 `hermes config set <KEY> <VALUE>`（值作为单个
  参数、无 shell）；CLI 不可用或失败时回退为直接编辑 `.env`。为保证密钥不外泄，无论走哪条
  路径，响应都不回显命令与明文值。当前环境下默认无 CLI，实际走 `.env` 直写路径。
- `restoreBackup` 通过备份文件名（`<file>.<ISO 时间戳>.bak`）推断原始文件名并限定在白名单内，
  还原前会对当前文件再备份一次；仅作为可选回滚能力，前端暂未提供入口。
- M2-core 的 `deleteAgent` 曾存在「返回的 `backupPath` 与 `backupAgent` 实际写入路径因跨毫秒
  生成而不一致」的缺陷，已在 M3 一并修复（改为复用实际备份路径）。
