/**
 * 24H-OS 前后端共享类型定义。
 * 前端通过 vite alias `@shared/types` 引用，后端通过 tsconfig paths 引用。
 * 所有 REST API 的返回结构都应从这里导出，保证前后端类型一致。
 */

/** Agent 数据来源：真实 Hermes profile，或降级用的 mock 数据。 */
export type AgentSource = "profiles" | "mock";

/** Hermes 运行模式：live = 读取真实 ~/.hermes，mock = 使用内置示例数据。 */
export type HermesMode = "live" | "mock";

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
  /** ~/.hermes 目录，未检测到为 null。 */
  homePath: string | null;
  /** 当前可用（真实）profile 数量。 */
  profileCount: number;
  /** 面向用户的中文说明字符串。 */
  message: string;
}

/** GET /api/agents 的返回结构。 */
export interface AgentsResponse {
  agents: Agent[];
  status: HermesStatus;
}

/** 统一错误结构。 */
export interface ApiError {
  error: string;
  message: string;
}
