import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CronActionResult, CronJob } from "@shared/types";
import { broadcast as defaultBroadcast } from "../dashboard/bus";
import { detectHermes } from "./detect";
import { lifecycleError } from "./errors";

/**
 * 官方 Cron 薄封装（M8）。
 *
 * 定时**完全交给 Hermes 官方 Cron**：工作台不再自带调度器，只做：
 *   1. `cron.manage` RPC 薄封装（list / add / remove / pause / resume）；
 *   2. 订阅官方 `cron.changed` 事件 → 失效列表缓存 + 经 Dashboard WS 广播；
 *   3. 让 `hermes serve` 带 `HERMES_DESKTOP=1` 以启用官方内置 ticker（见 gateway.ts）。
 *
 * 契约来源（只读参考，未修改）：
 *   ~/hermes-desktop/home/hermes-agent/tui_gateway/contracts/tools_commands.py
 *     → `CronManageParams` / `CronJobRow` / `cron.manage`（scope 5023）；
 *   ~/hermes-desktop/home/hermes-agent/tui_gateway/methods_tools.py:1060
 *     → handler：list/add/remove/pause/resume 直通 `tools.cronjob_tools.cronjob`；
 *   ~/hermes-desktop/home/hermes-agent/tui_gateway/contracts/events.py:683
 *     → `cron.changed`（监听 cron/jobs.json mtime）。
 *
 * 安全：spawn CLI 一律 shell:false + `stdio[0]="ignore"`（等效 `</dev/null`，防交互挂死）+ 超时。
 */

/** `cron.manage` 可用的动作（官方 CronAction）。 */
export type CronAction = "list" | "add" | "remove" | "pause" | "resume";

/** 任务名/名字段格式（与仓库 id 约定一致）。 */
export const CRON_JOB_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const MAX_SCHEDULE_LENGTH = 200;
const MAX_PROMPT_LENGTH = 8192;
const MAX_DELIVER_LENGTH = 200;
const MAX_BACKUPS_PER_FILE = 10;

/** gateway 客户端的最小结构（`GatewayClient` 天然满足）。 */
export interface CronRpcClient {
  call<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ): Promise<T>;
  onEvent(handler: (params: Record<string, unknown>) => void): () => void;
}

/** 广播函数（`dashboard/bus.broadcast` 的同形）。 */
export type CronBroadcast = (event: {
  type: string;
  at?: string;
  payload?: Record<string, unknown>;
}) => void;

/** 依赖注入（测试用；生产全部走默认）。 */
export interface CronDeps {
  /** 直接注入客户端（测试）。 */
  client?: CronRpcClient;
  /** 客户端解析函数（默认 detectHermes + ensureGateway）。 */
  getClient?: () => Promise<CronRpcClient>;
  /** 广播实现（默认 dashboard/bus）。 */
  broadcast?: CronBroadcast;
  /** 当前时间（缓存 TTL / 备份文件名用）。 */
  now?: () => number;
  /** 列表缓存 TTL（毫秒）；缺省读 OS_CRON_CACHE_TTL_MS，默认 2000。 */
  cacheTtlMs?: number;
  /** active home（备份源）；缺省 detectHermes().activeHome。 */
  home?: string;
  /** 备份根目录；缺省读 OS_BACKUP_DIR，默认 ~/.24os/backups。 */
  backupDir?: string;
  /** 跳过写前备份（测试）。 */
  skipBackup?: boolean;
  /** CLI 路径（run-now）；缺省 detectHermes().cliPath。 */
  cliPath?: string | null;
  /** CLI 超时（毫秒），默认 60000。 */
  timeoutMs?: number;
  /** 注入 run-now 执行体（测试）。 */
  runCli?: (name: string) => Promise<void>;
  /** 列表缓存开关，默认 true。 */
  useCache?: boolean;
}

/** list 结果（结构贴近官方）。 */
export interface CronListResult {
  jobs: CronJob[];
  count: number;
  scoped: string | null;
  includeDisabled: boolean;
  warning: string | null;
}

/** 写前备份结果。 */
export interface CronBackupResult {
  backedUp: boolean;
  path: string | null;
}

/* ------------------------------------------------------------------ *
 * 缓存 + 事件订阅
 * ------------------------------------------------------------------ */

