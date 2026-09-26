# AGENTS.md — 24H-OS 项目指南

> 供 AI 编码代理（opencode / Hermes / 其他）阅读。动手前先读本文件 + `README.md`（功能/API 详情）。
> 语言：与用户交流用**中文**；代码注释可用中英混合。

## 1. 项目定位

24H-OS 是**以 Hermes（`NousResearch/hermes-agent`）为核心的多 agent 桌面工作台**。

- **一个 Hermes profile = 一个 agent**（`~/.hermes/profiles/<name>/`；无命名 profile 时，`~/.hermes` 本身视为 `default`）。
- 复用 Hermes 原语：`profiles`、`profile distributions`（install/update/delete）、`skills/`、`mcp_servers`、`hermes` CLI、`hermes serve`（TUI gateway JSON-RPC）。
- **差异化核心 = 功能性 Skill 的 UI 宿主**：Hermes 的 skill 只有 `SKILL.md`、没有 UI；24H-OS 让功能性 skill 自带前端，在**沙箱 iframe** 中运行，通过 **postMessage RPC** 按需调用宿主能力（调模型 / 读写文件 / 跑工具）。
- **两种 UI 形态并存**：命令式 `ui/manifest.json`（`uiHost:"iframe"`）；声明式 `ui/panel.yaml`（`uiHost:"declarative"`，M4.1，零代码无任意 JS，宿主渲染表单/模板/预览/动作）。两者都有时优先 manifest。

## 2. 架构

web-first（无显示器环境亦可开发；Electron 为桌面分发外壳，`electron/main.cjs` 复用/拉起 server）：

- `server/` — Fastify 内核桥接层，端口 **4319**，封装 `hermes` CLI 与 `~/.hermes`
- `web/` — React 18 + TypeScript + Vite，dev 端口 **5173**（自动代理 `/api` → 4319）
- `shared/` — 前后端共享 TS 类型 + `panel.ts`（插值工具，alias `@shared/*`）
- `docs/` — `SKILL_UI_PROTOCOL.md`（命令式 + 声明式）、`CONFIG_EDITING.md`、`APP_MANIFEST.md`（M6 + M7 hooks/WS）、`CRON.md`（M8 官方 Cron 薄封装 + bots.yaml 迁移）、`CHANNELS.md`（M10 通道对齐 / 投递推荐 / Group Chat 决策）、`PROFILE_ALIGN.md`（M9 Bot=Profile / SOUL / disabled_skills / 头像 / meta.json 降级）
- `examples/skills/` — 示例功能性 skill（`ppt` 命令式、`outline` 声明式）
- `market/index.json` — 静态市场清单
- `market/apps/*.app.yaml` — M6 内置 AppManifest（`24os-appmanifest/1`）
- `scripts/build-server.mjs` — esbuild 打包 server → `dist/server.cjs`（单文件 CJS，全量内联）
- `electron/` + `package.json#build` — Electron 壳 + electron-builder（`npm run dist` → `release/`；`asarUnpack: ["dist/server.cjs","dist/web/**","market/**","examples/skills/**"]` → `app.asar.unpacked/`，供系统 node 直接执行；`files` 同步包含 `market/**`/`examples/skills/**`，否则打包后 `/api/market` 为空、示例 skill 不被发现）

## 3. 常用命令

```bash
npm install            # 安装依赖（Node >= 20）
npm run dev            # 同时起 server(4319) + web(5173)
npm run dev:server     # 仅内核桥接层
npm run dev:web        # 仅前端
npm run dev:desktop    # build:web + 并发 dev:server + electron（桌面壳开发）
npm run electron       # 启动 Electron 壳（复用/拉起 server，需先 build 才有静态 UI）
npm run check          # ★ 验证命令：typecheck + vitest（每次改动后必跑）
npm test               # vitest run
npm run typecheck      # 两套 tsconfig 的 tsc --noEmit
npm run build          # build:web + build:server + typecheck（dist/web + dist/server.cjs）
npm run build:server   # esbuild 打包 server → dist/server.cjs（单文件 CJS，全量内联）
npm run dist           # build + electron-builder --linux（产物 release/*.AppImage / *.deb）
```

