import type { FastifyInstance, FastifyReply } from "fastify";
import type {
  ApiError,
  CronActionResult,
  CronJobAddRequest,
  CronJobsResponse,
} from "@shared/types";
import {
  addCronJob,
  isCronTickerEnabled,
  listCronJobs,
  pauseCronJob,
  removeCronJob,
  resumeCronJob,
  runCronJob,
  type CronDeps,
} from "../hermes/cron";
import { LifecycleError, statusForCode } from "../hermes/errors";
import { getGatewaySnapshot } from "../hermes/gateway";

/**
 * 官方 Cron 路由（M8）。
 *
 * - GET  /api/cron/jobs                     —— 列出官方 cron jobs（+ ticker 状态）
 * - POST /api/cron/jobs                     —— 新增（**须 confirm:true**）
 * - POST /api/cron/jobs/:name/pause|resume  —— 暂停 / 恢复（须 confirm:true）
 * - POST /api/cron/jobs/:name/remove        —— 删除（须 confirm:true）
 * - POST /api/cron/jobs/:name/run           —— 立即运行一次（须 confirm:true，走 CLI 兜底）
 *
 * 写操作四重保证：confirm 门禁 → 备份（cron.ts）→ 原子性由官方 RPC/CLI 负责 →
 * 响应不回显提示词正文（只回 job 摘要）。
 *
 * 兼容说明：自研 `bots.yaml` / `/api/bots` 已废弃（见 README/docs/CRON.md 迁移）。
 */

/** 可注入依赖（测试 mock cron 实现）。 */
export interface CronRouteDeps extends CronDeps {
  /** 覆盖 cron 实现（测试；可只给部分）。 */
  cron?: Partial<{
    list: typeof listCronJobs;
    add: typeof addCronJob;
    remove: typeof removeCronJob;
    pause: typeof pauseCronJob;
    resume: typeof resumeCronJob;
    run: typeof runCronJob;
  }>;
}

function sendError(reply: FastifyReply, error: unknown): ApiError {
  if (error instanceof LifecycleError) {
    reply.code(statusForCode(error.code));
    return { error: error.code, message: error.message };
  }
  reply.code(500);
  return {
    error: "INTERNAL_ERROR",
    message: error instanceof Error ? error.message : String(error),
  };
}

/** 写操作门禁：`confirm !== true` → CONFIRM_REQUIRED（不触碰磁盘）。 */
export function assertConfirmed(body: { confirm?: unknown } | undefined): void {
  if (!body || body.confirm !== true) {
    throw new LifecycleError(
      "CONFIRM_REQUIRED",
      "写操作需显式 confirm:true（会写入 Hermes cron 配置）。",
    );
  }
}

function parseIncludeDisabled(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "1" || normalized === "true" || normalized === "yes";
  }
  return false;
}

/**
 * 工作台自带的 ticker 是否在跑（`HERMES_DESKTOP=1` 的共享 gateway）。
 *
 * 官方 `cron.manage` 的 `warning` 依据「messaging gateway runtime lock / PID」判断，
 * 会误判我们这种 desktop serve（它确实在 tick）。当我们的 ticker gateway 在跑时，
 * 丢弃该误导性 warning（任务确实会触发）。
 */
function isTickerActive(): boolean {
  return isCronTickerEnabled() && getGatewaySnapshot().running;
}

function buildMessage(result: {
  jobs: unknown[];
  includeDisabled: boolean;
}): string {
  const suffix = result.includeDisabled ? "（含暂停）" : "";
  if (result.jobs.length === 0) {
    return `官方 Cron 中暂无定时任务${suffix}。`;
  }
  return `官方 Cron 共 ${result.jobs.length} 个定时任务${suffix}。`;
}

/** 注册官方 Cron 路由。 */
export async function cronRoutes(
  app: FastifyInstance,
  deps: CronRouteDeps = {},
): Promise<void> {
  const cron = {
    list: listCronJobs,
    add: addCronJob,
    remove: removeCronJob,
    pause: pauseCronJob,
    resume: resumeCronJob,
    run: runCronJob,
    ...deps.cron,
  };

  app.get<{ Querystring: { include_disabled?: string; profile?: string } }>(
    "/api/cron/jobs",
    async (request, reply): Promise<CronJobsResponse | ApiError> => {
      try {
        const includeDisabled = parseIncludeDisabled(
          request.query.include_disabled,
        );
        const result = await cron.list({
          includeDisabled,
          profile: request.query.profile,
          deps,
        });
        const snapshot = getGatewaySnapshot();
        return {
          jobs: result.jobs,
          count: result.count,
          includeDisabled: result.includeDisabled,
          scoped: result.scoped,
          ticker: {
            enabled: isCronTickerEnabled(),
            gatewayRunning: snapshot.running,
            gatewayConnected: snapshot.connected,
          },
          warning: isTickerActive() ? null : result.warning,
          message: buildMessage(result),
        };
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{ Body: CronJobAddRequest }>(
    "/api/cron/jobs",
    async (request, reply): Promise<CronActionResult | ApiError> => {
      try {
        assertConfirmed(request.body);
        const result = await cron.add(
          {
            name: request.body?.name,
            schedule: request.body?.schedule,
            prompt: request.body?.prompt,
            repeat: request.body?.repeat,
            continuity: request.body?.continuity,
            deliver: request.body?.deliver,
            profile: request.body?.profile,
          },
          deps,
        );
        return isTickerActive() ? { ...result, warning: null } : result;
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  for (const [segment, handler] of [
    ["pause", cron.pause],
    ["resume", cron.resume],
    ["remove", cron.remove],
    ["run", cron.run],
  ] as const) {
    app.post<{ Params: { name: string }; Body: { confirm?: boolean } }>(
      `/api/cron/jobs/:name/${segment}`,
      async (request, reply): Promise<CronActionResult | ApiError> => {
        try {
          assertConfirmed(request.body);
          return await handler(request.params.name, deps);
        } catch (error) {
          return sendError(reply, error);
        }
      },
    );
  }
}
