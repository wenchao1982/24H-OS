/**
 * 24H-OS 前后端共享类型定义。
 * 前端通过 vite alias `@shared/types` 引用，后端通过 tsconfig paths 引用。
 * 所有 REST API 的返回结构都应从这里导出，保证前后端类型一致。
 */

/** Agent 数据来源：真实 Hermes profile，或降级用的 mock 数据。 */
export type AgentSource = "profiles" | "mock";

/** Hermes 运行模式：live = 读取真实 ~/.hermes，mock = 使用内置示例数据。 */
export type HermesMode = "live" | "mock";

/** hermes CLI 可执行文件的来源（按探测优先级）。 */
export type HermesCliSource = "env" | "path" | "local-bin" | "hermes-bin";

/** 模型配置（预留给未来的模型切换/编辑 UI）。 */
export interface ModelConfig {
  /** 默认模型名，例如 "deepseek-flash"。 */
  defaultModel: string;
  /** 提供商，例如 "deepseek"。 */
  provider?: string;
  /** API base url。 */
  baseUrl?: string;
}

/** Skill 元信息（M1 仅只读展示，M4 起是 Skill UI 宿主的载体）。 */
export interface Skill {
  id: string;
  name: string;
  description?: string;
  path?: string;
  enabled?: boolean;
  /** 该 skill 是否自带可托管的 UI（存在 ui/manifest.json 或 ui/panel.yaml）。 */
  hasUi?: boolean;
  /** 若有 UI，其协议 id（manifest.id 或 panel.skill）。 */
  uiId?: string;
}

/* ------------------------------------------------------------------ *
 * M4 · Skill UI 宿主协议（24os-skill-ui/1）
 * ------------------------------------------------------------------ */

/**
 * 一个功能性 skill 通过 `ui/manifest.json` 声明自己的 UI。
 * 宿主据此决定沙箱策略、可注入的能力与权限。
 */
export interface SkillUiManifest {
  /** 协议标识，当前固定 "24os-skill-ui/1"。 */
  protocol: string;
  /** UI 唯一 id（也用作 /skill-ui/:id 与 RPC 路由键）。 */
  id: string;
  /** 展示标题。 */
  title: string;
  /** 入口文件（相对 ui/ 目录，必须为 html）。 */
  entry: string;
  /** 宿主形式，当前仅支持 "iframe"。 */
  host: "iframe";
  /** 声明需要的 RPC 方法白名单。 */
  capabilities: SkillUiCapability[];
  /** 声明需要的权限字符串（供 broker 二次门禁与审计）。 */
  permissions: string[];
  /** 建议的宿主初始尺寸。 */
  size?: { width: number; height: number };
}

/** 可注入的 RPC 方法名（同时也是 capability 名）。 */
export type SkillUiCapability =
  | "callModel"
  | "chatStream"
  | "readFile"
  | "writeFile"
  | "runTool"
  | "emitEvent"
  | "resize";

/** 所有合法的 capability（用于运行时校验 manifest）。 */
export const SKILL_UI_CAPABILITIES: readonly SkillUiCapability[] = [
  "callModel",
  "chatStream",
  "readFile",
  "writeFile",
  "runTool",
  "emitEvent",
  "resize",
];

/* ------------------------------------------------------------------ *
 * M4.1 · 声明式 Skill UI（24os-skill-panel/1）
 * ------------------------------------------------------------------ */

/** 声明式面板协议标识。 */
export const PANEL_PROTOCOL = "24os-skill-panel/1";

/** 面板视图：form（先实现）；wizard 暂按 form 降级渲染。 */
export type PanelView = "form" | "wizard";

/** 支持的表单字段类型。 */
export type PanelFieldType = "text" | "textarea" | "select" | "slider" | "file";

/** 所有合法的字段类型（用于运行时校验 panel.yaml）。 */
export const PANEL_FIELD_TYPES: readonly PanelFieldType[] = [
  "text",
  "textarea",
  "select",
  "slider",
  "file",
];

/** select 的一个选项（options 可为字符串数组或对象数组）。 */
export interface PanelOption {
  value: string;
  label?: string;
}

/** 一个表单字段声明。 */
export interface PanelField {
  key: string;
  label: string;
  type: PanelFieldType;
  required?: boolean;
  placeholder?: string;
  /** 默认值（slider 为数字，其余为字符串）。 */
  default?: string | number;
  /** slider：最小值 / 最大值 / 步长。 */
  min?: number;
  max?: number;
  step?: number;
  /** select：静态选项。 */
  options?: PanelOption[];
  /** select：动态枚举（相对 ui/ 目录的 JSON 路径，如 templates/index.json）。 */
  options_from?: string;
}

/** 模板目录声明（可选）。 */
export interface PanelTemplates {
  /** 模板目录（相对 ui/）。 */
  dir?: string;
  /** 模板清单 JSON（相对 ui/）。 */
  index?: string;
}

/** 预览区类型：iframe | markdown | none。 */
export type PanelPreviewKind = "iframe" | "markdown" | "none";

