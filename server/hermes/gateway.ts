import { spawn, type ChildProcess } from "node:child_process";
import WebSocket from "ws";
import { lifecycleError } from "./errors";

/**
 * Hermes TUI gateway 客户端（M5.1）。
 *
 * `hermes serve` 会启动一个 JSON-RPC over WebSocket 的后端：
 *   - stdout 打印 `HERMES_BACKEND_READY port=<N>` 表示就绪；
 *   - `GET /` 的 HTML 里以 `__HERMES_SESSION_TOKEN__` 注入每进程 SESSION_TOKEN；
 *   - WS 端点为 `ws://127.0.0.1:<port>/api/ws?token=<token>`；
 *   - 帧格式：请求 `{jsonrpc:"2.0", id, method, params}`，
 *     响应 `{jsonrpc:"2.0", id, result|error}`，
 *     通知 `{jsonrpc:"2.0", method:"event", params:{type, session_id, payload?}}`。
 *
 * 契约来源（只读参考，未修改）：
 *   ~/hermes-desktop/home/hermes-agent/tui_gateway/server.py（_ok/_err/事件帧）
 *   ~/hermes-desktop/home/hermes-agent/tui_gateway/contracts/liveness.py（ping / gateway.capabilities）
 *   ~/hermes-desktop/home/hermes-agent/tui_gateway/contracts/tools_mcp_plugins.py（tools.list）
 *   ~/hermes-desktop/home/hermes-agent/tui_gateway/contracts/sessions.py（llm.oneshot）
 *   ~/hermes-desktop/home/hermes-agent/scripts/iso-certify.py（WS 客户端样例）
 *
 * 安全：spawn 一律 shell:false，参数以数组传递；`serve` 不走 runHermes 白名单（单独实现）。
 */

/** spawnGateway 选项。 */
export interface SpawnGatewayOptions {
  /** hermes CLI 绝对路径。 */
  cliPath: string;
  /** 监听端口；缺省读 OS_GATEWAY_PORT，仍无则 0（由 OS 自选）。 */
  port?: number;
  /** 是否加 `--isolated`；缺省读 OS_GATEWAY_ISOLATED==="1"。 */
  isolated?: boolean;
  /** 是否加 `--skip-build`；缺省 true。 */
  skipBuild?: boolean;
  /** 就绪等待超时（毫秒）；缺省读 OS_GATEWAY_START_TIMEOUT_MS，默认 30000。 */
  startTimeoutMs?: number;
  /** 追加/覆盖环境变量。 */
  env?: NodeJS.ProcessEnv;
}

/** 已启动的 gateway 句柄。 */
export interface GatewayHandle {
  /** 实际监听端口（从 READY 行解析）。 */
  port: number;
  /** 子进程。 */
  proc: ChildProcess;
  /** 子进程退出（code）。 */
  exited: Promise<number | null>;
  /** 优雅停止（SIGTERM → 超时 SIGKILL）。 */
  stop(): Promise<void>;
}

/** 从一段文本里解析 `HERMES_BACKEND_READY port=<N>`，无则 null。 */
export function parseBackendReadyLine(text: string): number | null {
  const match = /HERMES_BACKEND_READY\s+port=(\d+)/.exec(text);
  if (!match) return null;
  const port = Number(match[1]);
  return Number.isInteger(port) && port > 0 ? port : null;
}

/** 从 HTML 片段里解析 `__HERMES_SESSION_TOKEN__` 的值，无则 null。 */
export function parseSessionToken(html: string): string | null {
  const match = /__HERMES_SESSION_TOKEN__\s*=\s*"((?:\\.|[^"\\])*)"/.exec(html);
  return match ? match[1] : null;
}

/** 读取整数型环境变量，非法值回退默认。 */
function envInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** 停止子进程：SIGTERM，超时后 SIGKILL。 */
async function stopProcess(proc: ChildProcess, timeoutMs = 8000): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // 进程可能已退出。
      }
      finish();
    }, timeoutMs);
    proc.once("exit", finish);
    try {
      proc.kill("SIGTERM");
    } catch {
      finish();
    }
  });
}

