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
  /** 该 skill 是否自带可托管的 UI（存在 ui/manifest.json）。 */
  hasUi?: boolean;
  /** 若有 UI，其协议 id（来自 ui/manifest.json 的 id 字段）。 */
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
  | "readFile"
  | "writeFile"
  | "runTool"
  | "emitEvent"
  | "resize";

/** 所有合法的 capability（用于运行时校验 manifest）。 */
export const SKILL_UI_CAPABILITIES: readonly SkillUiCapability[] = [
  "callModel",
  "readFile",
  "writeFile",
  "runTool",
  "emitEvent",
  "resize",
];

/** GET /api/skill-uis 的单项：已发现的、自带 UI 的 skill。 */
export interface SkillUiInfo {
  /** manifest.id。 */
  id: string;
  /** manifest.title。 */
  title: string;
  /** skill 根目录（含 SKILL.md 的那层）。 */
  skillPath: string;
  /** ui/ 目录的绝对路径（静态托管的根）。 */
  uiRoot: string;
  /** 解析后的 manifest。 */
  manifest: SkillUiManifest;
  /** 恒为 true，便于前端统一过滤（类型上与 Agent.skills[].hasUi 呼应）。 */
  hasUi: boolean;
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
  description?: string;
  tags?: string[];
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
   *   - "file"：CLI 不可用 / 命令失败时回退为工作台直接文件写（备份 + 原子写）。
   */
  via: "cli" | "file";
  /** 被修改 / 写入的文件绝对路径（走 CLI 时为空，因为由 Hermes 自身写入）。 */
  files: string[];
  /** 写操作前生成的备份文件绝对路径。 */
  backups: string[];
  /** 面向用户的中文说明（不含密钥明文）。 */
  message: string;
}