/** 预览区声明。 */
export interface PanelPreview {
  kind: PanelPreviewKind;
  /** 预览源（相对 ui/ 的路径；iframe / markdown 必填）。 */
  source?: string;
}

/** 一个动作按钮：kind 目前仅 "prompt"（把插值后的 prompt 发给 chat/stream）。 */
export interface PanelAction {
  id: string;
  label: string;
  kind: "prompt";
  /** 含 {{field_key}} 占位符的提示词模板。 */
  prompt: string;
}

/** `ui/panel.yaml` 解析后的声明式面板规范。 */
export interface PanelSpec {
  protocol: string;
  /** UI 唯一 id（也用作 /skill-ui/:id 与 /api/skill-uis/:id）。 */
  skill: string;
  title: string;
  view: PanelView;
  description?: string;
  fields: PanelField[];
  templates?: PanelTemplates;
  preview?: PanelPreview;
  actions: PanelAction[];
}

/** Skill UI 的宿主形式：命令式 iframe 或声明式面板。 */
export type SkillUiHostKind = "iframe" | "declarative";

/** GET /api/skill-uis 的单项：已发现的、自带 UI 的 skill。 */
export interface SkillUiInfo {
  /** manifest.id（iframe）或 panel.skill（declarative）。 */
  id: string;
  /** manifest.title 或 panel.title。 */
  title: string;
  /** skill 根目录（含 SKILL.md 的那层）。 */
  skillPath: string;
  /** ui/ 目录的绝对路径（静态托管的根）。 */
  uiRoot: string;
  /** 宿主形式：`iframe`（ui/manifest.json）或 `declarative`（ui/panel.yaml）。 */
  uiHost: SkillUiHostKind;
  /** 命令式（iframe）UI 的解析后 manifest；声明式时为 undefined。 */
  manifest?: SkillUiManifest;
  /** 声明式 UI 的解析后面板；命令式时为 undefined。 */
  panel?: PanelSpec;
  /** 恒为 true，便于前端统一过滤（类型上与 Agent.skills[].hasUi 呼应）。 */
  hasUi: boolean;
  /** 该 skill 是否被任一 agent 的 meta.json 标记为 enabled:false（前端不渲染打开入口）。 */
  disabled?: boolean;
}

/** 宿主 → iframe 的握手消息 payload。 */
export interface SkillUiHostInit {
  protocol: string;
  capabilities: SkillUiCapability[];
  permissions: string[];
  /** 每次挂载生成的随机串，UI 可回显以确认握手来自真实宿主。 */
  sessionNonce: string;
}

/** iframe → 宿主：RPC 请求。 */
export interface SkillUiRpcRequest {
  __24os: true;
  /** 请求 id，宿主按 id 关联响应。 */
  id: string;
  /** 必须是 skill 声明的 capability 之一。 */
  method: SkillUiCapability;
  params?: unknown;
}

/** 宿主 → iframe：RPC 响应。 */
export interface SkillUiRpcResponse {
  __24os: true;
  id: string;
  ok: boolean;
  result?: unknown;
  error?: SkillUiError;
}

/** 宿主 → iframe：握手初始化（iframe 加载后由宿主发送）。 */
export interface SkillUiHostInitMessage {
  __24os: true;
  type: "host.init";
  payload: SkillUiHostInit;
}

/** iframe → 宿主：UI 就绪。 */
export interface SkillUiReadyMessage {
  __24os: true;
  type: "ui.ready";
}

/**
 * 宿主 → iframe：流式事件（M5.2，用于 `chatStream`）。
 * `event` 取值：`chat.delta` | `chat.done` | `chat.error` | `chat.tool` | `chat.request` | `chat.event`。
 */
export interface SkillUiEventMessage {
  __24os: true;
  type: "event";
  event: string;
  payload: unknown;
}

/** RPC / broker 统一错误结构。 */
export interface SkillUiError {
  code: string;
  message: string;
}

/** POST /api/skill-host/invoke 请求体。 */
export interface SkillHostInvokeRequest {
  skillId: string;
  method: SkillUiCapability;
  params?: unknown;
}

/** POST /api/skill-host/invoke 响应体。 */
export interface SkillHostInvokeResponse {
  ok: boolean;
  result?: unknown;
  error?: SkillUiError;
}

/** readFile 的结果。 */
export interface SkillFileReadResult {
  path: string;
  content: string;
}

/** writeFile 的结果。 */
export interface SkillFileWriteResult {
  path: string;
  bytes: number;
}

/** runTool 的结果（不同工具字段不同，path 为常见字段）。 */
export interface SkillRunToolResult {
  tool: string;
  path?: string;
  [key: string]: unknown;
}

/** MCP server 元信息（M1 仅只读展示，未来是 MCP 网关的载体）。 */
export interface McpServer {
  id: string;
  name: string;
  command?: string;
  args?: string[];
  /** http 型 MCP server 的地址。 */
  url?: string;
  /** http 型 MCP server 的请求头。 */
  headers?: Record<string, string>;
  /** 传输方式：stdio（command/args）或 http（url/headers）。 */
  transport?: "stdio" | "http";
  enabled?: boolean;
}