/**
 * 启动 gateway 并等待 `HERMES_BACKEND_READY`。
 * 失败时抛 GATEWAY_UNAVAILABLE / GATEWAY_TIMEOUT。
 */
export async function spawnGateway(
  options: SpawnGatewayOptions,
): Promise<GatewayHandle> {
  const env = options.env ?? process.env;
  const port = options.port ?? envInt(env, "OS_GATEWAY_PORT", 0);
  const isolated = options.isolated ?? env.OS_GATEWAY_ISOLATED === "1";
  const skipBuild = options.skipBuild ?? true;
  const startTimeoutMs =
    options.startTimeoutMs ?? envInt(env, "OS_GATEWAY_START_TIMEOUT_MS", 30_000);

  const args = ["serve", "--host", "127.0.0.1", "--port", String(port)];
  if (skipBuild) args.push("--skip-build");
  if (isolated) args.push("--isolated");

  const proc = spawn(options.cliPath, args, {
    shell: false,
    env,
    windowsHide: true,
  });

  let output = "";
  let exited: (code: number | null) => void = () => undefined;
  const exitedPromise = new Promise<number | null>((resolve) => {
    exited = resolve;
  });

  return await new Promise<GatewayHandle>((resolve, reject) => {
    let settled = false;
    const settle = (
      fn: () => void,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      settle(() => {
        void stopProcess(proc, 2000);
        reject(
          lifecycleError(
            "GATEWAY_TIMEOUT",
            `gateway 启动超时（>${startTimeoutMs}ms）：hermes ${args.join(" ")}`,
          ),
        );
      });
    }, startTimeoutMs);

    const onData = (chunk: Buffer): void => {
      output += chunk.toString("utf8");
      const readyPort = parseBackendReadyLine(output);
      if (readyPort !== null) {
        settle(() => {
          resolve({
            port: readyPort,
            proc,
            exited: exitedPromise,
            stop: () => stopProcess(proc),
          });
        });
      }
    };

    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);

    proc.on("error", (error) => {
      settle(() =>
        reject(
          lifecycleError(
            "GATEWAY_UNAVAILABLE",
            `无法启动 gateway 进程：${error.message}`,
          ),
        ),
      );
    });

    proc.on("exit", (code) => {
      exited(code);
      settle(() =>
        reject(
          lifecycleError(
            "GATEWAY_UNAVAILABLE",
            `gateway 进程在就绪前退出（code=${code}）：${output.slice(-400)}`,
          ),
        ),
      );
    });
  });
}

/** 拉取 `GET /` 并解析 SESSION_TOKEN；失败返回 null。 */
export async function extractSessionToken(
  port: number,
  timeoutMs = 10_000,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      signal: controller.signal,
    });
    const html = await response.text();
    return parseSessionToken(html);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** GatewayClient 选项。 */
export interface GatewayClientOptions {
  port: number;
  token: string;
  host?: string;
  /** 建连超时（毫秒），默认 10000。 */
  connectTimeoutMs?: number;
  /** RPC 默认超时（毫秒），默认 30000。 */
  defaultTimeoutMs?: number;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** gateway 事件通知处理函数。 */
export type GatewayEventHandler = (
  params: Record<string, unknown>,
) => void;

/**
 * 一个 gateway WebSocket 连接：按 id 关联 JSON-RPC 请求/响应，
 * 并把 `method:"event"` 通知分发给订阅者。
 */
export class GatewayClient {
  private readonly port: number;
  private readonly token: string;
  private readonly host: string;
  private readonly connectTimeoutMs: number;
  private readonly defaultTimeoutMs: number;

  private ws: WebSocket | null = null;
  private nextId = 0;
  private readonly pending = new Map<string, PendingCall>();
  private readonly eventHandlers = new Set<GatewayEventHandler>();