## 4. 硬性约定（务必遵守）

- **验证命令固定为 `npm run check`**；提交前必须通过（当前 **509 个用例**：server 391 node +
  web 110 jsdom + shared 8）。`npm run check` = `typecheck` + `vitest run`，**一次同时跑两套环境**。
- **web 测试约定**：`web/**/*.test.tsx` 顶部写 `/** @vitest-environment jsdom */`，并
  `import "@testing-library/jest-dom/vitest"` + `afterEach(cleanup)`（vitest 未开 globals，
  RTL 不会自动清理）；`server/**` 保持 node 环境。网络/模型/WS 全部 mock，**不连真实后端、
  不触碰 `~/.hermes`**。fixture 与假 Response 放 `web/test-utils.ts`。
- **CI**：`.github/workflows/ci.yml` —— `check`（push main / PR / dispatch，node 20+22：
  `npm ci` → `check` → `build`）与 `dist`（仅 dispatch 或 `v*` tag：`npm run dist`）。
- **配置写入官方命令优先**（v3.0 §4.2）：模型 / MCP / env 先试 `hermes [-p <id>] config set|unset ...`
  （`shell:false`；`default` 不加 `-p`），成功返回 `via:"cli"`；CLI 不可用 / 失败才回退文件写
  （`via:"file"`）。避免与 Hermes 进程并发写 config.yaml。MCP 用 `config set/unset mcp_servers.<name>`
  （官方 `mcp add` 交互 + discovery-first，不适合自动化）。
  **M9**：描述（SOUL）/ 短描述 / skill 启停走官方 **`profiles.configure` RPC**（`via:"rpc"`，
  复用已连接的共享 gateway；不可用则回退 `SOUL.md` / `meta.json`）。`meta.json` 降级为「24H-OS
  专有备注」（tags + 回退副本），见 `docs/PROFILE_ALIGN.md`。
- **写操作四重保证**（配置编辑文件回退 / 生命周期）：
  1. `confirm:true` 门禁 —— 未带则 `CONFIRM_REQUIRED`，不触碰磁盘；
  2. 先备份到 `~/.24os/backups/`（每文件最多 10 份，超出删最旧）；
  3. **原子写**：同目录临时文件 + `rename`；
  4. **密钥不回显**：`.env` 只返回键名，响应/日志不得出现明文值。
- **home 一致性**：`detect.ts#resolveCliHome` 解析 CLI 包装脚本的 `HERMES_HOME`；无显式 env 覆盖时
  以其作为 `activeHome`，`profiles.ts` / `configEdit.ts` 必须使用同一 home（勿硬编码 `~/.hermes`）。
- **绝不 shell 注入**：用 `child_process.spawn` + 参数数组，**禁止 `shell:true`**；`hermes` 子命令走**白名单**（`hermes serve` 例外：不进 `runHermes`，由 `server/hermes/gateway.ts` 用固定参数单独 spawn）。
- **id 正则**：`^[a-z0-9][a-z0-9_-]{0,63}$`；env key：`^[A-Z][A-Z0-9_]*$`；MCP 名：`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$`。所有路径解析后必须校验在允许根目录内（防穿越）。
- **安全基线**：默认仅监听 `127.0.0.1`；CORS 白名单（`OS_ALLOWED_ORIGINS`）；非回环监听强制 `OS_TOKEN`（校验 `x-24os-token`）。
- **不要猜测 Hermes 内部 schema**：不确定的字段用工作台自有元数据（`~/.24os/agents/<id>/meta.json`）或加注释说明。
- 不提交 `node_modules/`、`dist/`、`release/`、`.env`；工具状态 `.vibe-loop.json`、`.vibe-loop-agents/` 已 gitignore。
- **应用根统一用 `server/paths.ts#APP_ROOT`**（勿在模块内各自推算相对层级）：源码 `server/` 与
  打包 `dist/server.cjs` 两种形态下都解析到应用根；esbuild 用 `define`+banner 还原 `import.meta.url`。

## 5. 代码风格