/** 一个 Hermes profile = 一个 agent。 */
export interface Agent {
  /** profile 名，作为唯一 id。 */
  id: string;
  name: string;
  description: string;
  /** 默认模型名。 */
  model: string;
  /** 已启用/可用的 skill 结构化列表。 */
  skills: Skill[];
  /** 已配置的 MCP server 结构化列表。 */
  mcpServers: McpServer[];
  /** profile 所在目录（真实路径或 mock 标记路径）。 */
  path: string;
  source: AgentSource;
  /** 工作台 meta.json 的标签（有 meta 记录时合并进列表/详情；无 meta 时缺省）。 */
  tags?: string[];
}

/** Hermes 探测/运行状态，用于前端顶部状态条。 */
export interface HermesStatus {
  /** 是否检测到可用的 Hermes（安装或 ~/.hermes 存在）。 */
  available: boolean;
  mode: HermesMode;
  /** CLI 版本号，未检测到为 null。 */
  version: string | null;
  /** hermes 可执行文件路径，未检测到为 null。 */
  cliPath: string | null;
  /** CLI 来源：env | path | local-bin | hermes-bin；未检测到为 null。 */
  cliSource: HermesCliSource | null;
  /** ~/.hermes 目录，未检测到为 null。 */
  homePath: string | null;
  /** 实际生效的 Hermes 主目录（HERMES_HOME/OS_HERMES_HOME 或默认 ~/.hermes）。 */
  activeHome: string | null;
  /** 探测到的所有有效 Hermes 主目录（含 ~/.hermes、~/hermes-desktop/home 等）。 */
  hermesHomes: string[];
  /** 当前可用（真实）profile 数量。 */
  profileCount: number;
  /** 面向用户的中文说明字符串。 */
  message: string;
}

/** 模型调用最终实际走的通道。 */
export type CompleteVia = "gateway" | "oneshot" | "stub";

/** GET /api/hermes/gateway 的返回结构（TUI gateway 运行状态）。 */
export interface GatewayStatus {
  /** 是否已由工作台拉起 gateway 进程。 */
  running: boolean;
  /** gateway 监听端口；未运行为 null。 */
  port: number | null;
  /** 是否已建立 WS 连接。 */
  connected: boolean;
  /** 使用的 hermes CLI 路径。 */
  cliPath: string | null;
  /** 最近一次 completePrompt 实际走的通道。 */
  via: CompleteVia | null;
  /** 最近一次 gateway 错误（用于调试面板）。 */
  lastError: string | null;
  /** 面向用户的中文说明。 */
  message: string;
}

/** GET /api/agents 的返回结构。 */
export interface AgentsResponse {
  agents: Agent[];
  status: HermesStatus;
}

/* ------------------------------------------------------------------ *
 * M5.2 · Gateway 会话与流式（chat stream）
 * ------------------------------------------------------------------ */

/** 归一化后的 chat 流式事件类型。 */
export type ChatStreamEventType =
  | "session"
  | "delta"
  | "message"
  | "thinking"
  | "tool.start"
  | "tool.complete"
  | "subagent"
  | "approval"
  | "clarify"
  | "done"
  | "error"
  | "raw";

/**
 * gateway chat 流的归一化事件，也是 SSE 的 `data:` 负载。
 * 未知的 gateway 事件/服务端请求以 `{ type: "raw", raw }` 原样透出。
 */
export interface ChatStreamEvent {
  type: ChatStreamEventType;
  /** 所属会话 id（gateway 提供时）。 */
  sessionId?: string;
  /** delta / thinking / message / done：文本增量或最终文本。 */
  text?: string;
  /** message.interim：工具调用旁的旁白标记。 */
  interim?: boolean;
  /** tool.start / tool.complete。 */
  toolId?: string;
  name?: string;
  args?: unknown;
  summary?: string;
  result?: unknown;
  /** error：错误信息与可选错误码。 */
  message?: string;
  reason?: string;
  /** session：原始 gateway 事件名与 payload。 */
  event?: string;
  payload?: unknown;
  /** approval / clarify：服务端请求 id 与展示信息。 */
  requestId?: string;
  /** approval / clarify：内部请求 id（与 requestId 相同），decide 时按 chatId+type 定位。 */
  id?: string;
  command?: string;
  description?: string;
  choices?: string[];
  question?: string;
  /** approval：展示文案（description||command）；clarify：问题（question 别名）。 */
  prompt?: string;
  /** 所属 chat 流 id（decideApproval 的定位键）。 */
  chatId?: string;
  /** 审批/澄清已被自动处理（autoApprove 或非交互流的安全默认），UI 无需渲染按钮。 */
  autoDecided?: boolean;
  /** done：turn 状态（complete / error / interrupted）与 usage。 */
  status?: string;
  usage?: unknown;
  /******************************************************************
   * subagent（M5 观测/控制 → 事件透出）：由会话内 `delegate_task` 工具
   * 产生的 `subagent.*` gateway 事件归一化而来（phase 见下）。
   ******************************************************************/
  /**
   * subagent：阶段。
   * 官方事件 `subagent.spawn_requested/start/progress/thinking/tool/complete`
   * 依次映射为同名 phase；无法识别时保守置为 `"unknown"`（原始 type 仍在 event 字段）。
   */
  phase?:
    | "spawn_requested"
    | "start"
    | "progress"
    | "thinking"
    | "tool"
    | "complete"
    | "unknown";
  /** subagent：子代理 id。 */
  subagentId?: string;
  /** subagent：父（发起方）id。 */
  parentId?: string;
  /** subagent：子会话 id。 */
  childSessionId?: string;
  /** subagent：子代理目标。 */
  goal?: string;
  /** subagent：progress/tool 阶段涉及的工具名。 */
  toolName?: string;
  /** raw：原始帧。 */
  raw?: unknown;
}

