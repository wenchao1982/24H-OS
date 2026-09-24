import type { FastifyInstance } from "fastify";
import type {
  ApiError,
  ChatStreamEvent,
  ChatStreamRequest,
  GatewayStatus,
  HermesStatus,
} from "@shared/types";
import { getSnapshot } from "../hermes";
import { getLastCompleteError, getLastCompleteVia } from "../hermes/complete";
import { streamPrompt } from "../hermes/chat";
import { detectHermes } from "../hermes/detect";
import { ensureGateway, getGatewaySnapshot, stopSharedGateway } from "../hermes/gateway";

/**
 * Hermes 状态路由。
 * 前端顶部状态条据此显示 live / mock、CLI 版本与说明字符串；
 * M5.1 起额外暴露 TUI gateway 的运行状态/启停；
 * M5.2 起提供 SSE 流式对话 `/api/hermes/chat/stream`。
 */

/** 路由依赖注入（测试隔离用；缺省走真实实现）。 */
export interface HermesRouteDeps {
  streamPrompt?: typeof streamPrompt;
}

/** 组装 gateway 状态（合并进程快照与最近一次补全通道）。 */
async function buildGatewayStatus(): Promise<GatewayStatus> {
  const snapshot = getGatewaySnapshot();
  const detection = await detectHermes();
  const via = getLastCompleteVia();
  const lastError = getLastCompleteError() ?? snapshot.lastError;

  let message: string;
  if (snapshot.running) {
    message = `TUI gateway 运行中（port=${snapshot.port}，connected=${snapshot.connected}）。`;
  } else if (detection.cliPath) {
    message = "TUI gateway 未运行；首次 callModel 时会按需启动。";
  } else {
    message = "未找到 hermes CLI，callModel 将降级为 stub。";
  }

  return {
    running: snapshot.running,
    port: snapshot.port,
    connected: snapshot.connected,
    cliPath: detection.cliPath,
    via,
    lastError,
    message,
  };
}

export async function hermesRoutes(
  app: FastifyInstance,
  deps: HermesRouteDeps = {},
): Promise<void> {
  const runStream = deps.streamPrompt ?? streamPrompt;

  // GET /api/hermes/status —— Hermes 探测结果。
  app.get("/api/hermes/status", async (): Promise<HermesStatus> => {
    const { status } = await getSnapshot();
    return status;
  });

  // GET /api/hermes/gateway —— TUI gateway 状态。
  app.get("/api/hermes/gateway", async (): Promise<GatewayStatus> => {
    return buildGatewayStatus();
  });

  // POST /api/hermes/gateway/start —— 幂等启动 gateway（非破坏性，不强制 confirm）。
  app.post("/api/hermes/gateway/start", async (_request, reply) => {
    const detection = await detectHermes();
    if (!detection.cliPath) {
      reply.code(503);
      return {
        error: "HERMES_CLI_UNAVAILABLE",
        message: "未检测到可用的 hermes CLI，无法启动 gateway。",
      } satisfies ApiError;
    }
    try {
      await ensureGateway(detection.cliPath);
    } catch (error) {
      reply.code(503);
      return {
        error: "GATEWAY_UNAVAILABLE",
        message: `gateway 启动失败：${(error as Error).message}`,
      } satisfies ApiError;
    }
    return buildGatewayStatus();
  });

  // POST /api/hermes/gateway/stop —— 幂等停止由工作台拉起的 gateway。
  app.post("/api/hermes/gateway/stop", async (): Promise<GatewayStatus> => {
    await stopSharedGateway();
    return buildGatewayStatus();
  });

  // POST /api/hermes/chat/stream —— SSE 流式对话（M5.2）。
  // body `{ profile?, prompt }`；逐条推送归一化 ChatStreamEvent；done/error 后结束。
  app.post<{ Body: Partial<ChatStreamRequest> }>(
    "/api/hermes/chat/stream",
    async (request, reply) => {
      const body = request.body ?? ({} as Partial<ChatStreamRequest>);
      const prompt = typeof body.prompt === "string" ? body.prompt : "";
      const profile = typeof body.profile === "string" ? body.profile : undefined;

      if (prompt.trim() === "") {
        reply.code(400);
        return {
          error: "INVALID_VALUE",
          message: "prompt 不能为空。",
        } satisfies ApiError;
      }

      const controller = new AbortController();
      let closed = false;
      // 注意：request.raw 的 "close" 在请求体读完后即触发（会过早中断流），
      // 因此用 reply.raw 的 "close"（响应结束或连接断开）判断真实客户端断开。
      reply.hijack();
      const raw = reply.raw;
      const onClose = (): void => {
        if (raw.writableEnded || closed) return;
        closed = true;
        controller.abort();
      };
      raw.on("close", onClose);

      raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });

      const send = (event: ChatStreamEvent): void => {
        if (closed || raw.writableEnded) return;
        raw.write(`data: ${JSON.stringify(event)}\n\n`);
      };

      try {
        await runStream({
          prompt,
          profile,
          signal: controller.signal,
          onEvent: send,
        });
      } catch (error) {
        const code = (error as { code?: string }).code ?? "INTERNAL_ERROR";
        send({ type: "error", message: (error as Error).message, reason: code });
      } finally {
        raw.off("close", onClose);
        try {
          if (!raw.writableEnded) raw.end();
        } catch {
          // 连接可能已断开。
        }
      }
      return reply;
    },
  );

  // GET /api/health —— 存活探针。
  app.get("/api/health", async (): Promise<{ ok: true; service: string }> => {
    return { ok: true, service: "24h-os-server" };
  });
}