- TypeScript **strict**、ESM；不引入 UI 库（手写 CSS，暗色主题）。
- 错误统一用 `ApiError { error, message }` + 错误码（见 `server/hermes/errors.ts`，码→HTTP 映射）。
- 单测与源码同目录（`*.test.ts`），用 **vitest**；测试使用**临时目录 / 注入路径**，**绝不触碰真实 `~/.hermes`**。
- 扩展点用 `TODO(M5)` / `TODO(M2+)` 注释标注。

## 6. 关键文件

- `server/hermes/profiles.ts` — 用 `yaml` 解析 `config.yaml` → 结构化 `Agent`
- `server/hermes/cli.ts` — 安全执行 `hermes`（spawn + 白名单 + dryRun）
- `server/hermes/detect.ts` — CLI 候选探测（`OS_HERMES_CLI` 显式无效即停不回退）+ 多 home（M5.0）+ `resolveCliHome` 包装脚本 home（M5.x）
- `server/hermes/index.ts` — 快照聚合 + TTL 缓存 + `invalidateAgentsCache()`（写操作后失效）
- `server/hermes/gateway.ts` — `hermes serve` 子进程 + WS JSON-RPC 客户端 / 单例（M5.1）；会话方法与服务端请求（M5.2）
- `server/hermes/chat.ts` — `streamPrompt` 会话 + 流式事件归一化（`ChatStreamEvent`）+
  审批策略（M5：`autoApprove` 立即放行 / 非交互立即安全默认 / `interactive` 挂起待
  `decideApproval(chatId, decision)`，超时 `decisionTimeoutMs`（默认 120s）与流结束自动
  deny/空答案兜底 + `decision.fallback` 事件）+ `switchSessionModel(client, sessionId, model, {force})`
  （`config.set model` 热切；force/autoApprove → 契约键 `confirm_expensive_model`）
  + `streamPrompt({model, force})` → `session.create.model` + 创建后经 config.set 走 selection guard，
  `confirm_required` → `session/model.confirm_required` 事件 + interrupted（**不静默放行**，
  前端 Modal 确认后带 `force:true` 重试 SSE）
- `server/hermes/subagent.ts` — M5/M10 subagent：**无 spawn API**（子代理走会话内 `delegate_task`）；
  观测/控制薄封装 `listSubagents`/`interruptSubagent`/`tailSubagent`/`steerSubagent`/`setSpawnPaused`
  （风格对齐 `cron.ts`）+ `getSubagentSupport()`（`{spawnApi:false,controlApi:true,events:true,mechanism}`）+
  `runSubagent` 恒 `SPAWN_UNSUPPORTED`（不造假）；末尾 `TODO(M10+: groups.*)`