/** POST /api/hermes/chat/stream 请求体（SSE）。 */
export interface ChatStreamRequest {
  profile?: string;
  prompt: string;
  /** 客户端生成的 chat 流 id（可选；缺省由服务端生成并随事件回传）。 */
  chatId?: string;
  /** 会话模型（session.create 的 model 参数；后续 prompt 生效于该新会话）。 */
  model?: string;
  /**
   * 昂贵模型二次确认放行（force → gateway `config.set` 的 `confirm_expensive_model`）。
   * 收到 `session/model.confirm_required` 事件后，前端 Modal 确认并以 force:true 重试。
   */
  force?: boolean;
}

/* ------------------------------------------------------------------ *
 * M5 · 交互式审批 / clarify 决策（chat/decide）
 * ------------------------------------------------------------------ */

/** 可决策的服务端请求类型。 */
export type ChatDecisionType = "approval" | "clarify";

/** 标准 approval 选项（契约 ApprovalChoice）。 */
export type ApprovalChoiceValue = "once" | "session" | "always" | "deny";

/** POST /api/hermes/chat/decide 请求体。 */
export interface ChatDecideRequest {
  chatId: string;
  type: ChatDecisionType;
  /** approval：once | session | always | deny（或 gateway 透传的 choices 之一）。 */
  choice?: string;
  /** clarify：答案（空串 = 跳过）。 */
  answer?: string;
}

/** POST /api/hermes/chat/decide 成功响应。 */
export interface ChatDecideResult {
  ok: true;
  chatId: string;
  /** 被回应的 gateway 服务端请求 id。 */
  requestId: string;
  type: ChatDecisionType;
  /** 实际回传 gateway 的 result（{choice} 或 {answer}）。 */
  decision: Record<string, unknown>;
}

/* ------------------------------------------------------------------ *
 * M5/M10 · subagent（观测/控制 + 事件；创建走会话内 delegate_task）
 * ------------------------------------------------------------------ */

/**
 * subagent 能力说明（研究结论）。
 *
 * gateway v0.21.3 现状：**没有直接 spawn/run 的 RPC**；子代理由父会话内 LLM
 * 调用 `delegate_task` 工具在同一进程内创建（`delegation.max_spawn_depth` 默认 1）。
 * 可用的 RPC 只有观测/控制：`subagent.list/tail/interrupt/steer`、
 * `delegation.status/pause`、`spawn_tree.*`；`subagent.*` 事件由会话内工具发出，
 * 经 chat 流透出。
 */
export interface SubagentSupportInfo {
  /** 是否存在直接 spawn/run subagent 的 gateway RPC（当前 false）。 */
  spawnApi: boolean;
  /** 是否存在 subagent 观测/控制 RPC（list/tail/interrupt/steer/delegation.*）（true）。 */
  controlApi: boolean;
  /** 是否存在 subagent.* 事件（true）。 */
  events: boolean;
  /** 子代理创建机制说明：`delegate_task (in-session tool)`。 */
  mechanism: string;
  /** 研究依据的 gateway 契约版本。 */
  contractGateway: string;
  /** 已确认存在的观测/控制方法名。 */
  methods: string[];
  /** 已确认存在的 subagent.* 事件名。 */
  eventNames: string[];
  /** 中文结论说明。 */
  note: string;
}

/** 一个活跃子代理的快照（对齐官方 `SubagentSnapshot`）。 */
export interface SubagentInfo {
  subagent_id: string;
  parent_id?: string | null;
  depth?: number | null;
  goal?: string | null;
  delegation_id?: string | null;
  model?: string | null;
  started_at?: number | null;
  status?: string | null;
  tool_count?: number | null;
  last_tool?: string | null;
  accepting_steer?: boolean | null;
}

/** GET /api/hermes/subagents 响应。 */
export interface SubagentsResponse {
  subagents: SubagentInfo[];
  count: number;
  /** 查询所用会话 id；未提供时为 null（此时按 0 条返回，见 message）。 */
  sessionId: string | null;
  support: SubagentSupportInfo;
  message: string;
}

