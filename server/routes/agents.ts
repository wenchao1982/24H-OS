import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import type {
  AddMcpServerRequest,
  Agent,
  AgentConfig,
  AgentsResponse,
  ApiError,
  AppApplyMode,
  AppApplyResult,
  AppManifest,
  ApplyAppManifestRequest,
  ConfigEditResult,
  DeleteAgentRequest,
  InstallAgentRequest,
  LifecycleResult,
  MarketResponse,
  SetEnvRequest,
  SetSkillEnabledRequest,
  Skill,
  UpdateAgentConfigRequest,
  UpdateAgentRequest,
  UpdateMcpServerRequest,
} from "@shared/types";
import { applyAppManifest, type ApplyAppDeps } from "../appmanifest/apply";
import { readInstalledApp } from "../appmanifest/store";
import { getSnapshot, refreshSnapshot } from "../hermes";
import {
  addMcpServer,
  readAgentConfig,
  readAgentMeta,
  removeEnvVar,
  removeMcpServer,
  restoreBackup,
  setEnvVar,
  setSkillEnabled,
  skillMetaEnabled,
  updateAgentConfig,
  updateMcpServer,
} from "../hermes/configEdit";
import { statusForCode, LifecycleError } from "../hermes/errors";
import {
  backupAgent,
  deleteAgent,
  installAgent,
  updateAgent,
} from "../hermes/lifecycle";
import { readMarket, readMarketAppManifest } from "../market";
import { buildSkillUiIndex } from "../skillui/discover";

/**
 * Agent 路由。
 * 返回结构全部来自 @shared/types，前端复用同一套类型。
 *
 * M4：给每个 skill 富化 hasUi / uiId（若发现对应 ui/manifest.json）。
 * M2-core：新增生命周期（install / update / delete / backup）与 /api/market。
 * M2 杂项：列表/详情合并 meta.json 的 description/tags/skills 启停；
 *          POST /api/agents/:id/skills 启停落盘。
 */

/** 单次请求内复用的 UI 索引，避免逐 skill 重复扫描磁盘。 */
function enrichAgentSkills(
  agent: Agent,
  index: Map<string, string>,
  metaSkills: Record<string, unknown>,
): Agent {
  return {
    ...agent,
    skills: agent.skills.map((skill) => {
      const enabled = skillMetaEnabled(metaSkills, skill);
      const base: Skill =
        enabled === undefined
          ? { ...skill, enabled: skill.enabled ?? true }
          : { ...skill, enabled };
      const uiId = lookupUiId(base, index);
      return uiId ? { ...base, hasUi: true, uiId } : base;
    }),
  };
}

/**
 * 合并工作台 meta.json 到 agent（列表与详情共用，优先级一致）：
 *   - description：meta 非空字符串覆盖 config 内描述；无 meta / 空串保持现状；
 *   - tags：meta.tags 存在（数组）则采用；无 meta 时缺省（config 本身无 tags）；
 *   - skills[].enabled：meta.skills.<name>.enabled 覆盖；无记录默认 true。
 */
