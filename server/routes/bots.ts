import type { FastifyInstance } from "fastify";
import type { ApiError, BotRunResult, BotsResponse } from "@shared/types";
import {
  getBotLog,
  isSchedulerRunning,
  listBotsForApi,
  setBotEnabled,
} from "../bot/scheduler";
import { resolveBotsFile } from "../bot/roster";

/**
 * Bot Mode 路由（M7）。
 *
 * - GET /api/bots —— 列表 + nextRun + lastResult + 运行日志
 * - POST /api/bots/:id/enable|disable —— 改内存态（落盘需另走四重保证，暂不落盘）
 */
export async function botRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/bots", async (): Promise<BotsResponse> => {
    const { bots, file, errors } = listBotsForApi();
    const log: BotRunResult[] = getBotLog();
    const running = isSchedulerRunning();
    const message = !running
      ? "调度器未启动（设置 OS_BOT_ENABLED=1 并重启以启用）。"
      : errors.length > 0
        ? `调度器运行中；${errors.length} 条配置问题。`
        : "调度器运行中。";
    return {
      bots,
      schedulerRunning: running,
      file: file || resolveBotsFile(),
      log,
      message,
    };
  });

  app.post<{ Params: { id: string } }>(
    "/api/bots/:id/enable",
    async (request, reply): Promise<{ ok: true; id: string; enabled: boolean } | ApiError> => {
      const ok = setBotEnabled(request.params.id, true);
      if (!ok) {
        reply.code(404);
        return {
          error: "NOT_FOUND",
          message: `未找到 bot：${request.params.id}`,
        };
      }
      return { ok: true, id: request.params.id, enabled: true };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/bots/:id/disable",
    async (request, reply): Promise<{ ok: true; id: string; enabled: boolean } | ApiError> => {
      const ok = setBotEnabled(request.params.id, false);
      if (!ok) {
        reply.code(404);
        return {
          error: "NOT_FOUND",
          message: `未找到 bot：${request.params.id}`,
        };
      }
      return { ok: true, id: request.params.id, enabled: false };
    },
  );

  app.get("/api/bots/log", async (): Promise<{ entries: BotRunResult[]; total: number }> => {
    const entries = getBotLog();
    return { entries, total: entries.length };
  });
}
