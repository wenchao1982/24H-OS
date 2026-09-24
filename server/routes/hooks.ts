import type { FastifyInstance } from "fastify";
import type { HookLogResponse } from "@shared/types";
import { getHookLog } from "../hooks/executor";

/**
 * Hooks 日志路由（M7）。
 * GET /api/hooks/log —— 最近 100 条 hook 执行记录（内存环形缓冲）。
 */
export async function hookRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/hooks/log", async (): Promise<HookLogResponse> => {
    const entries = getHookLog();
    return { entries, total: entries.length };
  });
}