/** GET /api/hermes/subagents/:id/tail 响应（官方 `subagent.tail`）。 */
export interface SubagentTailResult {
  subagent_id: string;
  available: boolean;
  text: string;
  truncated: boolean;
}

/** POST /api/hermes/subagents/:id/interrupt 响应（控制面，须 confirm:true）。 */
export interface SubagentInterruptResult {
  ok: boolean;
  found: boolean;
  subagent_id: string;
  message: string;
}

/** POST /api/hermes/subagents/:id/steer 响应（非破坏，不需 confirm）。 */
export interface SubagentSteerResult {
  ok: boolean;
  /** queued | rejected（官方语义）。 */
  status: string;
  subagent_id: string;
  text: string;
  message: string;
}

/** POST /api/hermes/subagents/pause 请求体（全局暂停 spawn，控制面须 confirm:true）。 */
export interface SubagentPauseRequest {
  /** 缺省 true。 */
  paused?: boolean;
  confirm?: boolean;
}

/** POST /api/hermes/subagents/pause 响应。 */
export interface SubagentPauseResult {
  ok: boolean;
  paused: boolean;
  message: string;
}

/** POST /api/hermes/subagent 请求体（保留：本端点不提供 spawn）。 */
export interface SubagentRunRequest {
  profile?: string;
  prompt: string;
  confirm?: boolean;
}

/**
 * POST /api/hermes/subagent 响应体。
 * `spawnApi:false` → 语义为「无 spawn API，子代理由会话内 delegate_task 触发」。
 */
export interface SubagentRunResult {
  ok: boolean;
  spawnApi: boolean;
  code: string;
  message: string;
  contract: SubagentSupportInfo;
}

/* ------------------------------------------------------------------ *
 * M2-core · Agent 生命周期（install / update / delete / backup）
 * ------------------------------------------------------------------ */

/** 生命周期动作。 */
export type LifecycleAction = "install" | "update" | "delete" | "backup";

/**
 * 生命周期操作的统一返回结构。
 * 由 server/hermes/lifecycle.ts 产出，经 routes/agents.ts 原样返回给前端。
 */
export interface LifecycleResult {
  ok: boolean;
  action: LifecycleAction;
  /** 将执行 / 已执行的命令（人类可读，已做引号转义）。 */
  command: string;
  stdout: string;
  stderr: string;
  /** 进程退出码；dryRun 或未执行时为 null。 */
  code: number | null;
  /** delete 时先备份产生的 tar.gz 路径。 */
  backupPath?: string;
  /** 是否为 dryRun（未真正执行）。 */
  dryRun?: boolean;
}

/** POST /api/agents（安装）请求体。 */
export interface InstallAgentRequest {
  /** git URL（http(s)/git@）或已存在的本地目录。 */
  source: string;
  /** 可选的目标 profile 名（不合法则报 INVALID_NAME）。 */
  name?: string;
  /** 是否创建别名（透传 --alias）。 */
  alias?: boolean;
  /** 危险操作必须显式 true，否则返回 CONFIRM_REQUIRED。 */
  confirm?: boolean;
  /** 只返回将执行的命令，不真正执行。 */
  dryRun?: boolean;
}

/** POST /api/agents/:id/update 请求体。 */
export interface UpdateAgentRequest {
  confirm?: boolean;
  dryRun?: boolean;
}

/** DELETE /api/agents/:id 请求体。 */
export interface DeleteAgentRequest {
  confirm?: boolean;
  /** 删除前是否导出备份，默认 true。 */
  backup?: boolean;
  dryRun?: boolean;
}

/* ------------------------------------------------------------------ *
 * M2-core · 小市场（静态 distribution 列表）
 * ------------------------------------------------------------------ */

/** 市场里的一个可安装 distribution（静态 stub）。 */
export interface MarketEntry {
  id: string;
  name: string;
  description: string;
  /** 传给 installAgent 的 source（git URL 或本地目录）。 */
  source: string;
  version?: string;
  tags?: string[];
}

/** GET /api/market 的返回结构。 */
export interface MarketResponse {
  entries: MarketEntry[];
  /** 面向用户的说明（例如 market/index.json 不存在时的降级提示）。 */
  message: string;
}

/** 统一错误结构。 */
export interface ApiError {
  error: string;
  message: string;
}

/* ------------------------------------------------------------------ *
 * M6 · AppManifest（24os-appmanifest/1）
 * ------------------------------------------------------------------ */

/** AppManifest 协议标识。 */
export const APP_MANIFEST_PROTOCOL = "24os-appmanifest/1";

/** App 来源类型：仓库内置 / 本地目录 / 远程 URL。 */
export type AppSourceType = "builtin" | "path" | "url";

/** 生命周期钩子名（M6 仅声明与分发到事件总线，M7 实现执行体）。 */
export type AppHookName = "ui.open" | "config.apply" | "notify";

