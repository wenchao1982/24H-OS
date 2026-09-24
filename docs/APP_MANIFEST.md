# AppManifest（M6 · `24os-appmanifest/1`）

以 Hermes 官方 **profile distributions**（`install/update/delete` + `distribution.yaml`）为底座，
工作台侧扩展的 **App 交付清单**：把「一个 App（agent 应用）的完整交付」表达为单个 YAML，
并实现 **安装 / 更新 / 卸载 / 回滚** 编排，增强 `market/index.json`。

实现：

| 模块 | 文件 |
| --- | --- |
| 类型 | `shared/types.ts` |
| 解析 / 校验 / builtin 目录 | `server/appmanifest/manifest.ts` |
| 编排 | `server/appmanifest/apply.ts` |
| 事件总线（M7 订阅） | `server/appmanifest/events.ts` |
| 签名 | `server/appmanifest/sign.ts` |
| 安装记录 | `server/appmanifest/store.ts` |
| 内置 App | `market/apps/*.app.yaml` |
| 路由 | `server/routes/agents.ts`（`/api/market*`） |
| **hooks 执行体（M7）** | `server/hooks/executor.ts` |
| **outbound 签名推送（M7）** | `server/hooks/outbound.ts` |
| **Dashboard 广播总线（M7）** | `server/dashboard/bus.ts` |

## 1. 规范

```yaml
protocol: 24os-appmanifest/1
id: ppt-maker            # ^[a-z0-9][a-z0-9_-]{0,63}$
name: PPT 制作
version: 1.0.0           # ^\d+\.\d+\.\d+$
description: 选模板、填主题，一键生成 PPT
source:
  type: builtin | path | url
  path: examples/skills/ppt     # type=builtin/path 时必填（builtin 相对仓库根）
  url: ""                       # type=url 时必填（http(s)/ssh/git@）
profile:                      # 交付到 Hermes 的 profile 配置
  template: default           # 基于哪个已有 profile 模板（无则空 profile）
  model:
    default: kimi-k2.5         # configEdit 官方命令优先写入
  mcp:
    - name: filesystem
      config: { command: npx, args: ["-y", "@modelcontextprotocol/server-filesystem"] }
  env:                        # 键名 ^[A-Z][A-Z0-9_]*$；密钥只存，GET 永不回显
    MY_API_KEY: ""
  skills:
    - ppt                     # 复制到 <activeHome>/skills/<name>
ui:
  skillId: ppt                # 指向 skillui 发现结果
  host: iframe                # iframe | declarative
hooks:                        # M6 只声明与 emit，M7 实现执行体
  oninstall: [ui.open]        # 白名单：ui.open | config.apply | notify
  onupdate: []
  ondelete: []
plugins:                      # 输出通道（channels→plugins）
  - name: ops-push
    kind: http                # 目前仅 http
    endpoint: ""
    envKey: REPORT_WEBHOOK    # 从 profile.env 取 token（不回显）
sign:                         # 可选完整性校验
  sha256: ""                  # 留空 = 跳过；64 位 hex = 必须匹配
```

### 1.1 校验规则（非法 → `INVALID_MANIFEST` → HTTP 400）

- `protocol` 必须为 `24os-appmanifest/1`；
- `id` 匹配 `^[a-z0-9][a-z0-9_-]{0,63}$`；
- `version` 匹配 `^\d+\.\d+\.\d+$`（宽松 semver，无预发布/构建号）；
- `source.type` ∈ `builtin | path | url`；`builtin/path` 必须有 `path`，`url` 必须有 `url`；
- `ui.host` ∈ `iframe | declarative`（提供 `ui` 时）；
- `hooks.*` 每项 ∈ `ui.open | config.apply | notify`；
- `plugins[].kind` ∈ `http`；`envKey` 匹配 env 键名正则；
- `profile.env` 键名匹配 `^[A-Z][A-Z0-9_]*$`，值必须是字符串；
- `profile.mcp[].name` 匹配 MCP 名正则，`config` 必须是对象；
- `sign.sha256` 留空或 64 位 hex。

## 2. 签名算法（`sign.sha256`）

对 `source.path` 目录：

1. 递归收集所有普通文件的相对路径（`/` 分隔）；
2. 按相对路径字典序排序；
3. 依次 `sha256.update(relPath + "\n" + fileBytes)`；
4. 输出 hex 小写。

`verifySign`：`sha256` 为空 → `skipped`；无源目录 → `skipped`；不匹配 → `SIGN_MISMATCH`（400）。

## 3. 编排（`applyAppManifest`）

统一入口：

```ts
applyAppManifest(manifest, { mode: "install" | "update" | "uninstall" | "rollback", confirm })
```

### 3.1 安全门禁与写保证（四重）

