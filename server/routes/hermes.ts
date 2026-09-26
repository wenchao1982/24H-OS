import type { FastifyInstance, FastifyReply } from "fastify";
import type {
  ApiError,
  ChatDecideRequest,
  ChatStreamEvent,
  ChatStreamRequest,
  GatewayStatus,
  HermesStatus,
  SubagentPauseRequest,
  SubagentRunRequest,
  SubagentsResponse,
} from "@shared/types";
import { getSnapshot } from "../hermes";
import { getLastCompleteError, getLastCompleteVia } from "../hermes/complete";
import {
  decideApproval,
  streamPrompt,
  type ChatDecisionInput,
} from "../hermes/chat";
import { detectHermes } from "../hermes/detect";
import {
  LifecycleError,
  statusForCode,
} from "../hermes/errors";
import { ensureGateway, getGatewaySnapshot, stopSharedGateway } from "../hermes/gateway";
import {
  getSubagentSupport,
  interruptSubagent,
  listSubagents,
  runSubagent,
  setSpawnPaused,
  steerSubagent,
  tailSubagent,
  type SubagentDeps,
} from "../hermes/subagent";
import { broadcast } from "../dashboard/bus";
import type { ChatStreamEvent as ChatEvent } from "@shared/types";

/**
 * Hermes 状态路由。
 * 前端顶部状态条据此显示 live / mock、CLI 版本与说明字符串；
 * M5.1 起额外暴露 TUI gateway 的运行状态/启停；
 * M5.2 起提供 SSE 流式对话 `/api/hermes/chat/stream`；
 * M5 交互式：`POST /api/hermes/chat/decide`（审批/澄清决策）+ subagent 研究封装。
 */

/** 路由依赖注入（测试隔离用；缺省走真实实现）。 */
export interface HermesRouteDeps extends SubagentDeps {
  streamPrompt?: typeof streamPrompt;
  decideApproval?: typeof decideApproval;
  runSubagent?: typeof runSubagent;
  listSubagents?: typeof listSubagents;
  interruptSubagent?: typeof interruptSubagent;
  tailSubagent?: typeof tailSubagent;
  steerSubagent?: typeof steerSubagent;
  setSpawnPaused?: typeof setSpawnPaused;
  getSubagentSupport?: typeof getSubagentSupport;
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
  const runDecide = deps.decideApproval ?? decideApproval;
  const runSub = deps.runSubagent ?? runSubagent;
  const runListSub = deps.listSubagents ?? listSubagents;
  const runInterruptSub = deps.interruptSubagent ?? interruptSubagent;
  const runTailSub = deps.tailSubagent ?? tailSubagent;
  const runSteerSub = deps.steerSubagent ?? steerSubagent;
  const runPauseSpawn = deps.setSpawnPaused ?? setSpawnPaused;
  const runSupport = deps.getSubagentSupport ?? getSubagentSupport;

  /** 控制类操作门禁：`confirm !== true` → CONFIRM_REQUIRED（不触碰 gateway）。 */
  const assertConfirmed = (
    body: { confirm?: unknown } | undefined,
    what: string,
  ): void => {
    if (!body || body.confirm !== true) {
      throw new LifecycleError(
        "CONFIRM_REQUIRED",
        `${what}需显式 confirm:true。`,
      );
    }
  };

  /** 统一错误响应（LifecycleError → 码 + HTTP）。 */
  const sendError = (reply: FastifyReply, error: unknown): ApiError => {
    if (error instanceof LifecycleError) {
      reply.code(statusForCode(error.code));
      return { error: error.code, message: error.message };
    }
    reply.code(500);
    return {
      error: "INTERNAL_ERROR",
      message: error instanceof Error ? error.message : String(error),
    };
  };

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

