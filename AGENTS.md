# AGENTS.md — 24H-OS 项目指南

> 供 AI 编码代理（opencode / Hermes / 其他）阅读。动手前先读本文件 + `README.md`（功能/API 详情）。
> 语言：与用户交流用**中文**；代码注释可用中英混合。

## 1. 项目定位

24H-OS 是**以 Hermes（`NousResearch/hermes-agent`）为核心的多 agent 桌面工作台**。

- **一个 Hermes profile = 一个 agent**（`~/.hermes/profiles/<name>/`；无命名 profile 时，`~/.hermes` 本身视为 `default`）。
- 复用 Hermes 原语：`profiles`、`profile distributions`（install/update/delete）、`skills/`、`mcp_servers`、`hermes` CLI、`hermes serve`（TUI gateway JSON-RPC）。
- **差异化核心 = 功能性 Skill 的 UI 宿主**：Hermes 的 skill 只有 `SKILL.md`、没有 UI；24H-OS 让功能性 skill 自带前端，在**沙箱 iframe** 中运行，通过 **postMessage RPC** 按需调用宿主能力（调模型 / 读写文件 / 跑工具）。

## 2. 架构

web-first（无显示器环境亦可开发；Electron 仅为未来外壳）：

- `server/` — Fastify 内核桥接层，端口 **4319**，封装 `hermes` CLI 与 `~/.hermes`
- `web/` — React 18 + TypeScript + Vite，dev 端口 **5173**（自动代理 `/api` → 4319）
- `shared/` — 前后端共享 TS 类型（alias `@shared/*`）
- `docs/` — `SKILL_UI_PROTOCOL.md`、`CONFIG_EDITING.md`
- `examples/skills/` — 示例功能性 skill（`ppt`，带 UI）
- `market/index.json` — 静态市场清单

## 3. 常用命令

```bash
npm install            # 安装依赖（Node >= 20）
npm run dev            # 同时起 server(4319) + web(5173)
npm run dev:server     # 仅内核桥接层
npm run dev:web        # 仅前端
npm run check          # ★ 验证命令：typecheck + vitest（每次改动后必跑）
npm test               # vitest run
npm run typecheck      # 两套 tsconfig 的 tsc --noEmit
npm run build          # vite build + typecheck
```

## 4. 硬性约定（务必遵守）

- **验证命令固定为 `npm run check`**；提交前必须通过（当前 154 个用例）。
- **配置写入官方命令优先**（v3.0 §4.2）：模型 / MCP / env 先试 `hermes [-p <id>] config set|unset ...`
  （`shell:false`；`default` 不加 `-p`），成功返回 `via:"cli"`；CLI 不可用 / 失败才回退文件写
  （`via:"file"`）。避免与 Hermes 进程并发写 config.yaml。MCP 用 `config set/unset mcp_servers.<name>`
  （官方 `mcp add` 交互 + discovery-first，不适合自动化）。description/tags 恒写工作台 `meta.json`。
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
- 不提交 `node_modules/`、`dist/`、`.env`；工具状态 `.vibe-loop.json`、`.vibe-loop-agents/` 已 gitignore。

## 5. 代码风格

- TypeScript **strict**、ESM；不引入 UI 库（手写 CSS，暗色主题）。
- 错误统一用 `ApiError { error, message }` + 错误码（见 `server/hermes/errors.ts`，码→HTTP 映射）。
- 单测与源码同目录（`*.test.ts`），用 **vitest**；测试使用**临时目录 / 注入路径**，**绝不触碰真实 `~/.hermes`**。
- 扩展点用 `TODO(M5)` / `TODO(M2+)` 注释标注。

## 6. 关键文件

- `server/hermes/profiles.ts` — 用 `yaml` 解析 `config.yaml` → 结构化 `Agent`
- `server/hermes/cli.ts` — 安全执行 `hermes`（spawn + 白名单 + dryRun）
- `server/hermes/detect.ts` — CLI 候选探测（env/PATH/local-bin/hermes-bin）+ 多 home（M5.0）+ `resolveCliHome` 包装脚本 home（M5.x）
- `server/hermes/gateway.ts` — `hermes serve` 子进程 + WS JSON-RPC 客户端 / 单例（M5.1）
- `server/hermes/complete.ts` — 模型补全降级链 `completePrompt`（gateway → `hermes -z` → stub）
- `server/hermes/lifecycle.ts` — install/update/delete/backup
- `server/hermes/configEdit.ts` — 模型 / 描述 / MCP / env 的安全落盘（官方命令优先 + `via`）
- `server/skillui/` — Skill UI 发现 / 静态托管 / broker / 工具（`ppt.export`）
- `web/components/SkillHost.tsx` — Skill UI 宿主 + RPC broker + 调试面板
- `shared/types.ts` — 所有前后端共享类型（改 API 先改这里）

## 7. 环境变量

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `HOST` / `PORT` | 监听地址 / 端口 | `127.0.0.1` / `4319` |
| `OS_TOKEN` | 非回环监听时的鉴权 token | 无 |
| `OS_ALLOWED_ORIGINS` | CORS 白名单（逗号分隔） | `http://localhost:5173,http://127.0.0.1:5173` |
| `OS_HERMES_CLI` | 覆盖 hermes CLI 路径（不存在则视为不可用，不回退自动探测） | 自动探测 |
| `OS_GATEWAY_PORT` | TUI gateway 固定端口 | `0`（OS 自选） |
| `OS_GATEWAY_ISOLATED` | 设为 `1` 时 gateway 加 `--isolated` | 关 |
| `OS_GATEWAY_START_TIMEOUT_MS` | 等待 `HERMES_BACKEND_READY` 超时 | `30000` |
| `OS_BACKUP_DIR` / `OS_CONFIG_BACKUP_DIR` | 备份根目录 | `~/.24os/backups` |
| `OS_META_DIR` | 工作台元数据根 | `~/.24os/agents` |
| `OS_SKILL_ROOTS` | Skill UI 扫描根（逗号分隔） | 仓库 `examples/skills` + `~/.hermes/skills` 等 |
| `OS_WORKSPACE_ROOT` | Skill 工作区沙箱根 | `~/.24os/workspace` |
| `OS_MARKET_FILE` | 市场清单路径 | `market/index.json` |
| `HERMES_HOME` / `OS_HERMES_HOME` | Hermes 主目录 | `~/.hermes` |

## 8. 当前状态与路线图

已完成：**M1**（只读骨架）、**M1.1**（加固）、**M4**（Skill UI 宿主 + PPT demo）、**M2-core**（生命周期 + 市场）、**M3**（配置编辑落盘）、**M5.0**（CLI/多 home 探测）、**M5.1**（TUI gateway + `callModel` 降级链，走 `llm.oneshot`）、**M5.x**（配置写入官方命令优先 + `via`；`resolveCliHome` 统一 home）。

待办：

- **M5 剩余**：会话管理 / 流式事件（`session.create` + `prompt.submit` + `message.*` 事件契约已探明）、审批/clarify、subagent、模型热切换。
- **M2 剩余**：Electron 外壳；Skill 安装/启停落盘；CLI 变更后的实时刷新。
- 其他：`runTool` 仅白名单 `ppt.export`；权限提示目前自动放行（未接交互式授权）；`GET /api/agents` 列表描述尚未合并 `meta.json`。

## 9. 提交约定

- 提交仅在**用户明确要求**时进行；消息格式 `<type>: <描述>`（`feat`/`fix`/`refactor`/`test`/`chore`）。
- 不写入任何密钥；提交前确认 `.git/config` 与跟踪文件中无 token。
