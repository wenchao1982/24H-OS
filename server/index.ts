import cors from "@fastify/cors";
import Fastify from "fastify";
import type { FastifyError } from "fastify";
import type { ApiError } from "@shared/types";
import { getSnapshot } from "./hermes";
import { onGatewayStatusChange, stopSharedGateway } from "./hermes/gateway";
import { agentRoutes } from "./routes/agents";
import { cronRoutes } from "./routes/cron";
import { hermesRoutes } from "./routes/hermes";
import { skillUiRoutes } from "./routes/skillUi";
import { hookRoutes } from "./routes/hooks";
import { attachDashboardWs, isLoopbackHost, type DashboardWsHandle } from "./routes/ws";
import { broadcast } from "./dashboard/bus";
import { startHookExecutor } from "./hooks/executor";
import {
  resolveWebDistRoot,
  shouldBypassWebToken,
  tryHandleStaticRequest,
} from "./staticWeb";

/**
 * 24H-OS 内核桥接层（Fastify）。
 * 把 Hermes CLI 与 ~/.hermes 文件系统封装成 REST API，供 web/ 前端调用。
 * 端口固定 4319（可用 PORT 覆盖）。
 *
 * 安全基线：
 *   - 默认只监听回环地址 127.0.0.1；
 *   - CORS 仅允许白名单来源（OS_ALLOWED_ORIGINS，逗号分隔）；
 *   - 若监听非回环地址，则强制要求 OS_TOKEN，并校验 x-24os-token 头；
 *   - 统一错误返回结构（ApiError）。
 */

/** 读取整数型环境变量，非法值回退默认。 */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const PORT = envInt("PORT", 4319);
// 默认 127.0.0.1：只在本机可访问，避免无意暴露到局域网。
const HOST = process.env.HOST?.trim() || "127.0.0.1";
const TOKEN = process.env.OS_TOKEN?.trim() || null;

if (!isLoopbackHost(HOST) && !TOKEN) {
  // eslint-disable-next-line no-console
  console.error(
    `[24H-OS] 拒绝启动：HOST=${HOST} 为非回环地址，必须设置 OS_TOKEN 环境变量（用于校验 x-24os-token 头）。`,
  );
  process.exit(1);
}

// 生产静态托管（M2 Electron 外壳前置）：构建产物存在则兼作静态站点；
// 不存在返回 null，行为与纯 API 模式完全一致（dev 不受影响）。
const WEB_DIST_ROOT = resolveWebDistRoot();

// CORS 白名单：默认只放行本地 Vite dev server。
const ALLOWED_ORIGINS = (
  process.env.OS_ALLOWED_ORIGINS ??
  "http://localhost:5173,http://127.0.0.1:5173"
)
  .split(",")
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0);

// 使用 Fastify 内置的 pino logger（不额外引入 pino-pretty，保持依赖最小）。
const app = Fastify({ logger: true });

// 当配置了 OS_TOKEN 时，所有非预检请求都必须带上 x-24os-token。
// 默认（回环监听）可不设置 token，此代码路径依然可用。
// 静态资源例外（仅回环 + 非 /api、/skill-ui 的 GET/HEAD）：浏览器加载
// index.html / assets 无法带自定义头；非回环监听不豁免（安全基线不放松）。
if (TOKEN) {
  app.addHook("onRequest", async (request, reply) => {
    if (request.method === "OPTIONS") return;
    if (
      shouldBypassWebToken(
        request.method,
        request.url,
        WEB_DIST_ROOT,
        isLoopbackHost(HOST),
      )
    ) {
      return;
    }
    if (request.headers["x-24os-token"] !== TOKEN) {
      reply.code(401).send({
        error: "UNAUTHORIZED",
        message: "缺少或无效的 x-24os-token 头。",
      } satisfies ApiError);
    }
  });
}

// 全局错误处理器：统一返回 ApiError 结构。
app.setErrorHandler((error: FastifyError, request, reply) => {
  const status = error.statusCode ?? 500;
  request.log.error(error);
  const payload: ApiError =
    status >= 500
      ? { error: "INTERNAL_ERROR", message: "服务内部错误。" }
      : { error: "REQUEST_ERROR", message: error.message };
  reply.code(status).send(payload);
});

// 未匹配路由：有构建产物时对非 /api、非 /skill-ui 的 GET 做静态/SPA fallback；
// 否则（或保留路径）返回统一 ApiError 结构。
app.setNotFoundHandler(async (request, reply) => {
  const handled = await tryHandleStaticRequest(
    WEB_DIST_ROOT,
    request.method,
    request.url,
    reply,
  );
  if (handled) return;
  const payload: ApiError = {
    error: "NOT_FOUND",
    message: `未找到路由：${request.method} ${request.url}`,
  };
  reply.code(404).send(payload);
});

