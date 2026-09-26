import type {
  AddMcpServerRequest,
  Agent,
  AgentAvatar,
  AgentAvatarUploadResult,
  AgentConfig,
  AgentsResponse,
  ChatDecideRequest,
  ChatDecideResult,
  ConfigEditResult,
  CronActionResult,
  CronJobAddRequest,
  CronJobsResponse,
  DeleteAgentRequest,
  HermesStatus,
  InstallAgentRequest,
  LifecycleResult,
  MarketResponse,
  SetEnvRequest,
  SkillUiInfo,
  UpdateAgentConfigRequest,
  UpdateAgentRequest,
  UpdateMcpServerRequest,
} from "@shared/types";

/**
 * 前端 API 封装：统一指向本地 Fastify 内核桥接层。
 * 默认 http://localhost:4319，可用 VITE_API_BASE_URL 覆盖。
 * 返回类型全部复用 @shared/types，保证与后端一致。
 */

export const API_BASE: string =
  import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4319";

/** 带错误码的请求异常，便于 UI 区分 CONFIRM_REQUIRED / HERMES_CLI_UNAVAILABLE 等。 */
export class ApiRequestError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    let code = "REQUEST_FAILED";
    let message = `请求失败 ${response.status} ${path}`;
    try {
      const data: unknown = await response.json();
      if (data && typeof data === "object") {
        const obj = data as Record<string, unknown>;
        if (typeof obj.error === "string") code = obj.error;
        if (typeof obj.message === "string") message = obj.message;
      }
    } catch {
      // 保留默认 message。
    }
    throw new ApiRequestError(response.status, code, message);
  }

  return (await response.json()) as T;
}

/** GET /api/agents */
export function fetchAgents(): Promise<AgentsResponse> {
  return request<AgentsResponse>("/api/agents");
}

/** GET /api/agents/:id */
export function fetchAgent(id: string): Promise<Agent> {
  return request<Agent>(`/api/agents/${encodeURIComponent(id)}`);
}

/**
 * 模型下拉候选（M5 模型热切换）：
 * 指定 agentId 时取 `GET /api/agents/:id` 的 model；否则取 `GET /api/agents` 全部去重。
 */
export async function fetchModelOptions(agentId?: string): Promise<string[]> {
  if (agentId) {
    try {
      const agent = await fetchAgent(agentId);
      return agent.model ? [agent.model] : [];
    } catch {
      // agent 不存在 → 回退全量列表。
    }
  }
  const data = await fetchAgents();
  const seen = new Set<string>();
  for (const agent of data.agents) {
    if (agent.model) seen.add(agent.model);
  }
  return [...seen];
}

