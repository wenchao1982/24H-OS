/**
 * M5 收尾冒烟（临时）：禁用 skill 强制拦截 + 昂贵模型确认流程。
 * 隔离 HERMES_HOME / meta / skills 根 + mock gateway（无真实模型调用、无 hermes serve）。
 *
 * 运行：node_modules/.bin/tsx scripts/smoke-m54.ts
 */
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import Fastify from "fastify";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import type { ChatStreamEvent } from "../shared/types";
import { GatewayClient } from "../server/hermes/gateway";
import { streamPrompt } from "../server/hermes/chat";
import { hermesRoutes } from "../server/routes/hermes";
import { skillUiRoutes } from "../server/routes/skillUi";

function eventFrame(type: string, payload: Record<string, unknown>, sessionId = "s1"): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    method: "event",
    params: { type, session_id: sessionId, payload },
  });
}

async function main(): Promise<void> {
  // ---- 隔离环境：不触碰真实 ~/.hermes / ~/.24os ----
  const tempHome = mkdtempSync(path.join(os.tmpdir(), "24os-smoke54-home-"));
  process.env.HOME = tempHome;
  process.env.HERMES_HOME = path.join(tempHome, ".hermes");
  process.env.OS_HERMES_HOME = process.env.HERMES_HOME;
  process.env.OS_HERMES_CLI = path.join(tempHome, "missing-hermes");
  process.env.PATH = "/nonexistent";
  delete process.env.OS_GATEWAY_AUTO_APPROVE;

  const metaRoot = mkdtempSync(path.join(os.tmpdir(), "24os-smoke54-meta-"));
  const skillsRoot = mkdtempSync(path.join(os.tmpdir(), "24os-smoke54-skills-"));
  process.env.OS_META_DIR = metaRoot;
  process.env.OS_SKILL_ROOTS = skillsRoot;

  // ---- 测试 skills：命令式 + 声明式 ----
  const mkManifestSkill = (id: string): void => {
    const ui = path.join(skillsRoot, id, "ui");
    mkdirSync(ui, { recursive: true });
    writeFileSync(path.join(skillsRoot, id, "SKILL.md"), `# ${id}\n`, "utf8");
    writeFileSync(path.join(ui, "index.html"), "<!doctype html><title>ui</title>", "utf8");
    writeFileSync(
      path.join(ui, "manifest.json"),
      JSON.stringify({
        protocol: "24os-skill-ui/1",
        id,
        title: id,
        entry: "index.html",
        host: "iframe",
        capabilities: ["emitEvent"],
        permissions: [],
      }),
      "utf8",
    );
  };
  const mkPanelSkill = (id: string): void => {
    const ui = path.join(skillsRoot, id, "ui");
    mkdirSync(ui, { recursive: true });
    writeFileSync(path.join(skillsRoot, id, "SKILL.md"), `# ${id}\n`, "utf8");
    writeFileSync(
      path.join(ui, "panel.yaml"),
      [
        "protocol: 24os-skill-panel/1",
        `skill: ${id}`,
        `title: ${id}`,
        "fields:",
        "  - key: topic",
        "    label: 主题",
        "    type: text",
        "actions: []",
      ].join("\n"),
      "utf8",
    );
  };
  mkManifestSkill("smoke-ui");
  mkPanelSkill("smoke-panel");

  const setSkillEnabled = (agentId: string, skill: string, enabled: boolean): void => {
    const dir = path.join(metaRoot, agentId);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "meta.json");
    let meta: { skills?: Record<string, { enabled: boolean }> } = {};
    try {
      meta = JSON.parse(readFileSync(file, "utf8")) as typeof meta;
    } catch {
      meta = {};
    }
    meta.skills = { ...(meta.skills ?? {}), [skill]: { enabled } };
    writeFileSync(file, JSON.stringify(meta, null, 2), "utf8");
  };

  // ---- mock gateway（无真实模型） ----
  const received: Array<{
    id?: string;
    method?: string;
    params?: Record<string, unknown>;
    result?: unknown;
  }> = [];
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
          result = {
            session_id: "s1",
            stored_session_id: "s1",
            message_count: 0,
            messages: [],
            info: {},
          };
          break;
        case "config.set": {
          const value = String(req.params?.value ?? "");
          const confirmed = req.params?.confirm_expensive_model === true;
          const expensive = value === "big-model" && !confirmed;
          result = {
            key: String(req.params?.key ?? ""),
            value,
            scope: "session",
            confirm_required: expensive,
            ...(expensive ? { confirm_message: "冒烟：昂贵模型需要确认" } : {}),
          };
          break;
        }
        case "prompt.submit":
          result = { status: "streaming" };
          s.send(eventFrame("message.complete", { text: "smoke-ok", status: "complete" }));
          break;
        case "session.close":
          result = { closed: true };
          break;
        case "session.interrupt":
          result = { status: "interrupted", interrupted: true };
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

  // ---- app：skill UI 路由 + hermes 路由（注入 mock client 的 streamPrompt） ----
  const app = Fastify({ logger: false });
  await app.register(skillUiRoutes);
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
    const line = `${cond ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`;
    results.push(line);
    console.log(line);
    if (!cond) process.exitCode = 1;
  };
  const json = async (res: Response): Promise<Record<string, unknown>> => {
    try {
      return (await res.json()) as Record<string, unknown>;
    } catch {
      return { error: "NON_JSON", message: `status=${res.status}` };
    }
  };

  /* ---------------- 1) 禁用 skill 强制拦截 ---------------- */
  setSkillEnabled("agent-a", "smoke-ui", false);
  setSkillEnabled("agent-a", "smoke-panel", false);

  {
    // 列表：disabled 标注（A 禁用、B 未管的聚合口径）
    const listRes = await fetch(`${base}/api/skill-uis`);
    const list = (await listRes.json()) as Array<{ id: string; disabled?: boolean }>;
    ok(
      "列表标注 disabled（A 禁用即聚合禁用）",
      list.find((x) => x.id === "smoke-ui")?.disabled === true &&
        list.find((x) => x.id === "smoke-panel")?.disabled === true,
    );

    // broker invoke 403（两种形态都拦）
    const inv1 = await fetch(`${base}/api/skill-host/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skillId: "smoke-ui", method: "emitEvent" }),
    });
    const inv1Body = await json(inv1);
    ok(
      "禁用 invoke → 403 SKILL_DISABLED（iframe）",
      inv1.status === 403 && (inv1Body.error as { code?: string } | undefined)?.code === "SKILL_DISABLED",
      `status=${inv1.status}`,
    );
    const inv2 = await fetch(`${base}/api/skill-host/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skillId: "smoke-panel", method: "emitEvent" }),
    });
    const inv2Body = await json(inv2);
    ok(
      "禁用 invoke → 403 SKILL_DISABLED（declarative）",
      inv2.status === 403 && (inv2Body.error as { code?: string } | undefined)?.code === "SKILL_DISABLED",
      `status=${inv2.status}`,
    );

    // panel 403
    const panelRes = await fetch(`${base}/api/skill-uis/smoke-panel/panel`);
    const panelBody = await json(panelRes);
    ok(
      "禁用 panel → 403 SKILL_DISABLED",
      panelRes.status === 403 && panelBody.error === "SKILL_DISABLED",
      `status=${panelRes.status}`,
    );

    // 静态 403；不存在 404
    const staticRes = await fetch(`${base}/skill-ui/smoke-ui/index.html`);
    const staticBody = await json(staticRes);
    ok(
      "禁用静态 → 403 SKILL_DISABLED",
      staticRes.status === 403 && staticBody.error === "SKILL_DISABLED",
      `status=${staticRes.status}`,
    );
    const missingRes = await fetch(`${base}/skill-ui/nope/index.html`);
    ok("不存在 skill 静态 → 404", missingRes.status === 404, `status=${missingRes.status}`);
  }

  // 重新启用 → 恢复 200
  setSkillEnabled("agent-a", "smoke-ui", true);
  setSkillEnabled("agent-a", "smoke-panel", true);
  {
    const inv = await fetch(`${base}/api/skill-host/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skillId: "smoke-ui", method: "emitEvent" }),
    });
    const invBody = await json(inv);
    ok("重新启用 invoke → 200", inv.status === 200 && invBody.ok === true, `status=${inv.status}`);

    const panelRes = await fetch(`${base}/api/skill-uis/smoke-panel/panel`);
    ok("重新启用 panel → 200", panelRes.status === 200, `status=${panelRes.status}`);

    const staticRes = await fetch(`${base}/skill-ui/smoke-ui/index.html`);
    ok("重新启用静态 → 200", staticRes.status === 200, `status=${staticRes.status}`);
  }

  /* ---------------- 2) 昂贵模型确认（无真实模型调用） ---------------- */
  {
    // a) 不带 force → confirm 事件 + interrupted，不提交 prompt
    const before = received.filter((f) => f.method === "prompt.submit").length;
    const events: ChatStreamEvent[] = [];
    const r1 = await streamPrompt({
      client: gwClient,
      prompt: "用昂贵模型",
      model: "big-model",
      onEvent: (e) => events.push(e),
    });
    const confirm = events.find(
      (e) => e.type === "session" && e.event === "model.confirm_required",
    );
    const payload = (confirm?.payload ?? {}) as { confirmMessage?: string };
    ok(
      "不带 force → model.confirm_required 事件 + interrupted",
      r1.status === "interrupted" && Boolean(confirm) && Boolean(payload.confirmMessage),
      `status=${r1.status}`,
    );
    const submits = received.filter((f) => f.method === "prompt.submit").length;
    ok("不带 force → 未提交 prompt（不静默放行）", submits === before, `submit ${before}→${submits}`);
    const lastConfigSet = [...received].reverse().find((f) => f.method === "config.set");
    ok(
      "不带 force → config.set 未带 confirm_expensive_model",
      lastConfigSet?.params?.confirm_expensive_model === undefined,
    );

    // b) force → 放行，流完成
    received.length = 0;
    const events2: ChatStreamEvent[] = [];
    const r2 = await streamPrompt({
      client: gwClient,
      prompt: "确认后重试",
      model: "big-model",
      force: true,
      onEvent: (e) => events2.push(e),
    });
    ok(
      "带 force → 流正常 done",
      r2.status === "done" &&
        !events2.some((e) => e.type === "session" && e.event === "model.confirm_required"),
      `status=${r2.status}`,
    );
    const forcedSet = received.find((f) => f.method === "config.set");
    ok(
      "带 force → config.set 带 confirm_expensive_model:true（契约键）",
      forcedSet?.params?.confirm_expensive_model === true &&
        forcedSet?.params?.force === undefined,
      JSON.stringify(forcedSet?.params ?? {}),
    );

    // c) OS_GATEWAY_AUTO_APPROVE=1 → 自动 force
    received.length = 0;
    process.env.OS_GATEWAY_AUTO_APPROVE = "1";
    try {
      const events3: ChatStreamEvent[] = [];
      const r3 = await streamPrompt({
        client: gwClient,
        prompt: "auto",
        model: "big-model",
        onEvent: (e) => events3.push(e),
      });
      const autoSet = received.find((f) => f.method === "config.set");
      ok(
        "OS_GATEWAY_AUTO_APPROVE=1 → 自动 force 且 done",
        r3.status === "done" &&
          autoSet?.params?.confirm_expensive_model === true &&
          !events3.some((e) => e.type === "session" && e.event === "model.confirm_required"),
        `status=${r3.status}`,
      );
    } finally {
      delete process.env.OS_GATEWAY_AUTO_APPROVE;
    }

    // d) SSE body.force 透传 → HTTP 层确认流程
    received.length = 0;
    const sseRes = await fetch(`${base}/api/hermes/chat/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "sse force", model: "big-model", force: true }),
    });
    ok(
      "SSE force:true → 200 text/event-stream",
      sseRes.status === 200 &&
        (sseRes.headers.get("content-type") ?? "").includes("text/event-stream"),
    );
    const sseText = await sseRes.text();
    const sseEvents = sseText
      .split("\n\n")
      .map((c) => c.trim())
      .filter((c) => c.startsWith("data:"))
      .map((c) => JSON.parse(c.slice(5).trim()) as ChatStreamEvent);
    ok(
      "SSE force → 收到 done、无 confirm_required",
      sseEvents.some((e) => e.type === "done") &&
        !sseEvents.some((e) => e.type === "session" && e.event === "model.confirm_required"),
    );
    const sseSet = received.find((f) => f.method === "config.set");
    ok("SSE force → gateway 收到 confirm_expensive_model", sseSet?.params?.confirm_expensive_model === true);
  }

  /* ---------------- 3) 清理 + 无残留进程 ---------------- */
  await app.close();
  gwClient.close();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  rmSync(tempHome, { recursive: true, force: true });
  rmSync(metaRoot, { recursive: true, force: true });
  rmSync(skillsRoot, { recursive: true, force: true });

  let hermesProcs = "";
  try {
    // PATH 已被隔离为 /nonexistent：检测残留进程时给 execSync 恢复系统 PATH。
    hermesProcs = execSync("ps aux | grep 'hermes serve' | grep -v grep || true", {
      encoding: "utf8",
      env: { ...process.env, PATH: "/usr/local/bin:/usr/bin:/bin" },
    }).trim();
  } catch {
    hermesProcs = "";
  }
  ok("无残留 hermes serve 进程", hermesProcs === "", hermesProcs);
  ok("mock gateway 已关闭（socket 解除）", socket === null || socket.readyState !== 1);

  console.log("\n== M5 收尾 smoke（SKILL_DISABLED + 昂贵模型确认） ==");
  for (const line of results) console.log(line);
  console.log(process.exitCode ? "\nSMOKE FAILED" : "\nSMOKE OK");
  process.exit(process.exitCode ?? 0);
}

main().catch((error) => {
  console.error("smoke error:", error);
  process.exit(1);
});