1. **confirm**：无 `confirm:true` → `CONFIRM_REQUIRED`，**不触碰磁盘**（第一步）；
2. **备份**：update / uninstall 前 `lifecycle.backupAgent`（`~/.24os/backups/<id>-*.tar.gz`）；
3. **原子写**：`apps/<id>.json` 与文件回退均临时文件 + `rename`；
4. **密钥不回显**：store 中 `profile.env` 值一律 `"***"`；响应 message 不含明文。

`apps/<id>.json` 是**最后一步**才写：中途失败不产生“半安装”记录，不破坏已有安装。

### 3.2 install

1. `confirm` 门禁；
2. `verifySign`（只读）；
3. profile 不存在 → `lifecycle.install`：
   - market `index.json` 有同 id 条目 → 用其 `source`；
   - 否则本地 `source.path`（`hermes profile install <dir> --name <id>`）；
   - 仍无目录 → 若 `profile.template` 存在则复制模板，否则创建空 profile 目录；
4. `configEdit` 写 model / mcp / env（官方命令优先，`via: cli|file`）；
5. `profile.skills` 复制到 `<activeHome>/skills`（候选：`<source>/skills/<name>` → `<source>/<name>` → 源即 skill 根；**防穿越**）；
6. **最后**写 `~/.24os/apps/<id>.json`（manifest 快照脱敏 + `installedAt` + backup 引用）；
7. `emitAppEvent("app.install", { hooks: manifest.hooks.oninstall ?? [], ... })`。

### 3.3 update

1. `confirm` 门禁；
2. 若已有记录：`backupAgent` 备份当前 profile，并把**上一版** `{version, manifest, backupPath}` 推入 `history`；
3. 重跑 install 步骤（幂等：MCP 已存在则 update 而非 add）；
4. 写回记录（`version` 迁移 + `updatedAt`）；
5. `emit("app.update")`（hooks: `onupdate`）。

### 3.4 uninstall

1. `confirm` 门禁；
2. 删除前自动备份（`deleteAgent({ backup: true })`，备份失败中止）；
3. 删 `~/.24os/apps/<id>.json`；
4. `emit("app.uninstall")`（hooks: `ondelete`）。

### 3.5 rollback

1. `confirm` 门禁；
2. 读最近记录的 `history` 末项（上一版 manifest + 备份 tar.gz）；无 → `BACKUP_NOT_FOUND`；
3. 若有 tar.gz → `hermes profile import <tar.gz>`（白名单）恢复 profile；
4. 用上一版 manifest 经 `configEdit` 重放 model/mcp/env（确保文件与快照一致）；
5. 写回记录：`version` / `manifest` 回到上一版（当前版本保留在 history 以便再滚回）；
6. `emit("app.rollback")`。

每步失败抛结构化 `LifecycleError`；`apps/<id>.json` 仅在成功路径最后写入。

## 4. 事件总线

```ts
onAppEvent("app.install", listener) → unsubscribe
emitAppEvent("app.install", { id, version, mode, hooks, ui, at, backupPath?, manifest? })
```

- M6 只 emit；**M7** 由 `server/hooks/executor.ts#startHookExecutor` 订阅后：
  1. 向 Dashboard WS 广播生命周期（`app.install` / `app.update` / `app.uninstall` / `app.rollback`）；
  2. 按 `payload.hooks` 顺序执行各 hook（见下节）。
- `payload.manifest` 为**进程内完整 manifest**（含 env 明文 / plugins），仅供 executor 使用，**绝不落盘、绝不进 GET 响应**。

## 5. Hooks 执行体（M7）

`server/hooks/executor.ts`：

| Hook | 语义 | 广播 |
| --- | --- | --- |
| `ui.open` | 前端据 `skillId` 高亮/打开 Skill UI | `{type:"hook.ui.open", payload:{skillId, appId}}` |
| `config.apply` | `reapplyProfileConfig` → `configEdit` 官方命令优先重放 model/mcp/env | `{type:"hook.config.apply", payload:{appId, via}}` |
| `notify` | 对 `manifest.plugins` 逐个 `outbound.pushNotify`（HMAC 签名） | `{type:"hook.notify", payload:{appId, results[]}}` |

- 每次执行写入**内存环形缓冲**（最近 100 条：`{hook, appId, status, at, error?}`）→ `GET /api/hooks/log`；
- 异常 **catch + 记录，绝不抛穿**编排主流程；
- 双通道：`startHookExecutor()` 订阅总线；亦可导出 `runHook(hook, manifest, ctx)` 供 apply 直调。

### 5.1 outbound 签名推送（`server/hooks/outbound.ts`）

```ts
POST <plugin.endpoint>
content-type: application/json
x-24os-timestamp: <ms>
x-24os-signature: sha256=<HMAC(token, timestamp + "." + body)>
```

- `token` 取自 apply 时传入的明文 map，或实际 profile `.env`（`envKey` 键）；
- 无 endpoint / 取不到明文 token → **`skipped`**（不报错、不回显 token）；
- body 为 JSON（`{event:"app.hook", hook, appId, version, mode, at, ...}`）。

## 6. Market 与 API