- `server/hermes/complete.ts` — 模型补全降级链 `completePrompt`（gateway → `hermes -z [-m model]` → stub）
- `server/hermes/lifecycle.ts` — install/update/delete/backup
- `server/hermes/configEdit.ts` — 模型 / 描述（SOUL）/ MCP / env / skill 启停的安全落盘（官方优先 + `via`）+ `readAgentMeta` / `listDisabledSkillNames` / `readAgentDisabledSkills` / `readSoul`
- `server/hermes/profileRpc.ts` — **M9 官方 Profile 薄封装**：`profiles.list/describe/configure/create/set_asset/get_asset` + 头像校验（PNG/JPEG ≤256KB）+ 结构化错误（`PROFILE_RPC_ERROR`/`PROFILE_NOT_FOUND`/`INVALID_ASSET`）；风格对齐 `cron.ts`
- `server/appmanifest/` — AppManifest 解析校验（`manifest.ts`）、编排 install/update/uninstall/rollback（`apply.ts`）、事件总线（`events.ts`）、签名（`sign.ts`）、安装记录（`store.ts`，env 脱敏）
- `server/hooks/` — M7 hooks 执行体（`executor.ts` 订阅 app 事件 / `runHook`）+ `outbound.ts` HMAC 签名推送
- `server/dashboard/bus.ts` — M7 Dashboard 广播总线（`setBroadcast`/`broadcast` 单点注入）
- `server/hermes/cron.ts` — **M8 官方 Cron 薄封装**：`cron.manage` RPC（list/add/remove/pause/resume）+ `cron.changed` 事件订阅（失效缓存 + Dashboard WS 广播）+ 结构化错误（`CRON_UNAVAILABLE`/`CRON_RPC_ERROR`/`CRON_JOB_NOT_FOUND`）+ 写前备份 `~/.24os/backups/cron/`；`runCronJob` 走 CLI 兜底（`hermes cron run`，`stdio[0]="ignore"` + 超时）。**定时不在工作台实现，只让 `hermes serve` 带 `HERMES_DESKTOP=1` 触发官方 ticker**（`gateway.ts#resolveGatewayEnv`，`OS_CRON_TICKER=0` 关闭）
- `server/routes/cron.ts` — M8 `GET /api/cron/jobs` + `POST /api/cron/jobs`(confirm) + `POST /api/cron/jobs/:name/pause|resume|remove|run`(confirm)；`/api/bots` 与 `bots.yaml` 已废弃
- `server/routes/agents.ts` — agent 列表/详情/生命周期/配置编辑；M9 头像 `GET/POST /api/agents/:id/avatar`（confirm + ≤256KB PNG/JPEG）+ 描述/skill 启停对齐官方
- `server/routes/ws.ts` — M7 `GET /api/ws` Dashboard WebSocket（鉴权同安全基线，30s 心跳，广播 `cron.changed` 等）
- `server/skillui/` — Skill UI 发现（`discover.ts`，manifest/panel 判定）/ 声明式面板解析校验（`panel.ts`）/ 静态托管 / broker / 工具（`ppt.export`）/ 启停聚合判定（`disabled.ts`：`isSkillDisabled`，官方 `config.yaml skills.disabled` 优先、meta 回退，与 `GET /api/skill-uis` 的 `disabled` 同口径、每次读盘；broker invoke / panel / 静态三条路径强制 403 `SKILL_DISABLED`）
- `server/routes/hermes.ts` — 状态/gateway 启停 + SSE `/api/hermes/chat/stream`（body：`chatId`/`model`/`force`，`interactive:true`）+ `POST /api/hermes/chat/decide` + subagent 观测/控制（M10：`GET /api/hermes/subagents` + `GET /:id/tail` + `POST /:id/interrupt`(confirm) + `POST /:id/steer` + `POST /pause`(confirm)；旧 `POST /api/hermes/subagent` → 501 `SPAWN_UNSUPPORTED`）
- `server/paths.ts` — `APP_ROOT` 统一解析（源码 `server/` 与打包 `dist/server.cjs` 同语义，勿各自推算层级）
- `scripts/build-server.mjs` — esbuild 打包 server → `dist/server.cjs`（`platform:node`/`format:cjs`/`bundle`；全量内联，失败回退 `packages:"external"`）
- `server/staticWeb.ts` — M2 外壳：`dist/web` 生产静态托管 + SPA fallback + 防穿越 + 回环 token 豁免（`shouldBypassWebToken`）
- `electron/main.cjs` / `electron/preload.cjs` — Electron 主进程（复用/拉起 server；**有 `dist/server.cjs` 时优先用系统 node spawn 该产物，否则回退 tsx**；打包态经 `asarUnpack` 解包，用 `app.getAppPath()` 判定并映射 `app.asar` → `app.asar.unpacked` 解析入口/`cwd`/`OS_WEB_DIST`；`market/**`/`examples/skills/**` 亦解包至同一根，由 `APP_ROOT` 命中、**无需额外 env**；headless 退出 0、安全默认）+ 最小 preload（仅 `{ platform }`）
- `web/components/SkillHost.tsx` — 命令式 Skill UI 宿主 + RPC broker + 调试面板 + 审批/澄清卡片 + 模型下拉 + 昂贵模型确认 Modal（force 重试）
- `web/components/DeclarativePanel.tsx` — 声明式面板渲染（表单 / 模板 / 预览 / SSE + 审批/澄清卡片 + 模型下拉 + 昂贵模型确认 Modal）
- `web/components/CronPanel.tsx` — M8 定时任务视图（读官方 cron jobs：schedule/next_run_at/last_status/enabled + pause/resume/run-now/remove + 新增表单；展示官方 ticker 状态）
- `shared/types.ts` / `shared/panel.ts` — 共享类型与 `{{key}}` 插值工具（改 API 先改这里）
- `web/test-utils.ts` — 前端单测 fixture + 假 JSON/SSE Response（不连网络）
- `web/**/*.test.{ts,tsx}` — jsdom 前端单测（api / 组件 / 页面 / App）；`shared/panel.test.ts` 补插值边界
- `.github/workflows/ci.yml` — CI：`check`（node 20/22，`npm ci`+`check`+`build`）+ `dist`（dispatch / `v*` tag）

