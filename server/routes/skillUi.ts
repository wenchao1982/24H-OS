import { readFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import type { ApiError, SkillHostInvokeRequest, SkillUiInfo } from "@shared/types";
import { discoverSkillUis, findSkillUi } from "../skillui/discover";
import { invokeSkill } from "../skillui/broker";
import { contentTypeFor, resolveUiAsset, SKILL_UI_CSP } from "../skillui/static";

/**
 * Skill UI 路由：
 *   GET  /api/skill-uis            列出所有自带 UI 的 skill
 *   GET  /api/skill-uis/:id        单个 UI 信息
 *   GET  /skill-ui/:id/*           静态托管 ui/ 目录（严格 CSP）
 *   POST /api/skill-host/invoke    能力 broker
 *
 * TODO(M5): 为 iframe 增加一次性 opaque origin / nonce 校验与更细粒度审计日志。
 */

/** 统一的 404 负载。 */
function notFound(message: string): ApiError {
  return { error: "NOT_FOUND", message };
}

export async function skillUiRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/skill-uis —— 所有自带 UI 的 skill。
  app.get("/api/skill-uis", async (): Promise<SkillUiInfo[]> => {
    return discoverSkillUis();
  });

  // GET /api/skill-uis/:id —— 单个 UI 信息。
  app.get<{ Params: { id: string } }>(
    "/api/skill-uis/:id",
    async (request, reply): Promise<SkillUiInfo | ApiError> => {
      const info = findSkillUi(request.params.id);
      if (!info) {
        reply.code(404);
        return notFound(`未找到带 UI 的 skill：${request.params.id}`);
      }
      return info;
    },
  );

  // GET /skill-ui/:id/* —— 静态文件。路径越界 / 非白名单扩展名一律 404。
  app.get<{ Params: { id: string; "*": string } }>(
    "/skill-ui/:id/*",
    async (request, reply) => {
      const info = findSkillUi(request.params.id);
      if (!info) {
        reply.code(404);
        return notFound(`未找到带 UI 的 skill：${request.params.id}`);
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