- `market/apps/<id>.app.yaml`：内置 AppManifest（`source.type: builtin`）；
- `GET /api/market`：静态 `index.json` 条目 **合并** 同 id AppManifest 元信息
  （`uiHost` / `hooks` / `appManifest: true`）；仅存在于 `market/apps` 的 App 追加为条目；
- `GET /api/market/apps/:id`：返回解析后的 AppManifest（404 `APP_NOT_FOUND`）；
- `POST /api/market/:id/apply`：body `{ mode?, confirm? }` → `applyAppManifest`；
- `POST /api/agents/install`：兼容入口（`type:"market"` 委托 apply；否则走原 `installAgent`）；
- `GET /api/hooks/log`：最近 100 条 hook 执行记录。

## 7. 环境变量

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `OS_MARKET_APPS_DIR` | builtin AppManifest 目录 | 仓库 `market/apps` |
| `OS_APPS_DIR` | 安装记录根 | `~/.24os/apps` |

## 8. Dashboard WS 协议（M7 · `GET /api/ws`）

`server/routes/ws.ts` 在 Fastify 底层 server 挂 upgrade；`server/dashboard/bus.ts` 提供单一 `broadcast(event)` 注入点。

### 8.1 鉴权（同安全基线）

| 条件 | 规则 |
| --- | --- |
| 回环监听（`HOST` ∈ `127.0.0.1` / `localhost` / `::1`） | 匿名可连 |
| 非回环监听 | 必须 `?token=` 或 `x-24os-token` == `OS_TOKEN`，否则 **401** 关闭 |

### 8.2 消息格式（JSON）

- **服务端 → 客户端**：`{ type, at, payload? }`
- **客户端 → 服务端**：`{ type: "ping" }` → `{ type: "pong", at }`

连接建立后服务端立即发 `hello`。

### 8.3 广播事件类型

| type | 来源 | payload 摘要 |
| --- | --- | --- |
| `app.install` / `app.update` / `app.uninstall` / `app.rollback` | 事件总线 | `{id, version, mode, at}` |
| `hook.ui.open` / `hook.config.apply` / `hook.notify` | hooks executor | 见 §5 |
| `gateway.start` / `gateway.stop` / `gateway.error` | gateway 状态监听 | `{port?}` / `{message?}` |
| `chat.delta` / `chat.done` / `chat.error` | SSE chat stream 摘要 | `{profile?, len}`（**绝不含 prompt/正文**） |
| `bot.run` | Bot Mode 调度 | `{botId, status, at, len?}` |

### 8.4 连接管理

`Map<ws, {alive}>`；30s ping/pong 心跳防僵死；关闭时清理。

## 9. Bot Mode（M7）

### 9.1 花名册 `bots.yaml`

路径：`~/.24os/bots.yaml`（可用 `OS_BOTS_FILE` 覆盖）；仓库样例 `bots.example.yaml`。

```yaml
bots:
  - id: daily-report          # ^[a-z0-9][a-z0-9_-]{0,63}$
    schedule: "09:00"         # 每天 HH:MM（服务器本地时区），^\d{2}:\d{2}$
    profile: default          # Hermes profile（缺省 default）
    prompt: "生成今日运营简报…"
    notify: [ops-push]        # 已安装 app 的 plugins[].name
    enabled: true             # 或 disable: true 关闭
```

校验：id 正则、schedule 正则 + 范围、prompt 非空；非法条目跳过并记入 `errors`。

### 9.2 调度机制

- `startScheduler(deps)` / `stopScheduler()`；默认 **关**（`OS_BOT_ENABLED=1` 才在 `server/index.ts` 启动时自动 start）；
- 内部 `setInterval` 每 **30s** tick，比对当前 `HH:MM`（`deps.now()` 可注入假时钟）；
- 到点且**今日该分钟未跑** → 执行：
  1. `ensureGateway` → `streamPrompt`（失败回退 `completePrompt` 降级链）；
  2. 结果经 `outbound.pushNotify` 推到 bot `notify` 的 plugins；
  3. 广播 `{type:"bot.run", payload:{botId, status, at, len?}}`（**不广播正文**）；
  4. 写环形运行日志（最近 100）。
- `POST /api/bots/:id/enable|disable`：改**内存态**（落盘需另走四重保证，当前不落盘）。

### 9.3 API

| 端点 | 说明 |
| --- | --- |
| `GET /api/bots` | 列表 + `nextRun` + `lastRun` + 调度器状态 + 最近日志 |
| `GET /api/bots/log` | 环形运行日志 |
| `POST /api/bots/:id/enable` | 内存启用（404 未知 id） |
| `POST /api/bots/:id/disable` | 内存禁用 |

### 9.4 环境变量

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `OS_BOT_ENABLED` | 设为 `1` 时启动自动 `startScheduler` | 关（默认不调模型） |
| `OS_BOTS_FILE` | 花名册路径 | `~/.24os/bots.yaml` |

SIGINT / 关闭时 `stopScheduler()`，避免残留定时器与 gateway。

