# 24os-skill-ui/1 · Skill UI 宿主协议

> 本文定义 **功能性 Skill 的 UI 宿主协议**。Hermes 自身的 skill 只有 `SKILL.md`，
> 没有 UI；24H-OS 让 skill 自带前端，由宿主在**沙箱 iframe** 中加载，并通过
> **postMessage RPC 桥**按需注入能力（调模型 / 读写文件 / 跑工具）。

## 1. 目录布局

一个带 UI 的 skill 目录：

```
<skills-root>/<skillId>/
  SKILL.md
  ui/
    manifest.json
    index.html
    main.js
    styles.css
```

- `<skills-root>` 由宿主按优先级解析（见 §5）。
- `<skillId>` 是目录名；`ui/manifest.json` 里的 `id` 是协议 id，二者通常一致，
  宿主的静态路由与发现结果都以 `manifest.id` 为准。

## 2. manifest（`ui/manifest.json`，v1）

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

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `protocol` | 是 | 固定 `"24os-skill-ui/1"`；不匹配则跳过该 skill。 |
| `id` | 是 | UI 唯一 id；用于 `/skill-ui/:id` 与 RPC 路由。 |
| `title` | 是 | 展示标题。 |
| `entry` | 是 | 入口文件，相对 `ui/`，必须以 `.html` 结尾。 |
| `host` | 是 | 目前仅 `"iframe"`。 |
| `capabilities` | 是 | 允许 UI 调用的方法白名单，取值见 §4。 |
| `permissions` | 是 | 权限声明；broker 会对方法与权限做双重门禁。 |
| `size` | 否 | 宿主建议初始尺寸（`width`/`height`，px）。 |

## 3. 传输与握手（postMessage）

所有消息都是普通对象，且必须带 `__24os: true`（防串扰的协议标记）。

- **宿主 → UI（初始化）**：iframe 加载完成后，宿主发送

  ```json
  { "__24os": true, "type": "host.init",
    "payload": { "protocol": "24os-skill-ui/1", "capabilities": [...],
                 "permissions": [...], "sessionNonce": "<random>" } }
  ```

- **UI → 宿主（就绪）**：UI 收到 init 后可回

  ```json
  { "__24os": true, "type": "ui.ready" }
  ```

- **UI → 宿主（请求）**：

  ```json
  { "__24os": true, "id": "<req-id>", "method": "callModel", "params": { ... } }
  ```

- **宿主 → UI（响应）**：按 `id` 关联，`ok` 二选一带 `result` 或 `error`：

  ```json
  { "__24os": true, "id": "<req-id>", "ok": true, "result": { ... } }
  { "__24os": true, "id": "<req-id>", "ok": false,
    "error": { "code": "FORBIDDEN", "message": "..." } }
  ```

宿主侧校验：

1. `event.source === iframe.contentWindow`；
2. `data.__24os === true`；
3. `data.method` 必须在该 skill 的 `capabilities` 内，否则回 `FORBIDDEN`；
4. 超过超时未响应则返回 `TIMEOUT`。

## 4. 方法与权限

| method | 权限 | 行为（M4 原型） |
| --- | --- | --- |
| `callModel` | `model:call` | **桩实现**，返回 `{ text: "[stub] ..." }`，标 `TODO(M5)` 接 Hermes TUI gateway。 |
| `readFile` | `fs:read:workspace` | 读取工作区 `~/.24os/workspace/<skillId>/` 内文件，返回 `{ path, content }`。 |
| `writeFile` | `fs:write:workspace` | 写入工作区，返回 `{ path, bytes }`（必要时创建父目录）。 |
| `runTool` | `tool:<toolName>` | 白名单工具；M4 实现 `ppt.export`。 |
| `emitEvent` | — | no-op，返回 `{ ok: true }`。 |
| `resize` | — | 返回 `{ ok: true }`（宿主可据此调整容器尺寸）。 |

**双重门禁**：方法必须同时在 `capabilities` 与对应 `permissions` 中声明；
任一缺失，broker 返回 `403 FORBIDDEN`。

**工作区沙箱**：`readFile` / `writeFile` 的路径解析后必须落在
`~/.24os/workspace/<skillId>/`（可用 `OS_WORKSPACE_ROOT` 覆盖根目录）内，
否则返回 `403 PATH_OUTSIDE_WORKSPACE`。禁止目录穿越。

**`ppt.export`**：接收 `{ deck }`，用 `pptxgenjs` 写出
`<workspace>/deck.pptx`，返回 `{ tool, path }`。`deck` 结构：

```json
{
  "title": "演示标题",
  "themeColor": "4C8DFF",
  "slides": [
    { "title": "幻灯片标题", "subtitle": "副标题", "bullets": ["要点一", "要点二"] }
  ]
}
```

## 5. skills 根目录发现顺序

1. 环境变量 `OS_SKILL_ROOTS`（逗号分隔的绝对路径，优先）；
2. 仓库内 `examples/skills`（相对项目根，用于 demo）；
3. `~/.hermes/skills`；
4. `~/.hermes/profiles/*/skills`。

同名 `id` 以先出现的根为准。

## 6. 静态托管与 CSP

`GET /skill-ui/:id/*` 只服务该 skill `ui/` 目录内的文件：

- 解析后路径必须仍在 `uiRoot` 内（防 `../` 穿越）；
- 仅允许扩展名：`html` `js` `css` `json` `png` `svg` `woff2`；
- 响应头：

  ```
  Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'
  X-Content-Type-Options: nosniff
  ```

  `connect-src 'none'` 意味着 UI 的任何网络访问都被禁止——一切能力只能走 RPC。

## 7. HTTP 端点

| 端点 | 说明 |
| --- | --- |
| `GET /api/skill-uis` | 列出所有自带 UI 的 skill（`SkillUiInfo[]`）。 |
| `GET /api/skill-uis/:id` | 单个 UI 信息，未找到 404。 |
| `GET /skill-ui/:id/*` | 静态托管该 skill 的 `ui/` 文件。 |
| `POST /api/skill-host/invoke` | broker：`{ skillId, method, params }` → `{ ok, result?, error? }`。 |