## 7. 环境变量

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `HOST` / `PORT` | 监听地址 / 端口 | `127.0.0.1` / `4319` |
| `OS_TOKEN` | 非回环监听时的鉴权 token | 无 |
| `OS_ALLOWED_ORIGINS` | CORS 白名单（逗号分隔） | `http://localhost:5173,http://127.0.0.1:5173` |
| `OS_HERMES_CLI` | 覆盖 hermes CLI 路径（**已设置但不存在 → 视为不可用、不回退探测**，`cliSource:"env"`/`cliPath:null`） | 自动探测 |
| `OS_GATEWAY_PORT` | TUI gateway 固定端口 | `0`（OS 自选） |
| `OS_GATEWAY_ISOLATED` | 设为 `1` 时 gateway 加 `--isolated` | 关 |
| `OS_GATEWAY_START_TIMEOUT_MS` | 等待 `HERMES_BACKEND_READY` 超时 | `30000` |
| `OS_GATEWAY_AUTO_APPROVE` | 设为 `1` 时**优先自动**放行审批（`approval→once`、`clarify→第一个选项`，不打断 UI）；否则 SSE 交互流挂起待 `chat/decide`，非交互立即安全默认 deny | 关 |
| `OS_BACKUP_DIR` / `OS_CONFIG_BACKUP_DIR` | 备份根目录 | `~/.24os/backups` |
| `OS_META_DIR` | 工作台元数据根 | `~/.24os/agents` |
| `OS_SKILL_ROOTS` | Skill UI 扫描根（逗号分隔） | 仓库 `examples/skills` + `~/.hermes/skills` 等 |
| `OS_WORKSPACE_ROOT` | Skill 工作区沙箱根 | `~/.24os/workspace` |
| `OS_MARKET_FILE` | 市场清单路径 | `market/index.json` |
| `OS_MARKET_APPS_DIR` | builtin AppManifest 目录 | `market/apps` |
| `OS_APPS_DIR` | App 安装记录根 | `~/.24os/apps` |
| `OS_CRON_TICKER` | 设为 `0` 关闭「让 `hermes serve` 带 `HERMES_DESKTOP=1` 触发官方 cron ticker」 | 开 |
| `OS_CRON_CACHE_TTL_MS` | 官方 cron jobs 列表缓存 TTL | `2000` |
| `OS_WEB_DIST` | 生产静态托管产物根（显式覆盖，无效则不启用） | 自动探测 `dist/web` → `web/dist` |
| `HERMES_HOME` / `OS_HERMES_HOME` | Hermes 主目录 | `~/.hermes` |

## 8. 当前状态与路线图