  constructor(options: GatewayClientOptions) {
    this.port = options.port;
    this.token = options.token;
    this.host = options.host ?? "127.0.0.1";
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
  }

  /** WS 是否已连接。 */
  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /** 建立 WS 连接。 */
  connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const url = `ws://${this.host}:${this.port}/api/ws?token=${encodeURIComponent(this.token)}`;
      const ws = new WebSocket(url);
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          ws.terminate();
        } catch {
          // ignore
        }
        reject(lifecycleError("GATEWAY_TIMEOUT", `gateway WS 连接超时：${url}`));
      }, this.connectTimeoutMs);

      ws.on("open", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.ws = ws;
        resolve();
      });

      ws.on("message", (data: WebSocket.RawData) => this.handleMessage(data));

      ws.on("error", (error: Error) => {
        if (settled) {
          this.rejectAll(
            lifecycleError("GATEWAY_UNAVAILABLE", `gateway WS 错误：${error.message}`),
          );
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(
          lifecycleError("GATEWAY_UNAVAILABLE", `gateway WS 连接失败：${error.message}`),
        );
      });

      ws.on("close", () => {
        clearTimeout(timer);
        this.rejectAll(
          lifecycleError("GATEWAY_UNAVAILABLE", "gateway WS 已关闭。"),
        );
      });
    });
  }

  /** 订阅事件通知，返回取消订阅函数。 */
  onEvent(handler: GatewayEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  /** 发送一次 JSON-RPC 调用并按 id 等待结果。 */
  call<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    options: { timeoutMs?: number } = {},
  ): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(
        lifecycleError("GATEWAY_UNAVAILABLE", "gateway WS 未连接，无法调用。"),
      );
    }
    const id = `c${++this.nextId}`;
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          lifecycleError(
            "GATEWAY_TIMEOUT",
            `gateway RPC 超时（>${timeoutMs}ms）：${method}`,
          ),
        );
      }, timeoutMs);

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      try {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(
          lifecycleError(
            "GATEWAY_UNAVAILABLE",
            `gateway 发送失败：${(error as Error).message}`,
          ),
        );
      }
    });
  }

  /** 最轻量存活探测。 */
  async ping(): Promise<{ pong: boolean }> {
    return await this.call<{ pong: boolean }>("ping", {}, { timeoutMs: 5000 });
  }

  /** 查询本构建能力。 */
  async capabilities(): Promise<{ per_session_exclusive_submit: boolean }> {
    return await this.call<{ per_session_exclusive_submit: boolean }>(
      "gateway.capabilities",
      {},
      { timeoutMs: 5000 },
    );
  }

  /** 列出 toolsets。 */
  async toolsList(): Promise<unknown> {
    return await this.call("tools.list", {});
  }

  /**
   * 单次文本补全。
   *
   * 实测契约（llm.oneshot）：params `{ input, template?, instructions?, task?,
   * max_tokens?, temperature?, session_id?, profile? }` → result `{ text }`。
   * 这里把 prompt 作为 user input 传入（无 session 时用 task 后端）。
   */
  async complete(
    prompt: string,
    options: { profile?: string; timeoutMs?: number; maxTokens?: number } = {},
  ): Promise<{ text: string }> {
    const params: Record<string, unknown> = {
      input: prompt,
      max_tokens: options.maxTokens ?? 1024,
      temperature: 0.3,
    };
    if (options.profile) params.profile = options.profile;
    const result = await this.call<{ text?: string }>("llm.oneshot", params, {
      timeoutMs: options.timeoutMs ?? 60_000,
    });
    return { text: result?.text ?? "" };
  }

  /** 关闭连接。 */
  close(): void {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    this.rejectAll(
      lifecycleError("GATEWAY_UNAVAILABLE", "gateway 客户端已关闭。"),
    );
  }

  private handleMessage(data: WebSocket.RawData): void {
    let frame: unknown;
    try {
      frame = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!frame || typeof frame !== "object") return;
    const obj = frame as Record<string, unknown>;

    if (obj.method === "event") {
      const params =
        obj.params && typeof obj.params === "object"
          ? (obj.params as Record<string, unknown>)
          : {};
      for (const handler of this.eventHandlers) {
        try {
          handler(params);
        } catch {
          // 单个订阅者异常不影响其它订阅者。
        }
      }
      return;
    }

    const id = obj.id;
    if (typeof id !== "string" || !this.pending.has(id)) return;
    const pending = this.pending.get(id) as PendingCall;
    this.pending.delete(id);
    clearTimeout(pending.timer);

    if (obj.error && typeof obj.error === "object") {
      const error = obj.error as { code?: number; message?: string };
      pending.reject(
        lifecycleError(
          "GATEWAY_RPC_ERROR",
          `gateway 返回错误${error.code !== undefined ? `（${error.code}）` : ""}：${error.message ?? "unknown"}`,
        ),
      );
      return;
    }
    pending.resolve(obj.result);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

/* ------------------------------------------------------------------ *
 * 进程内单例：工作台拉起并复用一个 gateway。
 * ------------------------------------------------------------------ */

interface SharedGateway {
  handle: GatewayHandle;
  client: GatewayClient;
  cliPath: string;
}

let shared: SharedGateway | null = null;
let starting: Promise<SharedGateway> | null = null;
let lastError: string | null = null;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 当前共享 gateway 的运行状态快照。 */
export interface GatewaySnapshot {
  running: boolean;
  port: number | null;
  connected: boolean;
  cliPath: string | null;
  lastError: string | null;
}

export function getGatewaySnapshot(): GatewaySnapshot {
  if (!shared || shared.handle.proc.exitCode !== null) {
    return {
      running: false,
      port: null,
      connected: false,
      cliPath: shared?.cliPath ?? null,
      lastError,
    };
  }
  return {
    running: true,
    port: shared.handle.port,
    connected: shared.client.isConnected(),
    cliPath: shared.cliPath,
    lastError,
  };
}

/**
 * 确保存在一个已连接 gateway（幂等）。
 * 失败抛结构化错误，并把消息记入 lastError。
 */
export async function ensureGateway(
  cliPath: string,
  options: Omit<SpawnGatewayOptions, "cliPath"> = {},
): Promise<SharedGateway> {
  if (shared && shared.handle.proc.exitCode === null && shared.client.isConnected()) {
    return shared;
  }
  if (starting) return starting;

  starting = (async (): Promise<SharedGateway> => {
    const handle = await spawnGateway({ cliPath, ...options });
    try {
      let token: string | null = null;
      for (let attempt = 0; attempt < 15 && !token; attempt += 1) {
        token = await extractSessionToken(handle.port);
        if (!token) await delay(200);
      }
      if (!token) {
        throw lifecycleError(
          "GATEWAY_UNAVAILABLE",
          "无法从 gateway 首页提取 SESSION_TOKEN。",
        );
      }
      const client = new GatewayClient({ port: handle.port, token });
      await client.connect();
      // 丢弃 gateway.ready 等初始事件即可；调用方按需订阅。
      const entry: SharedGateway = { handle, client, cliPath };
      handle.proc.once("exit", () => {
        if (shared === entry) shared = null;
      });
      shared = entry;
      lastError = null;
      return entry;
    } catch (error) {
      await handle.stop();
      lastError = (error as Error).message;
      throw error;
    }
  })();

  try {
    return await starting;
  } finally {
    starting = null;
  }
}

/** 停止并清空共享 gateway（幂等）。 */
export async function stopSharedGateway(): Promise<void> {
  const current = shared;
  shared = null;
  if (!current) return;
  try {
    current.client.close();
  } catch {
    // ignore
  }
  await current.handle.stop();
}
