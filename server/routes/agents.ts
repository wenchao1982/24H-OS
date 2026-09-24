import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { Agent, AgentsResponse, ApiError, Skill } from "@shared/types";
import { getSnapshot } from "../hermes";
import { buildSkillUiIndex } from "../skillui/discover";

/**
 * Agent 路由。
 * 返回结构全部来自 @shared/types，前端复用同一套类型。
 *
 * M4：给每个 skill 富化 hasUi / uiId（若发现对应 ui/manifest.json）。
 *
 * TODO(M2+): 增加 POST/PATCH/DELETE，对接 hermes profile install / update / delete。
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
}