/** 所有合法 hook 名（校验白名单）。 */
export const APP_HOOK_NAMES: readonly AppHookName[] = [
  "ui.open",
  "config.apply",
  "notify",
];

/** 插件输出通道类型（对齐 v3.0 channels→plugins）。 */
export type AppPluginKind = "http";

/** 生命周期钩子集合。 */
export interface AppManifestHooks {
  oninstall?: AppHookName[];
  onupdate?: AppHookName[];
  ondelete?: AppHookName[];
}

/** App 的 profile 交付配置。 */
export interface AppManifestProfile {
  /** 基于哪个已有 profile 模板（无则空 profile）。 */
  template?: string;
  /** 默认模型（经 configEdit 官方命令优先写入）。 */
  model?: { default?: string };
  /** MCP servers（写入 profile config）。 */
  mcp?: Array<{ name: string; config: Record<string, unknown> }>;
  /** 环境变量；密钥只存，GET 永不回显明文。 */
  env?: Record<string, string>;
  /** 需要落到 `<activeHome>/skills` 的 skill 目录名。 */
  skills?: string[];
}

/** App 的 UI 入口（指向 skillui 发现结果）。 */
export interface AppManifestUi {
  skillId?: string;
  host?: SkillUiHostKind;
}

/** 插件（输出通道）。 */
export interface AppManifestPlugin {
  name: string;
  kind: AppPluginKind;
  endpoint?: string;
  /** 从 profile.env 取 token 的键名（不回显值）。 */
  envKey?: string;
}

/** 完整性校验。 */
export interface AppManifestSign {
  /** 对 source.path 目录内文件按相对路径排序、拼接 `path\ncontent` 后的 sha256。 */
  sha256?: string;
}

/** App 来源声明。 */
export interface AppManifestSource {
  type: AppSourceType;
  /** type=builtin/path 时的目录（builtin 相对仓库根）。 */
  path?: string;
  /** type=url 时的远程地址。 */
  url?: string;
}

/** 解析校验后的 AppManifest（`24os-appmanifest/1`）。 */
export interface AppManifest {
  protocol: string;
  /** `^[a-z0-9][a-z0-9_-]{0,63}$`。 */
  id: string;
  name: string;
  /** 宽松 semver：`^\d+\.\d+\.\d+$`。 */
  version: string;
  description?: string;
  source: AppManifestSource;
  profile?: AppManifestProfile;
  ui?: AppManifestUi;
  hooks?: AppManifestHooks;
  plugins?: AppManifestPlugin[];
  sign?: AppManifestSign;
}

/** market 条目合并 AppManifest 后的元信息。 */
export interface MarketEntry {
  id: string;
  name: string;
  description: string;
  /** 传给 installAgent 的 source（git URL 或本地目录）。 */
  source: string;
  version?: string;
  tags?: string[];
  /** 存在同 id AppManifest 时合并的 UI 宿主形式。 */
  uiHost?: SkillUiHostKind;
  /** 存在同 id AppManifest 时合并的 hooks。 */
  hooks?: AppManifestHooks;
  /** 是否由 AppManifest 驱动（可走 /api/market/:id/apply）。 */
  appManifest?: boolean;
}

/** GET /api/market 的返回结构。 */
export interface MarketResponse {
  entries: MarketEntry[];
  /** 面向用户的说明（例如 market/index.json 不存在时的降级提示）。 */
  message: string;
}

/** App 编排动作。 */
export type AppApplyMode = "install" | "update" | "uninstall" | "rollback";

/** POST /api/market/:id/apply 请求体。 */
export interface ApplyAppManifestRequest {
  mode?: AppApplyMode;
  confirm?: boolean;
}

/** 已安装 App 记录里的历史版本（用于 rollback）。 */
export interface AppHistoryEntry {
  version: string;
  at: string;
  /** 该版本时的 manifest 快照（env 已脱敏）。 */
  manifest: AppManifest;
  /** 该版本对应的 profile 备份 tar.gz 路径。 */
  backupPath?: string;
}

/** `~/.24os/apps/<id>.json` 安装记录（env 明文永不落盘）。 */
export interface InstalledAppRecord {
  id: string;
  name: string;
  version: string;
  installedAt: string;
  updatedAt?: string;
  /** 最近一次 profile 备份（uninstall/update 前产生）。 */
  backupPath?: string;
  /** 当前 manifest 快照（env 值已脱敏为 "***"）。 */
  manifest: AppManifest;
  /** 历史版本（最近一次在末尾），rollback 据此恢复。 */
  history?: AppHistoryEntry[];
}

/** App 编排结果。 */
export interface AppApplyResult {
  ok: boolean;
  mode: AppApplyMode;
  id: string;
  version: string;
  /** 各步骤人类可读描述。 */
  steps: string[];
  /** 本次产生的备份路径。 */
  backups: string[];
  /** 实际分发到事件总线的 hooks。 */
  hooks: AppHookName[];
  /** 最近一次 profile 备份（若有）。 */
  backupPath?: string;
  /** 面向用户的中文说明。 */
  message: string;
}