已完成：**M1**（只读骨架）、**M1.1**（加固）、**M4**（Skill UI 宿主 + PPT demo）、**M4.1**（声明式 `ui/panel.yaml` 面板 + `outline` demo，零代码 / 无任意 JS，与命令式并存）、**M2-core**（生命周期 + 市场）、**M3**（配置编辑落盘）、**M5.0**（CLI/多 home 探测）、**M5.1**（TUI gateway + `callModel` 降级链，走 `llm.oneshot`）、**M5.x**（配置写入官方命令优先 + `via`；`resolveCliHome` 统一 home）、**M5.0b**（skillui 发现统一到 `activeHome`）、**M5.2**（`session.create`/`prompt.submit`/`session.interrupt`/`session.close` + 流式事件归一化 + SSE `/api/hermes/chat/stream` + 审批安全默认 + Skill UI `chatStream`）、**M5.3**（交互式审批/clarify：`chatId` + `decideApproval` + `POST /api/hermes/chat/decide` + 前端决策卡片 + 超时/流结束安全兜底；模型：`streamPrompt({model})` + `switchSessionModel`（`config.set model` 热切）+ SSE `model?` + 前端模型下拉 + `hermes -z -m`；subagent：观测/控制存在、spawn RPC 不存在——工作台化见 M10）、**M6**（AppManifest `24os-appmanifest/1`：解析校验 + install/update/uninstall/rollback 编排 + `market/apps` + `/api/market*` 合并与 apply + 签名 + 事件总线 + `apps/<id>.json` 脱敏存储）、**M7**（hooks 执行体 + outbound HMAC 签名推送 + Dashboard WS `/api/ws` + 前端状态抽屉）、**M8**（**定时 = 官方 Hermes Cron**：`server/hermes/cron.ts` 薄封装 `cron.manage` RPC + `cron.changed` 事件 + `server/routes/cron.ts`（confirm 门禁）+ `web/components/CronPanel.tsx`；自研 `bots.yaml`/30s 调度器**已删除**；官方 ticker 由 `HERMES_DESKTOP=1` 的 `hermes serve` 触发，`OS_CRON_TICKER=0` 关闭）、**M9**（**Bot=Profile 对齐官方**：`server/hermes/profileRpc.ts` 薄封装 `profiles.list/describe/configure/create/set_asset/get_asset` + 结构化错误；描述/persona 读写对齐 `SOUL.md`（官方 `profiles.configure{soul}` 优先、`via:"rpc"`；RPC 不可用回退文件写）；skill 启停走官方 `disabled_skills`（`config.yaml skills.disabled` 优先、meta 回退）；头像 `GET/POST /api/agents/:id/avatar`（confirm + PNG/JPEG ≤256KB）；`meta.json` 降级为「24H-OS 专有备注」，见 `docs/PROFILE_ALIGN.md`）、**M2 外壳**（`electron/main.cjs` + `preload.cjs`：复用/拉起 server、生产静态托管 `server/staticWeb.ts`、headless 退出 0；**M2 打包**：`scripts/build-server.mjs` → `dist/server.cjs` + electron-builder `npm run dist`，`asarUnpack` 解包 `dist/server.cjs`/`dist/web/**` + `main.cjs` 打包态路径映射）、**M2 杂项**（detect 对齐：`OS_HERMES_CLI` 显式无效不回退 / home 显式 env 无效即停；Skill 启停落盘 `POST /api/agents/:id/skills` + `skill-uis.disabled`；`invalidateAgentsCache` 写后失效；`GET /api/agents` 列表/详情合并 meta description/tags/skills）、**M10**（**subagent 观测/控制 + 事件透出**：`server/hermes/subagent.ts` 薄封装 `subagent.list/tail/interrupt/steer`、`delegation.pause`（风格对齐 `cron.ts`）+ `GET /api/hermes/subagents` + `/subagents/:id/{tail,interrupt,steer}` + `/subagents/pause`；`chat.ts` 把 `subagent.*` 归一化为 `type:"subagent"`（phase `spawn_requested/start/progress/thinking/tool/complete`，未知→`unknown`）并 SSE 透出；`getSubagentSupport()` → `{spawnApi:false,controlApi:true,events:true,mechanism:"delegate_task (in-session tool)"}`；旧 `POST /api/hermes/subagent` → 501 `SPAWN_UNSUPPORTED`。**通道对齐**：`docs/CHANNELS.md`（实测 `hermes gateway run` 无 token 退化为 "No messaging platforms enabled" 且保持运行；`hermes serve` 不启动平台适配器；投递推荐官方 `cron --deliver`；`hooks.outbound` 定位第三方回调扩展）。**Group Chat 不做**（属官方 Desktop，留 `TODO(M10+: groups.*)`））、**测试加固**（web vitest jsdom 110 例 + shared 8 例 → 全量 **509**；`.github/workflows/ci.yml` 的 `check`(node 20/22) + `dist`(dispatch/tag)）。

