import { readFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import type {
  ApiError,
  PanelSpec,
  SkillHostInvokeRequest,
  SkillUiInfo,
} from "@shared/types";
import { discoverSkillUis, findSkillUi } from "../skillui/discover";
import { isSkillDisabled, withDisabledFlags } from "../skillui/disabled";
import { invokeSkill } from "../skillui/broker";
import { contentTypeFor, resolveUiAsset, SKILL_UI_CSP } from "../skillui/static";

/**
 * Skill UI 路由：
 *   GET  /api/skill-uis            列出所有自带 UI 的 skill
 *   GET  /api/skill-uis/:id        单个 UI 信息
 *   GET  /api/skill-uis/:id/panel  声明式面板（disabled → 403 SKILL_DISABLED）
 *   GET  /skill-ui/:id/*           静态托管 ui/ 目录（严格 CSP；disabled → 403）
 *   POST /api/skill-host/invoke    能力 broker（disabled → 403，见 broker.ts）
 *
 * M2 杂项：被任一 agent 的 meta.json 标记 enabled:false 的 skill 标 `disabled:true`
 * （前端据此不渲染打开入口；服务端字段为准）。启停判定统一走
 * `server/skillui/disabled.ts`（与列表 `disabled` 聚合同口径、每次读盘）。
 *
 * 静态/panel 的 403 vs 404 口径（本任务选定并已测试）：
 *   **先判 skill 存在（findSkillUi），再判禁用，最后判文件**——
 *   skill 不存在 → 404；skill 存在但被禁用 → 403 SKILL_DISABLED（任意路径）；
 *   skill 启用但文件缺失/越界 → 404。存在性已由 `GET /api/skill-uis` 列表公开，
 *   403 不泄露额外信息，且能与「文件不存在」明确区分，便于测试与排障。
 *
 * TODO(M5): 为 iframe 增加一次性 opaque origin / nonce 校验与更细粒度审计日志。
 */

/** 统一的 404 负载。 */
function notFound(message: string): ApiError {
  return { error: "NOT_FOUND", message };
}

/** 统一的 403 SKILL_DISABLED 负载。 */
function skillDisabled(id: string): ApiError {
  return {
    error: "SKILL_DISABLED",
    message: `skill 已被禁用：${id}`,
  } satisfies ApiError;
}

export async function skillUiRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/skill-uis —— 所有自带 UI 的 skill（含 disabled 标注）。
  app.get("/api/skill-uis", async (): Promise<SkillUiInfo[]> => {
    return withDisabledFlags(discoverSkillUis());
  });

  // GET /api/skill-uis/:id —— 单个 UI 信息（含 disabled 标注）。
  app.get<{ Params: { id: string } }>(
    "/api/skill-uis/:id",
    async (request, reply): Promise<SkillUiInfo | ApiError> => {
      const info = findSkillUi(request.params.id);
      if (!info) {
        reply.code(404);
        return notFound(`未找到带 UI 的 skill：${request.params.id}`);
      }
      const [annotated] = await withDisabledFlags([info]);
      return annotated ?? info;
    },
  );

  // GET /api/skill-uis/:id/panel —— 声明式面板规范（仅 uiHost=declarative）。
  // disabled → 403 SKILL_DISABLED（先于面板形态判定，口径与 broker/静态一致）。
  app.get<{ Params: { id: string } }>(
    "/api/skill-uis/:id/panel",
    async (request, reply): Promise<PanelSpec | ApiError> => {
      const info = findSkillUi(request.params.id);
      if (!info) {
        reply.code(404);
        return {
          error: "PANEL_NOT_FOUND",
          message: `未找到声明式面板：${request.params.id}`,
        } satisfies ApiError;
      }
      if (await isSkillDisabled(info)) {
        reply.code(403);
        return skillDisabled(request.params.id);
      }
      if (info.uiHost !== "declarative" || !info.panel) {
        reply.code(404);
        return {
          error: "PANEL_NOT_FOUND",
          message: `未找到声明式面板：${request.params.id}`,
        } satisfies ApiError;
      }
      return info.panel;
    },
  );

  // GET /skill-ui/:id/* —— 静态文件。口径：skill 不存在 404 → 禁用 403 →
  // 路径越界 / 非白名单扩展名 / 文件缺失 404（见文件头注释）。
  app.get<{ Params: { id: string; "*": string } }>(
    "/skill-ui/:id/*",
    async (request, reply) => {
      const info = findSkillUi(request.params.id);
      if (!info) {
        reply.code(404);
        return notFound(`未找到带 UI 的 skill：${request.params.id}`);
      }
      if (await isSkillDisabled(info)) {
        reply.code(403);
        return skillDisabled(request.params.id);
      }

      let rel = request.params["*"];
      try {
        rel = decodeURIComponent(rel);
      } catch {
        // 保留原始值即可，resolveUiAsset 会拒绝非法路径。
      }

      const asset = resolveUiAsset(info.uiRoot, rel);
      if (!asset) {
        reply.code(404);
        return notFound(`拒绝服务该资源：${request.params["*"]}`);
      }

      let body: Buffer;
      try {
        body = await readFile(asset.absolute);
      } catch {
        reply.code(404);
        return notFound(`文件不存在：${asset.relative}`);
      }

      reply.header("Content-Security-Policy", SKILL_UI_CSP);
      reply.header("X-Content-Type-Options", "nosniff");
      reply.header("Cache-Control", "no-store");
      reply.type(contentTypeFor(asset.ext));
      return reply.send(body);
    },
  );

  // POST /api/skill-host/invoke —— 能力 broker。
  app.post<{ Body: SkillHostInvokeRequest }>(
    "/api/skill-host/invoke",
    async (request, reply) => {
      const outcome = await invokeSkill(request.body ?? ({} as SkillHostInvokeRequest));
      reply.code(outcome.status);
      return outcome.body;
    },
  );
}