// 根路由：有构建产物时送 index.html（Electron/部署）；
// 否则给一个简单的服务自述，方便浏览器直接打开确认。
app.get("/", async (request, reply) => {
  if (WEB_DIST_ROOT) {
    const handled = await tryHandleStaticRequest(
      WEB_DIST_ROOT,
      request.method,
      "/",
      reply,
    );
    if (handled) return reply;
  }
  return {
    name: "24H-OS",
    description: "Hermes-centered multi-agent desktop workbench (M4 · Skill UI host)",
    endpoints: [
    "/api/hermes/status",
    "/api/hermes/gateway (GET)",
    "/api/hermes/gateway/start (POST)",
    "/api/hermes/gateway/stop (POST)",
    "/api/hermes/chat/stream (POST, SSE)",
    "/api/hermes/chat/decide (POST)",
    "/api/hermes/subagent (POST, spawn 不支持 → 501)",
    "/api/hermes/subagents (GET) · /:id/tail (GET) · /:id/interrupt|steer (POST) · /pause (POST)",
    "/api/agents",
    "/api/agents/:id",
    "/api/agents (POST install)",
    "/api/agents/:id/update",
    "/api/agents/:id/backup",
    "DELETE /api/agents/:id",
    "/api/agents/:id/config (GET/PATCH)",
    "/api/agents/:id/mcp (POST) · /api/agents/:id/mcp/:name (PATCH/DELETE)",
    "/api/agents/:id/env (POST) · /api/agents/:id/env/:key (DELETE)",
    "/api/agents/:id/config/restore (POST)",
    "/api/agents/:id/skills (POST)",
    "/api/agents/:id/avatar (GET/POST)",
    "/api/market",
    "/api/market/apps/:id (GET)",
    "/api/market/:id/apply (POST)",
    "/api/agents/install (POST)",
    "/api/skill-uis",
    "/api/skill-uis/:id",
    "/api/skill-uis/:id/panel",
    "/skill-ui/:id/*",
    "/api/skill-host/invoke",
    "/api/health",
    "/api/ws (WebSocket)",
    "/api/hooks/log",
    "/api/cron/jobs",
    "/api/cron/jobs (POST, confirm)",
    "/api/cron/jobs/:name/pause|resume|remove|run (POST, confirm)",
    ],
  };
});

/* ---------------- M7 · Dashboard WS + hooks executor + Bot Mode ---------------- */

let wsHandle: DashboardWsHandle | null = null;
const offGatewayStatus = onGatewayStatusChange((phase, detail) => {
  if (phase === "start") {
    broadcast({ type: "gateway.start", payload: { port: detail.port ?? null } });
  } else if (phase === "stop") {
    broadcast({ type: "gateway.stop", payload: {} });
  } else {
    broadcast({
      type: "gateway.error",
      payload: { message: detail.message ?? "gateway error" },
    });
  }
});

// 订阅 app 事件 → 执行 hooks + 广播生命周期。
startHookExecutor();

// 关闭钩子：停止由本进程拉起（或连接）的 TUI gateway，避免残留 hermes serve。
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info(`收到 ${signal}，正在关闭…`);
  try {
    offGatewayStatus();
  } catch {
    // ignore
  }
  try {
    wsHandle?.close();
  } catch {
    // ignore
  }
  try {
    await stopSharedGateway();
  } catch (error) {
    app.log.warn(`停止 gateway 失败：${(error as Error).message}`);
  }
  try {
    await app.close();
  } catch {
    // 忽略关闭期错误。
  }
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

/**
 * 启动流程。
 *
 * 说明：此处不使用顶层 await —— esbuild 打包 `dist/server.cjs`（CJS）不支持
 * 顶层 await，收敛到 main() 后由 `void main()` 触发，行为与原先一致。
 */
async function main(): Promise<void> {
  // CORS 插件 + 路由注册（须在 listen/ready 之前完成）。
  await app.register(cors, {
    origin: ALLOWED_ORIGINS.length > 0 ? ALLOWED_ORIGINS : false,
  });
  await app.register(agentRoutes);
  await app.register(hermesRoutes);
  await app.register(skillUiRoutes);
  await app.register(hookRoutes);
  await app.register(cronRoutes);

  try {
    const snapshot = await getSnapshot();
    app.log.info(
      `Hermes 模式=${snapshot.status.mode} agents=${snapshot.agents.length} available=${snapshot.status.available}`,
    );
    app.log.info(
      `安全基线：host=${HOST} token=${TOKEN ? "已启用" : "未启用"} origins=[${ALLOWED_ORIGINS.join(", ")}]`,
    );
    await app.listen({ port: PORT, host: HOST });

    // listen 之后再挂 WS upgrade（需要底层 server 就绪）。
    wsHandle = attachDashboardWs(app, { host: HOST, token: TOKEN });
    app.log.info(`Dashboard WS 已挂载：ws://${HOST}:${PORT}/api/ws`);

    // eslint-disable-next-line no-console
    console.log(`\n  24H-OS server 已启动：http://${HOST}:${PORT}\n`);
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

void main();