待办：

- **M5 剩余**：`session.resume`/`session.list` 等会话浏览、subagent **spawn**（官方契约待暴露；
  当前仅有观测/控制面 + 事件透出，见 `server/hermes/subagent.ts` 与 `docs/CHANNELS.md`）、模型热切对**已流式中**
  会话为 `deferred`（下一 turn 生效，契约行为）。
  昂贵模型 `confirm_expensive_model` 交互确认 ✅ 已完成（`switchSessionModel({force})` +
  `session/model.confirm_required` 事件 + SSE `force` + 前端 Modal，`OS_GATEWAY_AUTO_APPROVE=1` 自动 force）。
  Skill 启停强制拦截 ✅ 已完成（`skillui/disabled.ts` + invoke/panel/静态 403 `SKILL_DISABLED`）。
- ~~**M2 打包**：electron-builder（`package.json#build` + `scripts/build-server.mjs` + `npm run dist`，产出 `release/*.AppImage` / `*.deb` + asar，asar 内含 `dist/server.cjs` 与 `dist/web/index.html`）~~ ✅ 已完成。
- ~~**M2 打包修复**：`dist/server.cjs` 在 asar 内无法被系统 node 读取 → `asarUnpack: ["dist/server.cjs","dist/web/**"]` + `electron/main.cjs` 打包态 `app.asar` → `app.asar.unpacked` 路径映射（`app.getAppPath()` 判定，不硬编码）；打包态 headless 首启实测 200/exit 0~~ ✅ 已完成。
- ~~**M2 打包内容修复**：`files` 补齐 `market/**`、`examples/skills/**` 并同步进 `asarUnpack`。打包后 `server.cjs` 解包于 `app.asar.unpacked/dist/` → `server/paths.ts#APP_ROOT` 自然解析到 `app.asar.unpacked/`，`market/index.json`、`market/apps/*.app.yaml`、`examples/skills/**` 随之被 `readFileSync`/`readdirSync` 命中（系统 node 不认 asar，故必须解包）。**无需传额外 env**（`OS_MARKET_FILE`/`OS_MARKET_APPS_DIR`/`OS_SKILL_ROOTS` 的默认值均基于 APP_ROOT；显式设置的用户 env 不覆盖）。打包态 headless 冒烟：`/api/market` 5 条（含 `ppt-maker`）、`/api/skill-uis` 含 `ppt`+`outline`、exit 0、无残留~~ ✅ 已完成。
- 其他：`runTool` 仅白名单 `ppt.export`；权限提示目前自动放行（未接交互式授权）。
- **M8 风险**：`deliver` 指向 telegram/discord 等平台通道时，无头环境未配 token → 官方投递会记 `last_delivery_error`（任务本身仍执行）；无头建议 `deliver:"local"`。官方 `cron.manage` 触发依赖 gateway（`hermes serve`）在跑——工作台首次访问 cron API / chat 时才惰性拉起共享 gateway。
- **通道 / Group Chat（M10 决策）**：平台适配器由独立 `hermes gateway` 进程持有（`hermes serve` **不**启用平台；实测无 token 时 `gateway run` 退化 `No messaging platforms enabled` 并保持运行）；Bot 投递推荐官方 `cron --deliver <platform:chat_id|bot-chat[:profile]>`，自研 `hooks.outbound` 仅作第三方 HTTP 回调扩展；**Group Chat 不做**（官方 Desktop 主战场，入口 `groups.*` + `bot_relay.*`），详见 `docs/CHANNELS.md` 与 `TODO(M10+: groups.*)`。

## 9. 提交约定

- 提交仅在**用户明确要求**时进行；消息格式 `<type>: <描述>`（`feat`/`fix`/`refactor`/`test`/`chore`）。
- 不写入任何密钥；提交前确认 `.git/config` 与跟踪文件中无 token。