  // POST /api/hermes/chat/stream —— SSE 流式对话（M5.2 → M5 交互式）。
  // body `{ profile?, prompt, chatId?, model? }`；逐条推送归一化 ChatStreamEvent；
  // approval/clarify 挂起等待 POST /api/hermes/chat/decide（interactive 流）。
  app.post<{ Body: Partial<ChatStreamRequest> }>(
    "/api/hermes/chat/stream",
    async (request, reply) => {
      const body = request.body ?? ({} as Partial<ChatStreamRequest>);
      const prompt = typeof body.prompt === "string" ? body.prompt : "";
      const profile = typeof body.profile === "string" ? body.profile : undefined;
      const chatId =
        typeof body.chatId === "string" && body.chatId.trim() !== ""
          ? body.chatId.trim()
          : undefined;
      const model =
        typeof body.model === "string" && body.model.trim() !== ""
          ? body.model.trim()
          : undefined;
      // 昂贵模型二次确认放行（仅显式 true 才透传；见 StreamPromptOptions.force）。
      const force = body.force === true;

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

      // M7：向 Dashboard WS 广播摘要（只含长度/状态，绝不含 prompt/正文）。
      let summaryLen = 0;
      let summaryDone = false;
      const broadcastChat = (
        type: "chat.delta" | "chat.done" | "chat.error",
        len?: number,
      ): void => {
        if (type === "chat.done" || type === "chat.error") {
          if (summaryDone) return;
          summaryDone = true;
        }
        broadcast({
          type,
          payload: {
            ...(profile ? { profile } : {}),
            ...(len !== undefined ? { len } : {}),
          },
        });
      };

      try {
        await runStream({
          prompt,
          profile,
          ...(chatId ? { chatId } : {}),
          ...(model ? { model } : {}),
          ...(force ? { force: true } : {}),
          // SSE 是交互式路径：approval/clarify 挂起待 decide（超时安全兜底）。
          interactive: true,
          signal: controller.signal,
          onEvent: (event: ChatEvent) => {
            send(event);
            if (event.type === "delta") {
              summaryLen += (event.text ?? "").length;
              broadcastChat("chat.delta", summaryLen);
            } else if (event.type === "done") {
              const doneLen = (event.text ?? "").length || summaryLen;
              summaryLen = doneLen;
              broadcastChat("chat.done", doneLen);
            } else if (event.type === "error") {
              broadcastChat("chat.error", summaryLen);
            }
          },
        });
        // 流正常结束但未收到 done/error（如客户端断开导致 interrupted）→ 补一条摘要。
        if (closed || controller.signal.aborted) {
          broadcastChat("chat.error", summaryLen);
        } else {
          broadcastChat("chat.done", summaryLen);
        }
      } catch (error) {
        const code = (error as { code?: string }).code ?? "INTERNAL_ERROR";
        send({ type: "error", message: (error as Error).message, reason: code });
        broadcastChat("chat.error", summaryLen);
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

  // POST /api/hermes/chat/decide —— 回应挂起的 approval / clarify（M5 交互式授权）。
  // body `{ chatId, type: "approval"|"clarify", choice?, answer? }`；
  // 400 非法参数 · 404 CHAT_NOT_FOUND（未知/已结束）· 409 DECISION_RESOLVED（已决）。
  app.post<{ Body: Partial<ChatDecideRequest> }>(
    "/api/hermes/chat/decide",
    async (request, reply): Promise<
      | { ok: true; chatId: string; requestId: string; type: string; decision: Record<string, unknown> }
      | ApiError
    > => {
      const body = request.body ?? ({} as Partial<ChatDecideRequest>);
      const chatId = typeof body.chatId === "string" ? body.chatId : "";
      const type = body.type;
      if (
        chatId.trim() === "" ||
        (type !== "approval" && type !== "clarify")
      ) {
        reply.code(400);
        return {
          error: "INVALID_VALUE",
          message: "需要 chatId 与 type（approval | clarify）。",
        } satisfies ApiError;
      }
      if (
        type === "approval" &&
        body.choice !== undefined &&
        typeof body.choice !== "string"
      ) {
        reply.code(400);
        return {
          error: "INVALID_VALUE",
          message: "choice 必须是字符串。",
        } satisfies ApiError;
      }
      if (
        type === "clarify" &&
        body.answer !== undefined &&
        typeof body.answer !== "string"
      ) {
        reply.code(400);
        return {
          error: "INVALID_VALUE",
          message: "answer 必须是字符串。",
        } satisfies ApiError;
      }
      try {
        const decision: ChatDecisionInput = {
          type,
          ...(typeof body.choice === "string" ? { choice: body.choice } : {}),
          ...(typeof body.answer === "string" ? { answer: body.answer } : {}),
        };
        return runDecide(chatId, decision);
      } catch (error) {
        const code =
          error instanceof LifecycleError ? error.code : null;
        reply.code(code ? statusForCode(code) : 500);
        return {
          error: code ?? "INTERNAL_ERROR",
          message: (error as Error).message,
        } satisfies ApiError;
      }
    },
  );

  // ── subagent 观测/控制（M10）─────────────────────────────────────────
  // 子代理**没有** spawn RPC；由会话内 `delegate_task` 工具创建，经 chat 流透出
  // `subagent.*` 事件。工作台只提供观测/控制薄封装：
  //   GET  /api/hermes/subagents?sessionId=<id>        —— 列出会话活跃子代理（只读）
  //   GET  /api/hermes/subagents/:id/tail?sessionId=   —— 最近 16KB 转录（只读）
  //   POST /api/hermes/subagents/:id/steer            —— 投递 steering（非破坏，不需 confirm）
  //   POST /api/hermes/subagents/:id/interrupt        —— 硬中断（控制面，须 confirm:true）
  //   POST /api/hermes/subagents/pause                —— 全局暂停/恢复 spawn（须 confirm:true）

  app.get<{ Querystring: { sessionId?: string } }>(
    "/api/hermes/subagents",
    async (request, reply): Promise<SubagentsResponse | ApiError> => {
      const sessionId =
        typeof request.query.sessionId === "string" && request.query.sessionId.trim() !== ""
          ? request.query.sessionId.trim()
          : "";
      // 子代理按会话隔离：无 sessionId 无法向官方查询，降级为 0 条（不拉起 gateway）。
      if (sessionId === "") {
        return {
          subagents: [],
          count: 0,
          sessionId: null,
          support: runSupport(),
          message: "子代理按会话隔离；未提供 sessionId，按 0 条返回（如需观测请在 chat 会话内查询）。",
        };
      }
      try {
        return await runListSub(sessionId, deps);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.get<{ Params: { id: string }; Querystring: { sessionId?: string } }>(
    "/api/hermes/subagents/:id/tail",
    async (request, reply) => {
      try {
        return await runTailSub(
          request.query.sessionId,
          request.params.id,
          deps,
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{
    Params: { id: string };
    Body: { sessionId?: string; text?: string };
  }>(
    "/api/hermes/subagents/:id/steer",
    async (request, reply) => {
      try {
        return await runSteerSub(
          request.body?.sessionId,
          request.params.id,
          request.body?.text,
          deps,
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{
    Params: { id: string };
    Body: { sessionId?: string; confirm?: boolean };
  }>(
    "/api/hermes/subagents/:id/interrupt",
    async (request, reply) => {
      try {
        assertConfirmed(request.body, "中断子代理");
        return await runInterruptSub(
          request.body?.sessionId,
          request.params.id,
          deps,
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{ Body: SubagentPauseRequest }>(
    "/api/hermes/subagents/pause",
    async (request, reply) => {
      try {
        assertConfirmed(request.body, "全局暂停子代理 spawn");
        return await runPauseSpawn(request.body?.paused, deps);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  // POST /api/hermes/subagent —— 已废弃的 spawn 入口（M10 语义修正）。
  // 不提供 spawn（子代理由会话内 delegate_task 触发）；返回 501 + 能力说明，不调模型。
  app.post<{ Body: Partial<SubagentRunRequest> }>(
    "/api/hermes/subagent",
    async (request, reply): Promise<
      | {
          ok: boolean;
          spawnApi: boolean;
          code: string;
          message: string;
          contract: import("@shared/types").SubagentSupportInfo;
        }
      | ApiError
    > => {
      const body = request.body ?? ({} as Partial<SubagentRunRequest>);
      try {
        const result = await runSub({
          prompt: typeof body.prompt === "string" ? body.prompt : "",
          ...(typeof body.profile === "string" && body.profile
            ? { profile: body.profile }
            : {}),
        });
        // 无 spawn API：固定 501 + 说明（不依赖具体 code）。
        reply.code(501);
        return result;
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  // GET /api/health —— 存活探针。
  app.get("/api/health", async (): Promise<{ ok: true; service: string }> => {
    return { ok: true, service: "24h-os-server" };
  });
}