async function enrichAgent(
  agent: Agent,
  index: Map<string, string>,
): Promise<Agent> {
  const meta = await readAgentMeta(agent.id);
  const metaDescription =
    typeof meta.description === "string" && meta.description.length > 0
      ? meta.description
      : agent.description;
  const tags = Array.isArray(meta.tags)
    ? meta.tags.filter((tag): tag is string => typeof tag === "string")
    : undefined;
  const metaSkills =
    meta.skills && typeof meta.skills === "object" && !Array.isArray(meta.skills)
      ? (meta.skills as Record<string, unknown>)
      : {};
  return {
    ...enrichAgentSkills(agent, index, metaSkills),
    description: metaDescription,
    ...(tags ? { tags } : {}),
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

/** 把配置编辑异常映射为 ApiError（LifecycleError → 对应状态码）。 */
function configError(reply: FastifyReply, error: unknown): ApiError {
  if (error instanceof LifecycleError) {
    reply.code(statusForCode(error.code));
    return { error: error.code, message: error.message };
  }
  throw error;
}

/** 只读配置：映射错误即可。 */
async function runConfigRead<T>(
  reply: FastifyReply,
  action: () => Promise<T>,
): Promise<T | ApiError> {
  try {
    return await action();
  } catch (error) {
    return configError(reply, error);
  }
}

/** 配置写操作：成功且非 dryRun 时刷新快照缓存。 */
async function runConfigMutation<T>(
  reply: FastifyReply,
  action: () => Promise<T>,
): Promise<T | ApiError> {
  try {
    const result = await action();
    await refreshSnapshot().catch(() => undefined);
    return result;
  } catch (error) {
    return configError(reply, error);
  }
}

export async function agentRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/agents —— agent 列表 + Hermes 状态（合并 meta description/tags + skills 启停 + hasUi/uiId）。
  app.get("/api/agents", async (): Promise<AgentsResponse> => {
    const snapshot = await getSnapshot();
    const index = buildSkillUiIndex();
    const agents = await Promise.all(
      snapshot.agents.map((agent) => enrichAgent(agent, index)),
    );
    return { ...snapshot, agents };
  });

  // GET /api/agents/:id —— 单个 agent 详情（与列表同样的 meta 合并优先级）。
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
      return enrichAgent(agent, buildSkillUiIndex());
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

  /* ---------------- M3 · Agent 配置编辑 ---------------- */

  // GET /api/agents/:id/config —— 读取结构化配置（env 只返回键名）。
  app.get<{ Params: { id: string } }>(
    "/api/agents/:id/config",
    async (request, reply): Promise<AgentConfig | ApiError> =>
      runConfigRead(reply, () => readAgentConfig(request.params.id)),
  );

  // PATCH /api/agents/:id/config —— 更新模型 / 描述 / 标签。
  app.patch<{ Params: { id: string }; Body: UpdateAgentConfigRequest }>(
    "/api/agents/:id/config",
    async (request, reply): Promise<ConfigEditResult | ApiError> => {
      const body = (request.body ?? {}) as UpdateAgentConfigRequest;
      return runConfigMutation(reply, () =>
        updateAgentConfig(request.params.id, body),
      );
    },
  );

  // POST /api/agents/:id/mcp —— 新增 MCP server。
  app.post<{ Params: { id: string }; Body: AddMcpServerRequest }>(
    "/api/agents/:id/mcp",
    async (request, reply): Promise<ConfigEditResult | ApiError> => {
      const body = (request.body ?? {}) as AddMcpServerRequest;
      return runConfigMutation(reply, () => addMcpServer(request.params.id, body));
    },
  );

  // PATCH /api/agents/:id/mcp/:name —— 更新 MCP server。
  app.patch<{ Params: { id: string; name: string }; Body: UpdateMcpServerRequest }>(
    "/api/agents/:id/mcp/:name",
    async (request, reply): Promise<ConfigEditResult | ApiError> => {
      const body = (request.body ?? {}) as UpdateMcpServerRequest;
      return runConfigMutation(reply, () =>
        updateMcpServer(request.params.id, request.params.name, body),
      );
    },
  );

  // DELETE /api/agents/:id/mcp/:name —— 删除 MCP server。
  app.delete<{ Params: { id: string; name: string }; Body: { confirm?: boolean } }>(
    "/api/agents/:id/mcp/:name",
    async (request, reply): Promise<ConfigEditResult | ApiError> => {
      const body = (request.body ?? {}) as { confirm?: boolean };
      return runConfigMutation(reply, () =>
        removeMcpServer(request.params.id, request.params.name, body),
      );
    },
  );

  // POST /api/agents/:id/env —— 设置环境变量（返回值不含明文）。
  app.post<{ Params: { id: string }; Body: SetEnvRequest }>(
    "/api/agents/:id/env",
    async (request, reply): Promise<ConfigEditResult | ApiError> => {
      const body = (request.body ?? {}) as SetEnvRequest;
      return runConfigMutation(reply, () => setEnvVar(request.params.id, body));
    },
  );

  // DELETE /api/agents/:id/env/:key —— 删除环境变量。
  app.delete<{ Params: { id: string; key: string }; Body: { confirm?: boolean } }>(
    "/api/agents/:id/env/:key",
    async (request, reply): Promise<ConfigEditResult | ApiError> => {
      const body = (request.body ?? {}) as { confirm?: boolean };
      return runConfigMutation(reply, () =>
        removeEnvVar(request.params.id, request.params.key, body),
      );
    },
  );

  // POST /api/agents/:id/config/restore —— 从备份还原（可选能力）。
  app.post<{
    Params: { id: string };
    Body: { backupFileName?: string; confirm?: boolean };
  }>("/api/agents/:id/config/restore", async (request, reply): Promise<ConfigEditResult | ApiError> => {
    const body = (request.body ?? {}) as { backupFileName?: string; confirm?: boolean };
    return runConfigMutation(reply, () =>
      restoreBackup(request.params.id, body.backupFileName ?? "", {
        confirm: body.confirm,
      }),
    );
  });

  // POST /api/agents/:id/skills —— skill 启停落盘（meta.json，四重保证）。
  app.post<{ Params: { id: string }; Body: SetSkillEnabledRequest }>(
    "/api/agents/:id/skills",
    async (request, reply): Promise<ConfigEditResult | ApiError> => {
      const body = (request.body ?? {}) as SetSkillEnabledRequest;
      return runConfigMutation(reply, () =>
        setSkillEnabled(request.params.id, body),
      );
    },
  );

  // GET /api/market —— 可安装 distribution 列表（合并 AppManifest 元信息）。
  app.get("/api/market", async (): Promise<MarketResponse> => readMarket());

  /* ---------------- M6 · AppManifest 编排 ---------------- */

  // GET /api/market/apps/:id —— 解析后的 AppManifest。
  app.get<{ Params: { id: string } }>(
    "/api/market/apps/:id",
    async (request, reply): Promise<AppManifest | ApiError> => {
      const manifest = readMarketAppManifest(request.params.id);
      if (!manifest) {
        reply.code(404);
        return {
          error: "APP_NOT_FOUND",
          message: `未找到 AppManifest：${request.params.id}`,
        };
      }
      return manifest;
    },
  );

  // POST /api/market/:id/apply —— install / update / uninstall / rollback。
  app.post<{ Params: { id: string }; Body: ApplyAppManifestRequest }>(
    "/api/market/:id/apply",
    async (request, reply): Promise<AppApplyResult | ApiError> => {
      const body = (request.body ?? {}) as ApplyAppManifestRequest;
      const id = request.params.id;
      const mode = body.mode ?? "install";
      const allowed: AppApplyMode[] = [
        "install",
        "update",
        "uninstall",
        "rollback",
      ];
      if (!allowed.includes(mode)) {
        reply.code(400);
        return {
          error: "INVALID_VALUE",
          message: `非法 mode：${String(mode)}（需为 ${allowed.join(" | ")}）`,
        };
      }

      // uninstall / rollback 用已装记录里的 manifest（无需市场源）；
      // install / update 从 market/apps 解析。
      let manifest = readMarketAppManifest(id);
      if (!manifest && (mode === "uninstall" || mode === "rollback")) {
        const record = await readInstalledApp(id);
        if (record?.manifest) manifest = record.manifest;
      }
      if (!manifest) {
        reply.code(404);
        return {
          error: "APP_NOT_FOUND",
          message: `未找到 AppManifest：${id}`,
        };
      }

      try {
        const result = await applyAppManifest(
          manifest,
          { mode, confirm: body.confirm },
          applyDepsFromEnv(),
        );
        await refreshSnapshot().catch(() => undefined);
        return result;
      } catch (error) {
        if (error instanceof LifecycleError) {
          reply.code(statusForCode(error.code));
          return { error: error.code, message: error.message };
        }
        throw error;
      }
    },
  );

  // POST /api/agents/install —— 兼容入口。
  // body.type === "market" && body.id → 委托 AppManifest apply；
  // 否则等价于原 POST /api/agents（installAgent）。
  app.post<{
    Body: InstallAgentRequest & { type?: string; id?: string; mode?: AppApplyMode };
  }>("/api/agents/install", async (request, reply): Promise<unknown> => {
    const body = (request.body ?? {}) as InstallAgentRequest & {
      type?: string;
      id?: string;
      mode?: AppApplyMode;
    };

    if (body.type === "market" && body.id) {
      const mode = body.mode ?? "install";
      let manifest = readMarketAppManifest(body.id);
      if (!manifest && (mode === "uninstall" || mode === "rollback")) {
        const record = await readInstalledApp(body.id);
        if (record?.manifest) manifest = record.manifest;
      }
      if (!manifest) {
        reply.code(404);
        return {
          error: "APP_NOT_FOUND",
          message: `未找到 AppManifest：${body.id}`,
        };
      }
      try {
        const result = await applyAppManifest(
          manifest,
          { mode, confirm: body.confirm },
          applyDepsFromEnv(),
        );
        await refreshSnapshot().catch(() => undefined);
        return result;
      } catch (error) {
        if (error instanceof LifecycleError) {
          reply.code(statusForCode(error.code));
          return { error: error.code, message: error.message };
        }
        throw error;
      }
    }

    return runLifecycle(reply, () => installAgent(body));
  });
}

/** 从环境变量组装 apply 依赖（测试经 env 注入临时目录）。 */
function applyDepsFromEnv(): ApplyAppDeps {
  return {};
}