/** POST /api/hermes/chat/decide —— 回应挂起的 approval / clarify（M5 交互式授权）。 */
export function decideChat(body: ChatDecideRequest): Promise<ChatDecideResult> {
  return request<ChatDecideResult>("/api/hermes/chat/decide", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** 生成客户端 chatId（SSE body 可选；用于 decide 定位）。 */
export function newChatId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** GET /api/hermes/status */
export function fetchHermesStatus(): Promise<HermesStatus> {
  return request<HermesStatus>("/api/hermes/status");
}

/** GET /api/skill-uis —— 所有自带 UI 的 skill（M4）。 */
export function fetchSkillUis(): Promise<SkillUiInfo[]> {
  return request<SkillUiInfo[]>("/api/skill-uis");
}

/* ------------------------------------------------------------------ *
 * M2-core · Agent 生命周期
 * ------------------------------------------------------------------ */

/** POST /api/agents —— 安装（dryRun 时仅预览命令）。 */
export function installAgent(body: InstallAgentRequest): Promise<LifecycleResult> {
  return request<LifecycleResult>("/api/agents", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** POST /api/agents/:id/update */
export function updateAgent(
  id: string,
  body: UpdateAgentRequest,
): Promise<LifecycleResult> {
  return request<LifecycleResult>(`/api/agents/${encodeURIComponent(id)}/update`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** DELETE /api/agents/:id（默认先备份）。 */
export function deleteAgent(
  id: string,
  body: DeleteAgentRequest,
): Promise<LifecycleResult> {
  return request<LifecycleResult>(`/api/agents/${encodeURIComponent(id)}`, {
    method: "DELETE",
    body: JSON.stringify(body),
  });
}

/** POST /api/agents/:id/backup */
export function backupAgent(
  id: string,
  body: { dryRun?: boolean } = {},
): Promise<LifecycleResult> {
  return request<LifecycleResult>(`/api/agents/${encodeURIComponent(id)}/backup`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** GET /api/market —— 可安装 distribution 列表。 */
export function fetchMarket(): Promise<MarketResponse> {
  return request<MarketResponse>("/api/market");
}

/* ------------------------------------------------------------------ *
 * M3 · Agent 配置编辑（模型 / 描述 / MCP / 环境变量）
 * ------------------------------------------------------------------ */

/** GET /api/agents/:id/config —— 结构化配置（env 只有键名）。 */
export function fetchAgentConfig(id: string): Promise<AgentConfig> {
  return request<AgentConfig>(`/api/agents/${encodeURIComponent(id)}/config`);
}

/** PATCH /api/agents/:id/config —— 更新模型 / 描述 / 标签。 */
export function updateAgentConfig(
  id: string,
  body: UpdateAgentConfigRequest,
): Promise<ConfigEditResult> {
  return request<ConfigEditResult>(`/api/agents/${encodeURIComponent(id)}/config`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

/** POST /api/agents/:id/mcp —— 新增 MCP server。 */
export function addMcpServer(
  id: string,
  body: AddMcpServerRequest,
): Promise<ConfigEditResult> {
  return request<ConfigEditResult>(`/api/agents/${encodeURIComponent(id)}/mcp`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** PATCH /api/agents/:id/mcp/:name —— 更新 MCP server。 */
export function updateMcpServer(
  id: string,
  name: string,
  body: UpdateMcpServerRequest,
): Promise<ConfigEditResult> {
  return request<ConfigEditResult>(
    `/api/agents/${encodeURIComponent(id)}/mcp/${encodeURIComponent(name)}`,
    { method: "PATCH", body: JSON.stringify(body) },
  );
}

/** DELETE /api/agents/:id/mcp/:name —— 删除 MCP server。 */
export function removeMcpServer(
  id: string,
  name: string,
  body: { confirm?: boolean } = {},
): Promise<ConfigEditResult> {
  return request<ConfigEditResult>(
    `/api/agents/${encodeURIComponent(id)}/mcp/${encodeURIComponent(name)}`,
    { method: "DELETE", body: JSON.stringify(body) },
  );
}

/** POST /api/agents/:id/env —— 设置环境变量（返回值不含明文）。 */
export function setEnvVar(id: string, body: SetEnvRequest): Promise<ConfigEditResult> {
  return request<ConfigEditResult>(`/api/agents/${encodeURIComponent(id)}/env`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** DELETE /api/agents/:id/env/:key —— 删除环境变量。 */
export function removeEnvVar(
  id: string,
  key: string,
  body: { confirm?: boolean } = {},
): Promise<ConfigEditResult> {
  return request<ConfigEditResult>(
    `/api/agents/${encodeURIComponent(id)}/env/${encodeURIComponent(key)}`,
    { method: "DELETE", body: JSON.stringify(body) },
  );
}

/** POST /api/agents/:id/config/restore —— 从备份还原。 */
export function restoreAgentConfigBackup(
  id: string,
  body: { backupFileName: string; confirm?: boolean },
): Promise<ConfigEditResult> {
  return request<ConfigEditResult>(
    `/api/agents/${encodeURIComponent(id)}/config/restore`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

/** POST /api/agents/:id/skills —— skill 启停落盘（官方 disabled_skills 优先，meta 回退）。 */
export function setSkillEnabled(
  id: string,
  body: { name: string; enabled: boolean; confirm?: boolean },
): Promise<ConfigEditResult> {
  return request<ConfigEditResult>(`/api/agents/${encodeURIComponent(id)}/skills`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/* ------------------------------------------------------------------ *
 * M9 · 官方 Profile 对齐（头像）
 * ------------------------------------------------------------------ */

/** GET /api/agents/:id/avatar —— 读取头像（官方 profiles.get_asset）。 */
export function fetchAgentAvatar(id: string): Promise<AgentAvatar> {
  return request<AgentAvatar>(`/api/agents/${encodeURIComponent(id)}/avatar`);
}

/** POST /api/agents/:id/avatar —— 上传头像（confirm 门禁，PNG/JPEG ≤256KB）。 */
export function uploadAgentAvatar(
  id: string,
  data: string,
): Promise<AgentAvatarUploadResult> {
  return request<AgentAvatarUploadResult>(
    `/api/agents/${encodeURIComponent(id)}/avatar`,
    { method: "POST", body: JSON.stringify({ data, confirm: true }) },
  );
}

/* ------------------------------------------------------------------ *
 * M8 · 官方 Cron（定时任务）
 * 定时完全由 Hermes 官方 cron 负责；这里只是薄封装（列表 + 操作）。
 * 写操作（add/pause/resume/remove/run）一律带 confirm:true。
 * ------------------------------------------------------------------ */

/** GET /api/cron/jobs —— 官方定时任务列表（默认不含暂停项）。 */
export function fetchCronJobs(
  options: { includeDisabled?: boolean; profile?: string } = {},
): Promise<CronJobsResponse> {
  const params = new URLSearchParams();
  if (options.includeDisabled) params.set("include_disabled", "1");
  if (options.profile) params.set("profile", options.profile);
  const qs = params.toString();
  return request<CronJobsResponse>(`/api/cron/jobs${qs ? `?${qs}` : ""}`);
}

/** POST /api/cron/jobs —— 新增任务（confirm 门禁）。 */
export function addCronJob(body: CronJobAddRequest): Promise<CronActionResult> {
  return request<CronActionResult>("/api/cron/jobs", {
    method: "POST",
    body: JSON.stringify({ ...body, confirm: true }),
  });
}

function cronAction(
  name: string,
  action: "pause" | "resume" | "remove" | "run",
): Promise<CronActionResult> {
  return request<CronActionResult>(
    `/api/cron/jobs/${encodeURIComponent(name)}/${action}`,
    { method: "POST", body: JSON.stringify({ confirm: true }) },
  );
}

/** POST /api/cron/jobs/:name/pause */
export function pauseCronJob(name: string): Promise<CronActionResult> {
  return cronAction(name, "pause");
}

/** POST /api/cron/jobs/:name/resume */
export function resumeCronJob(name: string): Promise<CronActionResult> {
  return cronAction(name, "resume");
}

/** POST /api/cron/jobs/:name/remove */
export function removeCronJob(name: string): Promise<CronActionResult> {
  return cronAction(name, "remove");
}

/** POST /api/cron/jobs/:name/run —— 立即运行一次（CLI 兜底）。 */
export function runCronJob(name: string): Promise<CronActionResult> {
  return cronAction(name, "run");
}