interface ListCacheEntry {
  key: string;
  at: number;
  value: CronListResult;
}

let listCache: ListCacheEntry | null = null;

/** 已订阅 `cron.changed` 的客户端（避免重复订阅）。 */
const subscribedClients = new WeakSet<object>();

/** 失效列表缓存（`cron.changed` / 任意写操作后调用）。 */
export function invalidateCronCache(): void {
  listCache = null;
}

/** 清空模块内状态（测试）。 */
export function resetCronState(): void {
  listCache = null;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** 转发 `cron.changed` → 失效缓存 + Dashboard WS 广播（幂等，按客户端去重）。 */
export function attachCronListener(client: CronRpcClient, deps: CronDeps = {}): void {
  if (subscribedClients.has(client as object)) return;
  subscribedClients.add(client as object);
  const emit = deps.broadcast ?? defaultBroadcast;
  client.onEvent((params) => {
    if (params.type !== "cron.changed") return;
    invalidateCronCache();
    emit({ type: "cron.changed", payload: { source: "hermes" } });
  });
}

/** 默认客户端：detectHermes → ensureGateway（复用共享 gateway）。 */
async function defaultGetClient(): Promise<CronRpcClient> {
  const detection = await detectHermes();
  if (!detection.cliPath) {
    throw lifecycleError(
      "CRON_UNAVAILABLE",
      "未检测到可用的 hermes CLI，无法访问官方 Cron。",
    );
  }
  // 动态 import 避免与 gateway 模块的潜在循环依赖。
  const { ensureGateway } = await import("./gateway");
  const entry = await ensureGateway(detection.cliPath);
  return entry.client;
}

/** 把 gateway / 官方错误归一化为结构化 Cron 错误。 */
function toCronError(error: unknown): Error {
  const code = (error as { code?: string } | null)?.code;
  if (code === "GATEWAY_RPC_ERROR" || code === "CRON_RPC_ERROR") {
    return lifecycleError(
      "CRON_RPC_ERROR",
      `官方 Cron 返回错误：${(error as Error).message}`,
    );
  }
  if (
    code === "GATEWAY_UNAVAILABLE" ||
    code === "GATEWAY_TIMEOUT" ||
    code === "HERMES_CLI_UNAVAILABLE" ||
    code === "CRON_UNAVAILABLE"
  ) {
    return lifecycleError(
      "CRON_UNAVAILABLE",
      `无法连接官方 Cron：${(error as Error).message}`,
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

/** 把官方 tool-level 失败（result.error / success:false）转成结构化错误。 */
function assertOfficialSuccess(result: Record<string, unknown>): void {
  if (result.success === false || typeof result.error === "string") {
    const message = String(result.error ?? "官方 Cron 操作失败。");
    const code = /not found|no such|unknown job|不存在/i.test(message)
      ? "CRON_JOB_NOT_FOUND"
      : "CRON_RPC_ERROR";
    throw lifecycleError(code, message);
  }
}

async function callCron(
  action: CronAction,
  params: Record<string, unknown>,
  deps: CronDeps,
): Promise<Record<string, unknown>> {
  const client = deps.client ?? (await (deps.getClient ?? defaultGetClient)());
  attachCronListener(client, deps);
  try {
    const result = await client.call<Record<string, unknown>>("cron.manage", {
      action,
      ...params,
    });
    return result && typeof result === "object" ? result : {};
  } catch (error) {
    throw toCronError(error);
  }
}

function normalizeJob(raw: unknown): CronJob {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const jobId =
    typeof obj.job_id === "string"
      ? obj.job_id
      : typeof obj.id === "string"
        ? obj.id
        : "";
  return {
    ...obj,
    job_id: jobId,
    id: typeof obj.id === "string" ? obj.id : jobId,
    name: typeof obj.name === "string" ? obj.name : "",
    schedule: typeof obj.schedule === "string" ? obj.schedule : "?",
    prompt_preview: typeof obj.prompt_preview === "string" ? obj.prompt_preview : "",
    enabled: obj.enabled !== false,
  } as CronJob;
}

/* ------------------------------------------------------------------ *
 * 参数校验
 * ------------------------------------------------------------------ */

/** 校验任务名（`^[a-z0-9][a-z0-9_-]{0,63}$`），返回 trim 后的值。 */
export function validateCronName(name: unknown): string {
  const value = typeof name === "string" ? name.trim() : "";
  if (!value || !CRON_JOB_NAME_PATTERN.test(value)) {
    throw lifecycleError(
      "INVALID_NAME",
      `非法任务名：${String(name)}（需匹配 ^[a-z0-9][a-z0-9_-]{0,63}$）`,
    );
  }
  return value;
}

function validateSchedule(schedule: unknown): string {
  const value = typeof schedule === "string" ? schedule.trim() : "";
  if (!value) throw lifecycleError("INVALID_VALUE", "schedule 不能为空。");
  if (value.length > MAX_SCHEDULE_LENGTH || /[\r\n\0]/.test(value)) {
    throw lifecycleError("INVALID_VALUE", "schedule 含非法字符或过长。");
  }
  return value;
}

function validatePrompt(prompt: unknown): string {
  const value = typeof prompt === "string" ? prompt : "";
  if (!value.trim()) throw lifecycleError("INVALID_VALUE", "prompt 不能为空。");
  if (value.length > MAX_PROMPT_LENGTH) {
    throw lifecycleError("INVALID_VALUE", `prompt 过长（>${MAX_PROMPT_LENGTH}）。`);
  }
  return value;
}

function validateProfile(profile: unknown): string | undefined {
  if (profile === undefined || profile === null || profile === "") return undefined;
  const value = String(profile).trim();
  if (!PROFILE_NAME_PATTERN.test(value)) {
    throw lifecycleError("INVALID_NAME", `非法 profile：${value}`);
  }
  return value;
}

function validateDeliver(deliver: unknown): string | undefined {
  if (deliver === undefined || deliver === null || deliver === "") return undefined;
  const value = String(deliver).trim();
  if (value.length > MAX_DELIVER_LENGTH || /[\r\n\0]/.test(value)) {
    throw lifecycleError("INVALID_VALUE", "deliver 含非法字符或过长。");
  }
  return value;
}

/* ------------------------------------------------------------------ *
 * list / add / remove / pause / resume / run
 * ------------------------------------------------------------------ */

/** 列出官方 cron jobs（带 TTL 缓存）。 */
export async function listCronJobs(
  options: { includeDisabled?: boolean; profile?: string; deps?: CronDeps } = {},
): Promise<CronListResult> {
  const deps = options.deps ?? {};
  const includeDisabled = options.includeDisabled ?? false;
  const profile = validateProfile(options.profile);
  const ttl = deps.cacheTtlMs ?? envInt("OS_CRON_CACHE_TTL_MS", 2000);
  const now = deps.now?.() ?? Date.now();
  const key = `${includeDisabled ? "1" : "0"}|${profile ?? ""}`;

  if (
    deps.useCache !== false &&
    listCache &&
    listCache.key === key &&
    now - listCache.at < ttl
  ) {
    return listCache.value;
  }

  const params: Record<string, unknown> = { include_disabled: includeDisabled };
  if (profile) params.profile = profile;
  const result = await callCron("list", params, deps);
  assertOfficialSuccess(result);

  const rawJobs = Array.isArray(result.jobs) ? result.jobs : [];
  const jobs = rawJobs.map(normalizeJob);
  const value: CronListResult = {
    jobs,
    count: typeof result.count === "number" ? result.count : jobs.length,
    scoped: typeof result.scoped === "string" ? result.scoped : profile ?? null,
    includeDisabled,
    warning: typeof result.warning === "string" ? result.warning : null,
  };
  if (deps.useCache !== false) listCache = { key, at: now, value };
  return value;
}

/** 新增任务（官方 `Action.create`）。 */
export async function addCronJob(
  input: {
    name: unknown;
    schedule: unknown;
    prompt: unknown;
    repeat?: unknown;
    continuity?: unknown;
    deliver?: unknown;
    profile?: unknown;
  },
  deps: CronDeps = {},
): Promise<CronActionResult> {
  const name = validateCronName(input.name);
  const schedule = validateSchedule(input.schedule);
  const prompt = validatePrompt(input.prompt);
  const profile = validateProfile(input.profile);
  const deliver = validateDeliver(input.deliver);

  const repeat =
    typeof input.repeat === "number" && Number.isFinite(input.repeat)
      ? Math.trunc(input.repeat)
      : undefined;
  if (repeat !== undefined && repeat < 1) {
    throw lifecycleError("INVALID_VALUE", "repeat 必须是正整数。");
  }

  await backupCronStore(profile, deps);

  const params: Record<string, unknown> = { name, schedule, prompt };
  if (repeat !== undefined) params.repeat = repeat;
  if (typeof input.continuity === "boolean") params.continuity = input.continuity;
  if (deliver) params.deliver = deliver;
  if (profile) params.profile = profile;

  const result = await callCron("add", params, deps);
  assertOfficialSuccess(result);
  invalidateCronCache();
  return {
    ok: true,
    action: "add",
    jobId: typeof result.job_id === "string" ? result.job_id : undefined,
    name: typeof result.name === "string" ? result.name : name,
    schedule: typeof result.schedule === "string" ? result.schedule : schedule,
    nextRunAt:
      typeof result.next_run_at === "string" ? result.next_run_at : null,
    warning: typeof result.warning === "string" ? result.warning : null,
    message: typeof result.message === "string" ? result.message : undefined,
  };
}

/** 删除任务（官方 `Action.remove`，按 name/id）。 */
export async function removeCronJob(
  name: unknown,
  deps: CronDeps = {},
): Promise<CronActionResult> {
  const id = validateCronName(name);
  await backupCronStore(undefined, deps);
  const result = await callCron("remove", { name: id }, deps);
  assertOfficialSuccess(result);
  invalidateCronCache();
  const removed = (result.removed_job ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    action: "remove",
    jobId: typeof removed.id === "string" ? removed.id : undefined,
    name: typeof removed.name === "string" ? removed.name : id,
    schedule: typeof removed.schedule === "string" ? removed.schedule : undefined,
    message: `已删除任务 ${id}`,
  };
}

/** 暂停任务（官方 `Action.pause`）。 */
export async function pauseCronJob(
  name: unknown,
  deps: CronDeps = {},
): Promise<CronActionResult> {
  const id = validateCronName(name);
  await backupCronStore(undefined, deps);
  const result = await callCron("pause", { name: id }, deps);
  assertOfficialSuccess(result);
  invalidateCronCache();
  const job = (result.job ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    action: "pause",
    jobId: typeof job.job_id === "string" ? job.job_id : undefined,
    name: typeof job.name === "string" ? job.name : id,
    message: `已暂停任务 ${id}`,
  };
}

/** 恢复任务（官方 `Action.resume`）。 */
export async function resumeCronJob(
  name: unknown,
  deps: CronDeps = {},
): Promise<CronActionResult> {
  const id = validateCronName(name);
  await backupCronStore(undefined, deps);
  const result = await callCron("resume", { name: id }, deps);
  assertOfficialSuccess(result);
  invalidateCronCache();
  const job = (result.job ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    action: "resume",
    jobId: typeof job.job_id === "string" ? job.job_id : undefined,
    name: typeof job.name === "string" ? job.name : id,
    nextRunAt: typeof job.next_run_at === "string" ? job.next_run_at : null,
    message: `已恢复任务 ${id}`,
  };
}

/**
 * 立即运行一次（官方 RPC 没有 run 动作；走 CLI `hermes cron run <name>` 兜底）。
 * CLI：shell:false + stdin=ignore（等效 `</dev/null`）+ 超时。
 */
export async function runCronJob(
  name: unknown,
  deps: CronDeps = {},
): Promise<CronActionResult> {
  const id = validateCronName(name);
  await backupCronStore(undefined, deps);

  if (deps.runCli) {
    await deps.runCli(id);
  } else {
    const cliPath =
      deps.cliPath === undefined
        ? (await detectHermes()).cliPath
        : deps.cliPath;
    if (!cliPath) {
      throw lifecycleError(
        "CRON_UNAVAILABLE",
        "未检测到可用的 hermes CLI，无法立即运行任务。",
      );
    }
    await runCronCli(cliPath, id, deps.timeoutMs ?? 60_000);
  }
  invalidateCronCache();
  return {
    ok: true,
    action: "run",
    name: id,
    message: `已触发任务 ${id}（下一次 tick 执行 / 已立即执行）。`,
  };
}

/* ------------------------------------------------------------------ *
 * CLI 兜底（run-now）
 * ------------------------------------------------------------------ */

/** 执行 `hermes cron run <name>`；失败抛结构化错误。 */
async function runCronCli(
  cliPath: string,
  name: string,
  timeoutMs: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cliPath, ["cron", "run", name], {
      shell: false,
      windowsHide: true,
      // stdin=ignore 等效 `</dev/null`：无 TTY 交互也绝不挂死。
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        lifecycleError("CRON_UNAVAILABLE", `无法启动 hermes cron：${error.message}`),
      );
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        reject(
          lifecycleError(
            "CRON_RPC_ERROR",
            `hermes cron run 超时（>${timeoutMs}ms）：${stderr.join("").trim()}`,
          ),
        );
        return;
      }
      if (code !== 0) {
        reject(
          lifecycleError(
            "CRON_RPC_ERROR",
            `hermes cron run 失败（code=${code}）：${stderr.join("").trim() || stdout.join("").trim()}`,
          ),
        );
        return;
      }
      resolve();
    });
  });
}

