# Skill UI 宿主协议（24os-skill-ui/1 · 24os-skill-panel/1）

> 本文定义 **功能性 Skill 的 UI 宿主协议**。Hermes 自身的 skill 只有 `SKILL.md`，
> 没有 UI；24H-OS 让 skill 自带前端，由宿主按需注入能力。共两种形态，**并存**：
>
> - **命令式（`24os-skill-ui/1`）**：skill 自带 HTML/JS，宿主在**沙箱 iframe** 中加载，
>   通过 **postMessage RPC 桥**调用能力（调模型 / 读写文件 / 跑工具）；
> - **声明式（`24os-skill-panel/1`，M4.1）**：skill 只写 `ui/panel.yaml`，宿主渲染
>   表单 / 模板 / 预览，**零代码、无任意 JS**，更安全。

## 1. 目录布局

一个带 UI 的 skill 目录（两种形态二选一或并存）：

```
<skills-root>/<skillId>/
  SKILL.md
  ui/
    manifest.json        # 命令式（可选）
    index.html           # 命令式入口
    main.js
    styles.css
    panel.yaml           # 声明式（可选）
    templates/index.json # 声明式模板清单（可选）
```

- `<skills-root>` 由宿主按优先级解析（见 §6）。
- 命令式：`ui/manifest.json` 的 `id` 是协议 id；声明式：`ui/panel.yaml` 的 `skill` 是
  UI id。宿主的静态路由与发现结果均以对应 id 为准。
- 两者同时存在时**优先 `manifest.json`**（命令式）。发现的 `SkillUiInfo` 带
  `uiHost: "iframe" | "declarative"` 以区分。

## 2. manifest（`ui/manifest.json`，v1）

```json
{
  "protocol": "24os-skill-ui/1",
  "id": "ppt",
  "title": "PPT 工作台",
  "entry": "index.html",
  "host": "iframe",
  "capabilities": ["callModel", "chatStream", "readFile", "writeFile", "runTool", "emitEvent", "resize"],
  "permissions": ["fs:read:workspace", "fs:write:workspace", "model:call", "model:chat", "tool:ppt.export"],
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

- **宿主 → UI（流式事件，M5.2）**：`chatStream` 调用的中间事件以 `type:"event"` 主动下发，
  `event` 为 `chat.delta` | `chat.done` | `chat.error` | `chat.tool` | `chat.request` | `chat.event`，
  `payload` 为归一化 `ChatStreamEvent`：

  ```json
  { "__24os": true, "type": "event", "event": "chat.delta",
    "payload": { "type": "delta", "text": "增量文本", "sessionId": "..." } }
  ```

  流结束后宿主再向原请求 `id` 回一个汇总响应 `{ ok: true, result: { status } }`。

宿主侧校验：

1. `event.source === iframe.contentWindow`；
2. `data.__24os === true`；
3. `data.method` 必须在该 skill 的 `capabilities` 内，否则回 `FORBIDDEN`；
4. 超过超时未响应则返回 `TIMEOUT`。

## 4. 方法与权限

| method | 权限 | 行为 |
| --- | --- | --- |
| `callModel` | `model:call` | 走 `completePrompt` 降级链（gateway → `hermes -z` → stub），返回 `{ text, via, stub }`。 |
| `chatStream` | `model:chat` | 走 gateway 会话流式（`POST /api/hermes/chat/stream`）；REST broker 会收集为 `{ text, status, events }`，SkillHost 则把 SSE 事件经 `type:"event"` 转发给 iframe。 |
| `readFile` | `fs:read:workspace` | 读取工作区 `~/.24os/workspace/<skillId>/` 内文件，返回 `{ path, content }`。 |
| `writeFile` | `fs:write:workspace` | 写入工作区，返回 `{ path, bytes }`（必要时创建父目录）。 |
| `runTool` | `tool:<toolName>` | 白名单工具；M4 实现 `ppt.export`。 |
| `emitEvent` | — | no-op，返回 `{ ok: true }`。 |
| `resize` | — | 返回 `{ ok: true }`（宿主可据此调整容器尺寸）。 |

**`chatStream` 审批策略（安全默认）**：gateway 的 `approval` / `clarify` 服务端请求默认回
`deny` / 空答案（跳过）；仅当环境变量 `OS_GATEWAY_AUTO_APPROVE=1` 时回 `once` / 第一个选项。
无论决策如何，该事件都会先透出给 UI。

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

## 5. 声明式面板（`24os-skill-panel/1`，M4.1）

skill 作者只写 `ui/panel.yaml`，宿主（`web/components/DeclarativePanel.tsx`）自动渲染
表单 / 模板画廊 / 预览 / 动作按钮，**不执行任何 skill 自带的 JS**。

### 5.1 panel.yaml（v1）

```yaml
protocol: 24os-skill-panel/1
skill: outline          # UI id（也用作 /skill-ui/:id 与 /api/skill-uis/:id）
title: 大纲生成
view: form              # form | wizard（wizard 当前按 form 渲染）
description: 选主题、定深度，一键生成大纲
fields:
  - key: topic          # 插值占位符名，匹配 [A-Za-z_][A-Za-z0-9_]*
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
    options_from: templates/index.json   # 或静态 options: [{ value, label }]