/* ------------------------------------------------------------------ *
 * M3 · Agent 配置编辑（模型 / 描述 / MCP / 环境变量）
 * ------------------------------------------------------------------ */

/**
 * 一个 MCP server 的配置 spec（写入 config.yaml 的 `mcp_servers.<name>`）。
 * stdio：提供 `command`（+ 可选 `args`）；http：提供 `url`（+ 可选 `headers`）。
 */
export interface McpServerSpec {
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  [key: string]: unknown;
}

/**
 * GET /api/agents/:id/config 的返回结构。
 * `envKeys` 只含 `.env` 的**键名**，绝不返回值。
 */
export interface AgentConfig {
  id: string;
  /** config.yaml 顶层 model（字符串）或 model.default；缺失为 null。 */
  model: string | null;
  /** 工作台自有元数据 ~/.24os/agents/<id>/meta.json 里的描述。 */
  description: string;
  /** 官方 persona 正文（`<profileDir>/SOUL.md`，读 `profiles.describe.soul` 同一来源）。 */
  soul: string;
  /** 工作台自有元数据里的标签。 */
  tags: string[];
  /** config.yaml 顶层 mcp_servers。 */
  mcpServers: McpServer[];
  /** `.env` 里的键名列表（不含值）。 */
  envKeys: string[];
  /** config.yaml 路径；文件不存在时仍返回预期路径（best-effort 为 null）。 */
  configPath: string | null;
  /** `.env` 路径（可能尚不存在）。 */
  envPath: string;
  /** meta.json 路径（可能尚不存在）。 */
  metaPath: string;
  source: AgentSource;
}

/** PATCH /api/agents/:id/config 请求体。 */
export interface UpdateAgentConfigRequest {
  model?: string;
  /** 官方短描述（profiles.describe.description → `<profileDir>/profile.yaml`）。 */
  description?: string;
  /** 官方 persona 正文（profiles.configure.soul → `<profileDir>/SOUL.md`）。 */
  soul?: string;
  tags?: string[];
  /** 写操作必须显式 true，否则 CONFIRM_REQUIRED。 */
  confirm?: boolean;
}

/** POST /api/agents/:id/skills 请求体（skill 启停落盘到 meta.json）。 */
export interface SetSkillEnabledRequest {
  /** skill 名（须命中该 agent 已知 skill 的 id / name / 目录名，否则 400 INVALID_SKILL）。 */
  name: string;
  enabled: boolean;
  /** 写操作必须显式 true，否则 CONFIRM_REQUIRED。 */
  confirm?: boolean;
}

/** POST /api/agents/:id/mcp 请求体。 */
export interface AddMcpServerRequest {
  name: string;
  spec: McpServerSpec;
  confirm?: boolean;
}

/** PATCH /api/agents/:id/mcp/:name 请求体。 */
export interface UpdateMcpServerRequest {
  spec: McpServerSpec;
  confirm?: boolean;
}

/** POST /api/agents/:id/env 请求体。 */
export interface SetEnvRequest {
  key: string;
  value: string;
  confirm?: boolean;
}

/** 配置编辑动作类型。 */
export type ConfigEditAction =
  | "update-config"
  | "add-mcp"
  | "update-mcp"
  | "remove-mcp"
  | "set-env"
  | "remove-env"
  | "set-skill"
  | "restore-backup";

/**
 * 配置编辑操作的统一返回结构。
 * `backups` 为本次写操作前生成的 `.bak` 绝对路径（可直接用于回滚）。
 * 注意：env 相关动作的 message 绝不包含密钥明文。
 */
export interface ConfigEditResult {
  ok: boolean;
  action: ConfigEditAction;
  /**
   * 实际写入通道：
   *   - "cli"：通过官方 `hermes` 命令落盘（推荐，避免与 Hermes 进程并发写冲突）；
   *   - "rpc"：通过官方 gateway `profiles.configure` 落盘（SOUL / disabled_skills 等）；
   *   - "file"：官方通道不可用 / 失败时回退为工作台直接文件写（备份 + 原子写）。
   */
  via: "cli" | "rpc" | "file";
  /** 被修改 / 写入的文件绝对路径（走 CLI 时为空，因为由 Hermes 自身写入）。 */
  files: string[];
  /** 写操作前生成的备份文件绝对路径。 */
  backups: string[];
  /** 面向用户的中文说明（不含密钥明文）。 */
  message: string;
}

/* ------------------------------------------------------------------ *
 * M7 · Hooks 执行日志 / Dashboard WS / Bot Mode
 * ------------------------------------------------------------------ */

/** 一次 hook 执行记录（内存环形缓冲，最多 100 条）。 */
export interface HookLogEntry {
  hook: AppHookName;
  appId: string;
  status: "ok" | "error";
  /** ISO 时间。 */
  at: string;
  error?: string;
}

/** GET /api/hooks/log 响应。 */
export interface HookLogResponse {
  entries: HookLogEntry[];
  total: number;
}

