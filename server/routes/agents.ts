import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import type {
  Agent,
  AgentsResponse,
  ApiError,
  DeleteAgentRequest,
  InstallAgentRequest,
  LifecycleResult,
  MarketResponse,
  Skill,
  UpdateAgentRequest,
} from "@shared/types";
import { getSnapshot, refreshSnapshot } from "../hermes";
import { statusForCode, LifecycleError } from "../hermes/errors";
import {
  backupAgent,
  deleteAgent,
  installAgent,
  updateAgent,
} from "../hermes/lifecycle";
import { readMarket } from "../market";
import { buildSkillUiIndex } from "../skillui/discover";

/**
 * Agent 路由。
 * 返回结构全部来自 @shared/types，前端复用同一套类型。
 *
 * M4：给每个 skill 富化 hasUi / uiId（若发现对应 ui/manifest.json）。
 * M2-core：新增生命周期（install / update / delete / backup）与 /api/market。
 */

/** 单次请求内复用的 UI 索引，避免逐 skill 重复扫描磁盘。 */
function enrichAgentSkills(agent: Agent, index: Map<string, string>): Agent {
  return {
    ...agent,
    skills: agent.skills.map((skill) => {
      const uiId = lookupUiId(skill, index);
      return uiId ? { ...skill, hasUi: true, uiId } : skill;
    }),
  };
}

/** 依次用 skill.id / skill.name / skill.path 目录名匹配 UI id。 */
function lookupUiId(skill: Skill, index: Map<string, string>): string | undefined {
  return (
    index.get(skill.id) ??
    (skill.name ? index.get(skill.name) : undefined) ??
    (skill.path ? index.get(path.basename(skill.path)) : undefined)
  );
}

/**
 * 运行一个生命周期动作并统一错误映射：
 *   - LifecycleError → 对应 HTTP 状态 + ApiError{ error: code }；
 *   - 其它异常交回全局错误处理器。
 * 成功且非 dryRun 时刷新快照缓存。
 */
async function runLifecycle(
  reply: FastifyReply,
  action: () => Promise<LifecycleResult>,
): Promise<LifecycleResult | ApiError> {
  try {
    const result = await action();
    if (result.ok && !result.dryRun) {
      await refreshSnapshot().catch(() => undefined);
    }
    return result;
  } catch (error) {
    if (error instanceof LifecycleError) {
      reply.code(statusForCode(error.code));
      return { error: error.code, message: error.message };
    }
    throw error;
  }
}

export async function agentRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/agents —— agent 列表 + Hermes 状态（skills 富化 hasUi/uiId）。
  app.get("/api/agents", async (): Promise<AgentsResponse> => {
    const snapshot = await getSnapshot();
    const index = buildSkillUiIndex();
    return {
      ...snapshot,
      agents: snapshot.agents.map((agent) => enrichAgentSkills(agent, index)),
    };
  });

  // GET /api/agents/:id —— 单个 agent 详情。
  app.get<{ Params: { id: string } }>(
    "/api/agents/:id",
    async (request, reply): Promise<Agent | ApiError> => {
      const { id } = request.params;
      const { agents } = await getSnapshot();
      const agent = agents.find((item) => item.id === id);

      if (!agent) {
        reply.code(404);
        return { error: "AGENT_NOT_FOUND", message: `未找到 agent：${id}` };
      }
      return enrichAgentSkills(agent, buildSkillUiIndex());
    },
  );

  // POST /api/agents —— 安装 agent（git URL / 本地目录）。
  app.post<{ Body: InstallAgentRequest }>(
    "/api/agents",
    async (request, reply): Promise<LifecycleResult | ApiError> => {
      const body = (request.body ?? {}) as InstallAgentRequest;
      return runLifecycle(reply, () => installAgent(body));
    },
  );

  // POST /api/agents/:id/update —— 更新 agent。
  app.post<{ Params: { id: string }; Body: UpdateAgentRequest }>(
    "/api/agents/:id/update",
    async (request, reply): Promise<LifecycleResult | ApiError> => {
      const body = (request.body ?? {}) as UpdateAgentRequest;
      return runLifecycle(reply, () => updateAgent(request.params.id, body));
    },
  );

  // DELETE /api/agents/:id —— 卸载 agent（默认先备份）。
  app.delete<{ Params: { id: string }; Body: DeleteAgentRequest }>(
    "/api/agents/:id",
    async (request, reply): Promise<LifecycleResult | ApiError> => {
      const body = (request.body ?? {}) as DeleteAgentRequest;
      return runLifecycle(reply, () => deleteAgent(request.params.id, body));
    },
  );

  // POST /api/agents/:id/backup —— 导出 profile 为 tar.gz。
  app.post<{ Params: { id: string }; Body: { dryRun?: boolean } }>(
    "/api/agents/:id/backup",
    async (request, reply): Promise<LifecycleResult | ApiError> => {
      const body = (request.body ?? {}) as { dryRun?: boolean };
      return runLifecycle(reply, () =>
        backupAgent(request.params.id, { dryRun: body.dryRun }),
      );
    },
  );

  // GET /api/market —— 可安装的 distribution 列表（静态 stub）。
  app.get("/api/market", async (): Promise<MarketResponse> => readMarket());
}