templates:              # 可选：模板目录 + 清单（画廊）
  dir: templates/
  index: templates/index.json
preview:                # 可选：iframe | markdown | none；非 none 需 source
  kind: iframe
  source: templates/preview.html
actions:
  - id: run
    label: 生成大纲
    kind: prompt        # 目前仅 prompt
    prompt: |           # {{field_key}} 占位符
      请以「{{topic}}」为主题，生成 {{depth}} 级深度的结构化大纲。
```

### 5.2 校验规则

| 规则 | 说明 |
| --- | --- |
| `protocol` | 必须为 `24os-skill-panel/1`，否则跳过该 skill。 |
| `skill` / `title` | 必填非空。 |
| `view` | ∈ {`form`, `wizard`}，缺省 `form`。 |
| `fields[].key` | 唯一，匹配 `[A-Za-z_][A-Za-z0-9_]*`（便于 `{{key}}` 插值）。 |
| `fields[].type` | ∈ {`text`, `textarea`, `select`, `slider`, `file`}。 |
| `select` | 必须提供非空 `options` 或 `options_from`。 |
| `slider` | `min`/`max`/`step` 为数字，且 `min ≤ max`。 |
| `preview` | `kind` ∈ {`iframe`, `markdown`, `none`}；非 `none` 需 `source`。 |
| `actions[].kind` | 恒为 `prompt`；`id` 唯一；`prompt` 必填非空。 |

校验为**手写**（不引入 zod）。非法 panel.yml 在发现阶段视为“无声明式 UI”；
`server/skillui/panel.ts#validatePanel` 另外返回带原因的失败（供路由/日志）。

### 5.3 前端行为（DeclarativePanel）

- 按 `fields` 渲染 `text` / `textarea` / `select` / `slider` / `file`（`file` 仅本地读取为
  文本或 base64 data URL，**不上传**）；
- `select.options_from` 与 `templates.index` 通过 `/skill-ui/:id/<相对路径>` 只读拉取 JSON；
- `templates/index.json` 渲染缩略图画廊，点击可选中同名 select 选项；
- `preview`（iframe / markdown）以同源沙箱 iframe 预览；
- 动作按钮把 `prompt` 用 `{{key}}` 插值（缺失键默认替换为空串；另有 keep / error 策略），
  经 `POST /api/hermes/chat/stream`（SSE）流式展示 delta / 工具 / 审批 / 完成 / 错误，支持中断；
- 运行前校验 `required` 字段，缺失则明确提示。

## 6. skills 根目录发现顺序

1. 环境变量 `OS_SKILL_ROOTS`（逗号分隔的绝对路径，优先）；
2. 仓库内 `examples/skills`（相对项目根，用于 demo）；
3. `<activeHome>/skills`；
4. `<activeHome>/profiles/*/skills`。

`<activeHome>` 由 `server/hermes/detect.ts` 解析（`OS_HERMES_HOME` / `HERMES_HOME` → CLI 包装脚本
声明的 home → 默认探测），保证 skill 来源与 agent 一致（M5.0b 起不再硬编码 `~/.hermes`）。
同名 `id` 以先出现的根为准。

## 7. 静态托管与 CSP

`GET /skill-ui/:id/*` 只服务该 skill `ui/` 目录内的文件（命令式与声明式共用）：

- 解析后路径必须仍在 `uiRoot` 内（防 `../` 穿越）；
- 仅允许扩展名：`html` `js` `css` `json` `png` `svg` `woff2` `yaml` `yml` `md`
  （后三者为 M4.1 声明式面板新增：`panel.yaml`、模板清单、预览）；
- 响应头：

  ```
  Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'
  X-Content-Type-Options: nosniff
  ```

  `connect-src 'none'` 意味着 UI 的任何网络访问都被禁止——一切能力只能走 RPC。

## 8. HTTP 端点

| 端点 | 说明 |
| --- | --- |
| `GET /api/skill-uis` | 列出所有自带 UI 的 skill（`SkillUiInfo[]`，含 `uiHost`）。 |
| `GET /api/skill-uis/:id` | 单个 UI 信息，未找到 404。 |
| `GET /api/skill-uis/:id/panel` | 声明式面板规范 `PanelSpec`；非声明式 / 未找到 → 404 `PANEL_NOT_FOUND`。 |
| `GET /skill-ui/:id/*` | 静态托管该 skill 的 `ui/` 文件。 |
| `POST /api/skill-host/invoke` | broker：`{ skillId, method, params }` → `{ ok, result?, error? }`。 |
| `POST /api/hermes/chat/stream` | gateway 流式对话（SSE）：body `{ profile?, prompt }`，逐条 `data: <ChatStreamEvent>`；审批默认 deny（`OS_GATEWAY_AUTO_APPROVE=1` 时 allow）。 |