/** Dashboard WS 服务端→客户端事件（{type, at, payload}）。 */
export interface DashboardEvent {
  type: string;
  at: string;
  payload?: Record<string, unknown>;
}

/* ------------------------------------------------------------------ *
 * M8 · 官方 Cron 薄封装（定时 = Hermes cron，工作台只做 UI + 触发器）
 * ------------------------------------------------------------------ */

/**
 * 官方 Cron 任务行，字段对齐 gateway `cron.manage` 的 `CronJobRow`
 * （`tui_gateway/contracts/tools_commands.py`）。
 * 官方新增字段通过索引签名透传，前端按需显示。
 */
export interface CronJob {
  job_id: string;
  /** 官方 jobs.json 里也用 `id`；列表映射时补齐。 */
  id?: string;
  name: string;
  skill?: string | null;
  skills?: string[];
  /** 提示词预览（官方只给截断预览，避免正文回显）。 */
  prompt_preview: string;
  model?: string | null;
  provider?: string | null;
  base_url?: string | null;
  schedule: string;
  repeat?: number | string | null;
  deliver?: string | null;
  next_run_at?: string | null;
  last_run_at?: string | null;
  last_status?: string | null;
  last_delivery_error?: string | null;
  last_delivery_unverified?: boolean | null;
  last_fire_error?: string | null;
  last_error?: string | null;
  enabled: boolean;
  state?: string | null;
  paused_at?: string | null;
  paused_reason?: string | null;
  workdir?: string | null;
  script?: string | null;
  reasoning_effort?: string | null;
  monitor_script?: string | null;
  monitor_url?: string | null;
  monitor_state?: unknown;
  no_agent?: boolean | null;
  enabled_toolsets?: string[] | null;
  continuity?: boolean | null;
  context_from?: string[] | null;
  attach_to_session?: boolean | null;
  [key: string]: unknown;
}

/** Cron 触发器信息（gateway 是否带 HERMES_DESKTOP=1 拉起官方 ticker）。 */
export interface CronTickerInfo {
  /** OS_CRON_TICKER !== "0"：是否让 `hermes serve` 带 HERMES_DESKTOP=1 触发官方 ticker。 */
  enabled: boolean;
  /** 共享 gateway 进程是否在跑。 */
  gatewayRunning: boolean;
  /** gateway WS 是否已连接。 */
  gatewayConnected: boolean;
}

/** GET /api/cron/jobs 响应（官方 jobs 列表 + 触发器状态）。 */
export interface CronJobsResponse {
  jobs: CronJob[];
  count: number;
  includeDisabled: boolean;
  /** profile scope（profile 查询时官方回填；否则 null）。 */
  scoped: string | null;
  ticker: CronTickerInfo;
  warning: string | null;
  message: string;
}

/** POST /api/cron/jobs 请求体（写操作，须 confirm:true）。 */
export interface CronJobAddRequest {
  /** 写操作门禁：缺失或非 true → CONFIRM_REQUIRED，不触碰磁盘。 */
  confirm?: boolean;
  /** `^[a-z0-9][a-z0-9_-]{0,63}$`。 */
  name: string;
  /** 官方 schedule 语义：`30m` / `every 2h` / `every monday 9am` / `0 9 * * *` / ISO。 */
  schedule: string;
  /** 自包含提示词（官方 RPC add 要求 prompt 或 skills）。 */
  prompt: string;
  repeat?: number;
  continuity?: boolean;
  /** origin|local|telegram|discord|signal|platform:chat_id|bot-chat[:profile]。 */
  deliver?: string;
  profile?: string;
}

/** Cron 变更动作结果（add/remove/pause/resume/run）。 */
export interface CronActionResult {
  ok: true;
  action: "add" | "remove" | "pause" | "resume" | "run";
  jobId?: string;
  name?: string;
  schedule?: string;
  nextRunAt?: string | null;
  /** 官方回调提示（如「gateway 未运行，任务不会自动触发」）。 */
  warning?: string | null;
  message?: string;
}

/* ------------------------------------------------------------------ *
 * M9 · 官方 Profile 对齐（头像 / SOUL）
 * ------------------------------------------------------------------ */

/**
 * GET /api/agents/:id/avatar 响应。
 * `data` 是 data URL（`data:image/png;base64,...`）；未设置头像时 `found:false` 且 `data:null`。
 */
export interface AgentAvatar {
  found: boolean;
  mime: string | null;
  size: number | null;
  data: string | null;
}

/** POST /api/agents/:id/avatar 请求体（写操作须 confirm:true）。 */
export interface AgentAvatarUploadRequest {
  /** data URL 或裸 base64；仅 PNG / JPEG，≤256KB。 */
  data: string;
  confirm?: boolean;
}

/** POST /api/agents/:id/avatar 响应。 */
export interface AgentAvatarUploadResult {
  ok: boolean;
  /** 写入的字节数。 */
  size: number;
  message: string;
}
