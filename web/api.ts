import type {
  AddMcpServerRequest,
  Agent,
  AgentConfig,
  AgentsResponse,
  ConfigEditResult,
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
