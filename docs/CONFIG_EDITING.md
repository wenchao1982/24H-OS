# Agent 配置编辑（M3）

本文描述 24H-OS 如何把用户在工作台里对 agent 的修改**安全落盘**到 Hermes profile。
实现位于 [`server/hermes/configEdit.ts`](../server/hermes/configEdit.ts)，路由位于
[`server/routes/agents.ts`](../server/routes/agents.ts)，前端位于
[`web/components/AgentConfigEditor.tsx`](../web/components/AgentConfigEditor.tsx)。

## 1. 配置项与落盘位置

| 配置 | 来源 / 目标文件 | 说明 |
| --- | --- | --- |
| 模型 `model` | `<profile>/config.yaml` 顶层 `model` | 读取兼容 `model`（字符串）或 `model.default`；写入时若原值是 mapping 则只改 `model.default`，保留 `provider` 等其它子字段。 |
| 功能描述 `description` | `~/.24os/agents/<id>/meta.json` | **工作台自有元数据**，与 Hermes 隔离，避免猜测其内部字段。 |
| 标签 `tags` | `~/.24os/agents/<id>/meta.json` | 字符串数组。 |
| MCP servers | `<profile>/config.yaml` 顶层 `mcp_servers` | map：`<name> -> spec`。stdio 用 `command`/`args`，http 用 `url`/`headers`。 |
| 环境变量 | `<profile>/.env` | 只返回**键名**，绝不返回值。 |

> 一个 Hermes profile = 一个 agent：目录为 `~/.hermes/profiles/<id>`，默认 profile 为
> `~/.hermes` 本身（id = `default`）。

## 2. 安全设计（写操作四重保证）

### 2.1 confirm

所有写函数都要求 `{ confirm: true }`。未确认时抛 `CONFIRM_REQUIRED`（HTTP 400），
**在任何磁盘操作之前**返回，绝不产生副作用。

### 2.2 备份

写前把目标文件复制到 `~/.24os/backups/<id>/<filename>.<ISO时间戳>.bak`
（例如 `config.yaml.2026-09-24T02-50-02-351Z.bak`）。同一目录内按 basename 分组，
每个文件最多保留 `MAX_BACKUPS = 10` 份，超出删除最旧的。新文件（目标不存在）无需备份。

### 2.3 原子写

`atomicWrite()` 先在同目录写临时文件（`<file>.tmp-<pid>-<time>-<rand>`），再 `rename`
覆盖目标。`rename` 在同一文件系统上是原子的，避免写入中途失败留下半截文件。
YAML 使用 `yaml` 库的 **Document API**（`parseDocument` + `set/setIn/deleteIn`），
保留注释、字段顺序与其它字段。

### 2.4 密钥不回显

- `readAgentConfig().envKeys` 只含 `.env` 的键名；
- env 相关 `ConfigEditResult.message` 不含明文值；
- 若走 `hermes config set <KEY> <VALUE>`，命令字符串（含值）不会出现在响应或日志中；
  CLI 失败时静默回退到直接编辑 `.env`，不抛出可能带值的错误消息。

## 3. 路径安全

- `id` 必须匹配 `^[a-z0-9][a-z0-9_-]{0,63}$`，否则 `INVALID_NAME`；
- 解析后的 agent 目录必须位于 `~/.hermes/profiles/` 之下，或（仅 `id = default`）
  等于 `~/.hermes`，否则拒绝；解析时再次做 `path.relative` 越界检查；
- 备份文件名禁止 `/`、`\`、`..`，且必须位于 `~/.24os/backups/<id>/` 内；
- MCP server 名匹配 `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$`；
- 环境变量名匹配 `^[A-Z][A-Z0-9_]*$`，值禁止换行 / NUL。

## 4. 错误码

| 错误码 | HTTP | 触发条件 |
| --- | --- | --- |
| `CONFIRM_REQUIRED` | 400 | 写操作未带 `confirm:true`。 |
| `INVALID_NAME` | 400 | id 不合法。 |
| `INVALID_KEY` | 400 | 环境变量名不合法。 |
| `INVALID_VALUE` | 400 | 值为空 / 类型错误 / 含换行。 |
| `INVALID_MCP_SERVER` | 400 | MCP 名或 spec 不合法（既无 command 也无 url、args/headers 类型错误等）。 |
| `MCP_SERVER_EXISTS` | 409 | add 时同名已存在。 |
| `MCP_SERVER_NOT_FOUND` | 404 | update/remove 时不存在。 |
| `CONFIG_PARSE_FAILED` | 400 | `config.yaml` 非法 YAML，放弃写入。 |
| `PATH_TRAVERSAL` | 400 | 路径 / 备份名穿越。 |
| `BACKUP_NOT_FOUND` | 404 | restore 时备份不存在。 |
| `AGENT_NOT_FOUND` | 404 | 找不到 profile 目录。 |

## 5. API

| 方法 & 路径 | body | 返回 |
| --- | --- | --- |
| `GET /api/agents/:id/config` | — | `AgentConfig` |
| `PATCH /api/agents/:id/config` | `{ model?, description?, tags?, confirm? }` | `ConfigEditResult` |
| `POST /api/agents/:id/mcp` | `{ name, spec, confirm? }` | `ConfigEditResult` |
| `PATCH /api/agents/:id/mcp/:name` | `{ spec, confirm? }` | `ConfigEditResult` |
| `DELETE /api/agents/:id/mcp/:name` | `{ confirm? }` | `ConfigEditResult` |
| `POST /api/agents/:id/env` | `{ key, value, confirm? }` | `ConfigEditResult` |
| `DELETE /api/agents/:id/env/:key` | `{ confirm? }` | `ConfigEditResult` |
| `POST /api/agents/:id/config/restore` | `{ backupFileName, confirm? }` | `ConfigEditResult` |

`McpServerSpec`：

```ts
// stdio
{ command: "npx", args: ["-y", "@scope/server"] }
// http
{ url: "https://example.com/mcp", headers: { Authorization: "Bearer ..." } }
```

## 6. 前端交互

`AgentConfigEditor` 的每个保存动作都遵循：**编辑表单 → 点保存 → Modal 展示将写入的
文件与内容摘要 → 用户确认 → 调 API（confirm:true）→ 显示结果 / 错误码 → 刷新详情**。
环境变量值使用 `type=password` 输入，列表中的值以 `••••••` 掩码展示。

## 7. 测试

- `server/hermes/configEdit.test.ts`：配置读写、注释保留、错误码、备份裁剪、路径安全；
- `server/routes/agentsConfig.test.ts`：路由层 confirm / 成功写入 / env 不回显。

所有测试通过 deps 注入或环境变量指向**临时目录**（`hermesHome` / `backupDir` / `metaDir`），
绝不写真实 `~/.hermes`。

## 8. 回滚

`restoreBackup(id, backupFileName, { confirm })` 可从 `~/.24os/backups/<id>/` 恢复备份：
从备份名 `<file>.<ISO>.bak` 推断原始文件名（限定在白名单 `.env` / `config.yaml` /
`config.yml` / `config.json` / `meta.json`），还原前对当前文件再备份一次。
该能力目前通过 API 暴露，前端暂未提供入口。
