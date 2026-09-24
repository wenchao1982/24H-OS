import type { FastifyInstance } from "fastify";
import type { HermesStatus } from "@shared/types";
import { getSnapshot } from "../hermes";

/**
 * Hermes 状态路由。
 * 前端顶部状态条据此显示 live / mock、CLI 版本与说明字符串。
 */

export async function hermesRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/hermes/status —— Hermes 探测结果。
  app.get("/api/hermes/status", async (): Promise<HermesStatus> => {
    const { status } = await getSnapshot();
    return status;
  });

  // GET /api/health —— 存活探针。
  app.get("/api/health", async (): Promise<{ ok: true; service: string }> => {
    return { ok: true, service: "24h-os-server" };
  });
}
