import cors from "@fastify/cors";
import Fastify from "fastify";
import type { FastifyError } from "fastify";
import type { ApiError } from "@shared/types";
import { getSnapshot } from "./hermes";
import { stopSharedGateway } from "./hermes/gateway";
import { agentRoutes } from "./routes/agents";
import { hermesRoutes } from "./routes/hermes";
import { skillUiRoutes } from "./routes/skillUi";

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

/** 是否为回环地址。 */
function isLoopbackHost(host: string): boolean {
  const normalized = host.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "localhost" ||
    normalized === "::1"
  );
}

if (!isLoopbackHost(HOST) && !TOKEN) {
  // eslint-disable-next-line no-console
  console.error(
    `[24H-OS] 拒绝启动：HOST=${HOST} 为非回环地址，必须设置 OS_TOKEN 环境变量（用于校验 x-24os-token 头）。`,
  );
  process.exit(1);
}

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

await app.register(cors, {
  origin: ALLOWED_ORIGINS.length > 0 ? ALLOWED_ORIGINS : false,
});

// 当配置了 OS_TOKEN 时，所有非预检请求都必须带上 x-24os-token。
// 默认（回环监听）可不设置 token，此代码路径依然可用。
if (TOKEN) {
  app.addHook("onRequest", async (request, reply) => {
    if (request.method === "OPTIONS") return;
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

// 未匹配路由也返回统一结构。
app.setNotFoundHandler((request, reply) => {
  const payload: ApiError = {
    error: "NOT_FOUND",
    message: `未找到路由：${request.method} ${request.url}`,
  };
  reply.code(404).send(payload);
});

// 注册路由。
await app.register(agentRoutes);
await app.register(hermesRoutes);
await app.register(skillUiRoutes);

// 根路由：给一个简单的服务自述，方便浏览器直接打开确认。
app.get("/", async () => ({
  name: "24H-OS",
  description: "Hermes-centered multi-agent desktop workbench (M4 · Skill UI host)",
  endpoints: [
    "/api/hermes/status",
    "/api/hermes/gateway (GET)",
    "/api/hermes/gateway/start (POST)",
    "/api/hermes/gateway/stop (POST)",
    "/api/hermes/chat/stream (POST, SSE)",
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
    "/api/market",
    "/api/skill-uis",
    "/api/skill-uis/:id",
    "/api/skill-uis/:id/panel",
    "/skill-ui/:id/*",
    "/api/skill-host/invoke",
    "/api/health",
  ],
}));

// 关闭钩子：停止由本进程拉起（或连接）的 TUI gateway，避免残留 hermes serve。
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info(`收到 ${signal}，正在关闭…`);
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

try {
  const snapshot = await getSnapshot();
  app.log.info(
    `Hermes 模式=${snapshot.status.mode} agents=${snapshot.agents.length} available=${snapshot.status.available}`,
  );
  app.log.info(
    `安全基线：host=${HOST} token=${TOKEN ? "已启用" : "未启用"} origins=[${ALLOWED_ORIGINS.join(", ")}]`,
  );
  await app.listen({ port: PORT, host: HOST });
  // eslint-disable-next-line no-console
  console.log(`\n  24H-OS server 已启动：http://${HOST}:${PORT}\n`);
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