/* ------------------------------------------------------------------ *
 * 写前备份（四重保证之一；原子性由官方 RPC/CLI 负责）
 * ------------------------------------------------------------------ */

/** 默认备份根目录（与 lifecycle 一致）。 */
function defaultBackupDir(): string {
  return (
    process.env.OS_BACKUP_DIR ?? path.join(os.homedir(), ".24os", "backups")
  );
}

/** cron store 文件路径（per profile 或 active home）。 */
export function resolveCronJobsFile(home: string, profile?: string): string {
  return profile
    ? path.join(home, "profiles", profile, "cron", "jobs.json")
    : path.join(home, "cron", "jobs.json");
}

/**
 * 备份官方 cron store（`cron/jobs.json`）。
 * 文件不存在 → {backedUp:false}（首次 add 属于正常情形）；最多保留 10 份。
 */
export function backupCronStoreFile(
  opts: { home: string; profile?: string; backupDir?: string; now?: () => number },
): CronBackupResult {
  const source = resolveCronJobsFile(opts.home, opts.profile);
  if (!existsSync(source)) return { backedUp: false, path: null };

  const dir = path.join(opts.backupDir ?? defaultBackupDir(), "cron");
  try {
    mkdirSync(dir, { recursive: true });
    const stamp = new Date(opts.now?.() ?? Date.now())
      .toISOString()
      .replace(/[:.]/g, "-");
    const prefix = opts.profile ? `${opts.profile}-` : "";
    const dest = path.join(dir, `${prefix}jobs-${stamp}.json`);
    copyFileSync(source, dest);

    // 同前缀仅保留最近 10 份（按 mtime）。
    const files = readdirSync(dir)
      .filter((file) => file.startsWith(`${prefix}jobs-`) && file.endsWith(".json"))
      .map((file) => {
        const full = path.join(dir, file);
        return { file, full, mtime: statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    for (const extra of files.slice(MAX_BACKUPS_PER_FILE)) {
      try {
        rmSync(extra.full, { force: true });
      } catch {
        // 清理失败不影响主流程。
      }
    }
    return { backedUp: true, path: dest };
  } catch {
    // 备份是尽力而为，不阻塞官方写入。
    return { backedUp: false, path: null };
  }
}

/** 解析 active home 后备份（写操作前调用，尽力而为）。 */
async function backupCronStore(
  profile: string | undefined,
  deps: CronDeps,
): Promise<CronBackupResult> {
  if (deps.skipBackup) return { backedUp: false, path: null };
  try {
    const home = deps.home ?? (await detectHermes()).activeHome;
    return backupCronStoreFile({
      home,
      profile,
      backupDir: deps.backupDir,
      now: deps.now,
    });
  } catch {
    return { backedUp: false, path: null };
  }
}

/** 是否启用官方 ticker（OS_CRON_TICKER !== "0"）。 */
export function isCronTickerEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.OS_CRON_TICKER !== "0";
}
