import type {
  Agent,
  AgentsResponse,
  HermesStatus,
  SkillUiInfo,
} from "@shared/types";

/**
 * 前端 API 封装：统一指向本地 Fastify 内核桥接层。
 * 默认 http://localhost:4319，可用 VITE_API_BASE_URL 覆盖。
 * 返回类型全部复用 @shared/types，保证与后端一致。
 */

export const API_BASE: string =
  import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4319";

async function request<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    let detail = "";
    try {
      detail = await response.text();
    } catch {
      detail = "";
    }
    throw new Error(
      `请求失败 ${response.status} ${path}${detail ? `：${detail}` : ""}`,
    );
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
