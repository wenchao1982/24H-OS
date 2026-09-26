/**
 * M5.3 冒烟（临时，不入库）：mock gateway + HTTP 级
 * SSE → approval → decide → 流继续到 done；decide/subagent 错误码；无残留 hermes serve。
 *
 * 运行：node_modules/.bin/tsx scripts/smoke-m5.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import Fastify from "fastify";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { GatewayClient } from "../server/hermes/gateway";
import { streamPrompt } from "../server/hermes/chat";
import { hermesRoutes } from "../server/routes/hermes";

function eventFrame(type: string, payload: Record<string, unknown>, sessionId = "s1"): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    method: "event",
    params: { type, session_id: sessionId, payload },
  });
}

function requestFrame(id: string, method: string, params: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params: { session_id: "s1", ...params } });
}

async function main(): Promise<void> {
  // 隔离环境：不触碰真实 ~/.hermes。
  const tempHome = mkdtempSync(path.join(os.tmpdir(), "24os-smoke-home-"));
  process.env.HOME = tempHome;
  process.env.HERMES_HOME = path.join(tempHome, ".hermes");
  process.env.OS_HERMES_HOME = process.env.HERMES_HOME;
  process.env.OS_HERMES_CLI = path.join(tempHome, "missing-hermes");
  process.env.PATH = "/nonexistent";
  delete process.env.OS_GATEWAY_AUTO_APPROVE;

  // ---- mock gateway ----
  const received: Array<{ id?: string; method?: string; params?: Record<string, unknown>; result?: unknown }> = [];
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  let socket: WsSocket | null = null;
  wss.on("connection", (s) => {
    socket = s;
    s.on("message", (data) => {
      let req: (typeof received)[number];
      try {
        req = JSON.parse(data.toString()) as typeof req;
      } catch {
        return;
      }
      received.push(req);
      if (typeof req.id !== "string") return;
      let result: Record<string, unknown> = {};
      switch (req.method) {
        case "session.create":
          result = { session_id: "s1", stored_session_id: "s1", message_count: 0, messages: [], info: {} };
          break;
        case "prompt.submit":
          result = { status: "streaming" };
          // 模拟审批请求；decide 后由测试端确认流继续。
          s.send(
            requestFrame("srq-smoke", "approval", {
              command: "rm -rf /tmp/x",
              description: "删除临时目录",
              choices: ["once", "session", "always", "deny"],
            }),
          );
          break;
        case "session.interrupt":
          result = { status: "interrupted", interrupted: true };
          break;
        case "session.close":
          result = { closed: true };
          break;
        default:
          break;
      }
      s.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }));
    });
  });
  const gwPort = (wss.address() as AddressInfo).port;
  const gwClient = new GatewayClient({ port: gwPort, token: "t", connectTimeoutMs: 3000 });
  await gwClient.connect();

  // ---- app（注入绑定 mock client 的 streamPrompt） ----
  const app = Fastify({ logger: false });
  await app.register(hermesRoutes, {
    streamPrompt: (options) =>
      streamPrompt({
        ...options,
        client: gwClient,
        interactive: options.interactive ?? true,
      }),
  });
  const freePort = await new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
  await app.listen({ port: freePort, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${freePort}`;

  const results: string[] = [];
  const ok = (name: string, cond: boolean, detail = ""): void => {
    results.push(`${cond ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
    if (!cond) process.exitCode = 1;
  };

  // 1) decide 非法 → 400
  {
    const res = await fetch(`${base}/api/hermes/chat/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "approval" }),
    });
    const body = (await res.json()) as { error?: string };
    ok("decide 缺 chatId → 400 INVALID_VALUE", res.status === 400 && body.error === "INVALID_VALUE", `status=${res.status}`);
  }

  // 2) decide 未知 chat → 404
  {
    const res = await fetch(`${base}/api/hermes/chat/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId: "no-such", type: "approval", choice: "once" }),
    });
    const body = (await res.json()) as { error?: string };
    ok("decide 未知 chat → 404 CHAT_NOT_FOUND", res.status === 404 && body.error === "CHAT_NOT_FOUND", `status=${res.status}`);
  }

  // 3) subagent 观测/控制语义（M10）
  {
    const res1 = await fetch(`${base}/api/hermes/subagents`);
    const b1 = (await res1.json()) as { count?: number; support?: { spawnApi?: boolean } };
    ok(
      "subagents 无 sessionId → 200 空列表 + spawnApi:false",
      res1.status === 200 && b1.count === 0 && b1.support?.spawnApi === false,
      `status=${res1.status}`,
    );

    const res2 = await fetch(`${base}/api/hermes/subagent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "干活" }),
    });
    const b2 = (await res2.json()) as { code?: string; contract?: { spawnApi?: boolean } };
    ok(
      "subagent spawn → 501 SPAWN_UNSUPPORTED + 契约",
      res2.status === 501 && b2.code === "SPAWN_UNSUPPORTED" && b2.contract?.spawnApi === false,
      `status=${res2.status}`,
    );

    const res3 = await fetch(`${base}/api/hermes/subagents/pause`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paused: true }),
    });
    const b3 = (await res3.json()) as { error?: string };
    ok(
      "pause 缺 confirm → 400 CONFIRM_REQUIRED",
      res3.status === 400 && b3.error === "CONFIRM_REQUIRED",
      `status=${res3.status}`,
    );
  }

  // 4) SSE → approval → decide once → done
  {
    const chatId = "smoke-chat-1";
    const controller = new AbortController();
    const res = await fetch(`${base}/api/hermes/chat/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "冒烟", chatId, model: "smoke-model" }),
      signal: controller.signal,
    });
    ok("SSE 200 + text/event-stream", res.status === 200 && (res.headers.get("content-type") ?? "").includes("text/event-stream"));

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sawApproval = false;
    let sawDone = false;
    let sawChatIdOnEvent = false;
    let decided = false;

    const pump = async (): Promise<void> => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx = buffer.indexOf("\n\n");
        while (idx >= 0) {
          const chunk = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 2);
          if (chunk.startsWith("data:")) {
            const event = JSON.parse(chunk.slice(5).trim()) as {
              type?: string;
              chatId?: string;
              id?: string;
              autoDecided?: boolean;
              status?: string;
            };
            if (event.type === "approval") {
              sawApproval = true;
              if (event.chatId === chatId && event.id === "srq-smoke" && event.autoDecided === false) {
                sawChatIdOnEvent = true;
              }
              if (!decided) {
                decided = true;
                const dres = await fetch(`${base}/api/hermes/chat/decide`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ chatId, type: "approval", choice: "once" }),
                });
                const dbody = (await dres.json()) as { ok?: boolean; decision?: { choice?: string } };
                ok(
                  "decide once → 200 + decision.choice=once",
                  dres.status === 200 && dbody.ok === true && dbody.decision?.choice === "once",
                  `status=${dres.status}`,
                );
                // 模拟 gateway 收到 respond 后继续 → 发 complete。
                socket?.send(eventFrame("message.delta", { text: "继续" }));
                socket?.send(eventFrame("message.complete", { text: "smoke-ok", status: "complete" }));
              }
            } else if (event.type === "done") {
              sawDone = true;
            }
          }
          idx = buffer.indexOf("\n\n");
        }
        if (sawDone) break;
      }
    };
    await pump();

    ok("SSE 收到 approval 事件", sawApproval);
    ok("事件携带 chatId/id/autoDecided:false", sawChatIdOnEvent);
    ok("decide 后流继续到 done", sawDone);
    ok(
      "session.create 带 model",
      received.some((f) => f.method === "session.create" && (f.params as { model?: string })?.model === "smoke-model"),
    );
    ok("gateway 收到 {choice:once} respond", received.some((f) => f.id === "srq-smoke" && (f.result as { choice?: string })?.choice === "once"));
    // 已决后再 decide → 404（流已结束注销）
    const res2 = await fetch(`${base}/api/hermes/chat/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId, type: "approval", choice: "deny" }),
    });
    ok("流结束后 decide → 404", res2.status === 404, `status=${res2.status}`);
  }

  // 清理
  await app.close();
  gwClient.close();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  rmSync(tempHome, { recursive: true, force: true });

  // 无残留 hermes serve
  const { execSync } = await import("node:child_process");
  let hermesProcs = "";
  try {
    hermesProcs = execSync("ps aux | grep 'hermes serve' | grep -v grep || true", { encoding: "utf8" }).trim();
  } catch {
    hermesProcs = "";
  }
  ok("无残留 hermes serve", hermesProcs === "", hermesProcs);

  console.log("\n== M5.3 smoke ==");
  for (const line of results) console.log(line);
  console.log(process.exitCode ? "\nSMOKE FAILED" : "\nSMOKE OK");
  process.exit(process.exitCode ?? 0);
}

main().catch((error) => {
  console.error("smoke error:", error);
  process.exit(1);
});
