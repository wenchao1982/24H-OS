#!/usr/bin/env node
/**
 * 24H-OS 只读验收冒烟（acceptance smoke）。
 *
 * ⚠️ 本脚本**只发 HTTP GET**：零写入、零模型调用、绝不触碰 `~/.hermes` / `~/.24os`。
 *    它不会 POST/PATCH/DELETE，不会触发安装/卸载/审批/计费，可安全对生产式环境反复运行。
 *
 * 用法（先启动 server）：
 *   npm run dev            # 或 npm run build && npm start（http://127.0.0.1:4319）
 *   node scripts/acceptance-smoke.mjs
 *   node scripts/acceptance-smoke.mjs --base http://127.0.0.1:4598
 *   OS_E2E_BASE=http://127.0.0.1:4598 node scripts/acceptance-smoke.mjs
 *
 * 退出码：全部 PASS（无 FAIL）→ 0；存在 FAIL → 1。
 *
 * 覆盖的只读端点：
 *   GET /api/health
 *   GET /api/agents                     （取列表第一个 id）
 *   GET /api/agents/:id
 *   GET /api/agents/:id/config          （断言 env 只回键名，不泄露明文）
 *   GET /api/skill-uis
 *   GET /api/market
 *   GET /api/cron/jobs
 *   GET /api/hermes/subagents
 *   GET /api/hooks/log
 *   GET /                            （已构建 → HTML；纯 API → 服务自述 JSON）
 *   GET /skill-ui/outline/panel.yaml （声明式面板静态资源）
 * 另含一项聚合断言：所有响应中不得出现疑似明文密钥字段（api_key/token/secret…）。
 */

const DEFAULT_BASE = "http://127.0.0.1:4319";
const REQ_TIMEOUT_MS = 10_000;

/** 解析 `--base <url>` / `--base=<url>` / 环境变量 OS_E2E_BASE。 */
function resolveBase(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--base" && argv[i + 1]) return argv[i + 1];
    if (arg.startsWith("--base=")) return arg.slice("--base=".length);
  }
  const fromEnv = process.env.OS_E2E_BASE?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_BASE;
}

/** 去掉末尾斜杠，避免拼出 `//api`。 */
function normalizeBase(base) {
  return base.replace(/\/+$/, "");
}

/** 仅 GET（显式固定 method，杜绝意外写操作）。 */
async function get(base, path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQ_TIMEOUT_MS);
  try {
    const response = await fetch(`${base}${path}`, {
      method: "GET",
      headers: { accept: "application/json, text/html;q=0.9, */*;q=0.1" },
      signal: controller.signal,
    });
    const contentType = response.headers.get("content-type") ?? "";
    let body;
    if (contentType.includes("application/json")) {
      body = await response.json().catch(() => null);
    } else {
      body = await response.text();
    }
    return { status: response.status, contentType, body };
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- 结果收集 ---------------- */

const results = [];
/** 所有成功解析的 JSON 响应体（用于最终的密钥泄露聚合扫描）。 */
const jsonBodies = [];

function record(name, outcome, status, summary, extra = {}) {
  results.push({ name, outcome, status, summary, ...extra });
  const tag =
    outcome === "PASS" ? "PASS" : outcome === "SKIP" ? "SKIP" : "FAIL";
  const statusText = status === null ? "  - " : String(status).padStart(3);
  // eslint-disable-next-line no-console
  console.log(`[${tag}] ${name.padEnd(38)} ${statusText}  ${summary}`);
  if (extra.detail) {
    // eslint-disable-next-line no-console
    console.log(`        ↳ ${extra.detail}`);
  }
}

function pass(name, status, summary, extra) {
  record(name, "PASS", status, summary, extra);
}
function fail(name, status, summary, extra) {
  record(name, "FAIL", status, summary, extra);
}
function skip(name, summary, extra) {
  record(name, "SKIP", null, summary, extra);
}

/** 检查项是否为对象（非 null / 非数组）。 */
function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/* ---------------- 单项检查 ---------------- */

async function checkHealth(base) {
  const { status, body } = await get(base, "/api/health");
  jsonBodies.push(body);
  if (status === 200 && isObject(body) && body.ok === true) {
    pass("/api/health", status, `ok=true service=${body.service}`);
    return true;
  }
  fail(
    "/api/health",
    status,
    "期望 200 + {ok:true}",
    { detail: JSON.stringify(body).slice(0, 200) },
  );
  return false;
}

async function checkAgents(base) {
  const { status, body } = await get(base, "/api/agents");
  jsonBodies.push(body);
  if (status !== 200 || !isObject(body) || !Array.isArray(body.agents)) {
    fail("/api/agents", status, "期望 200 + {agents:[...],status:{}}");
    return null;
  }
  const agents = body.agents;
  const mode = isObject(body.status) ? body.status.mode : "?";
  pass(
    "/api/agents",
    status,
    `agents=${agents.length} mode=${mode}`,
    agents.length > 0
      ? { detail: `ids=[${agents.slice(0, 6).map((a) => a.id).join(", ")}]` }
      : { detail: "无 profile —— 检查 HERMES_HOME 或 CLI 探测" },
  );
  return agents;
}

async function checkAgentDetail(base, agents) {
  if (!agents || agents.length === 0) {
    skip("/api/agents/:id", "列表为空，跳过详情检查");
    return null;
  }
  const id = agents[0].id;
  const { status, body } = await get(base, `/api/agents/${encodeURIComponent(id)}`);
  jsonBodies.push(body);
  if (status !== 200 || !isObject(body) || body.id !== id) {
    fail(`/api/agents/${id}`, status, "期望 200 + id 与请求一致");
    return null;
  }
  const skillCount = Array.isArray(body.skills) ? body.skills.length : 0;
  const mcpCount = Array.isArray(body.mcpServers) ? body.mcpServers.length : 0;
  pass(
    `/api/agents/${id}`,
    status,
    `model=${body.model ?? "?"} skills=${skillCount} mcp=${mcpCount}`,
  );
  return id;
}

async function checkAgentConfig(base, agentId) {
  if (!agentId) {
    skip("/api/agents/:id/config", "无可用 agent，跳过配置读取检查");
    return;
  }
  const { status, body } = await get(
    base,
    `/api/agents/${encodeURIComponent(agentId)}/config`,
  );
  jsonBodies.push(body);
  if (status !== 200 || !isObject(body)) {
    fail(`/api/agents/${agentId}/config`, status, "期望 200 JSON");
    return;
  }
  const envKeys = body.envKeys;
  const envKeysOk =
    Array.isArray(envKeys) && envKeys.every((key) => typeof key === "string");
  const hasEnvValues =
    isObject(body.envValues) || isObject(body.env) || body.values !== undefined;
  if (envKeysOk && !hasEnvValues) {
    pass(
      `/api/agents/${agentId}/config`,
      status,
      `envKeys=[${envKeys.slice(0, 5).join(", ")}]（仅键名）`,
    );
  } else {
    fail(
      `/api/agents/${agentId}/config`,
      status,
      "env 只应回键名（envKeys:string[]），不应出现 env/values 明文对象",
    );
  }
}

async function checkSkillUis(base) {
  const { status, body } = await get(base, "/api/skill-uis");
  jsonBodies.push(body);
  if (status !== 200 || !Array.isArray(body)) {
    fail("/api/skill-uis", status, "期望 200 + 数组");
    return;
  }
  const ids = body.map((item) => item.id);
  pass(
    "/api/skill-uis",
    status,
    `count=${body.length}`,
    { detail: `ids=[${ids.join(", ")}]` },
  );
}

async function checkMarket(base) {
  const { status, body } = await get(base, "/api/market");
  jsonBodies.push(body);
  if (status !== 200 || !isObject(body) || !Array.isArray(body.entries)) {
    fail("/api/market", status, "期望 200 + {entries:[...]}");
    return;
  }
  const appCount = body.entries.filter((entry) => entry.appManifest === true).length;
  pass(
    "/api/market",
    status,
    `entries=${body.entries.length} appManifest=${appCount}`,
    { detail: `message="${body.message}"` },
  );
}

async function checkCron(base) {
  const { status, body } = await get(base, "/api/cron/jobs");
  jsonBodies.push(body);
  if (status !== 200 || !isObject(body) || !Array.isArray(body.jobs)) {
    fail("/api/cron/jobs", status, "期望 200 + {jobs:[...]}");
    return;
  }
  const ticker = isObject(body.ticker) ? body.ticker : {};
  pass(
    "/api/cron/jobs",
    status,
    `jobs=${body.jobs.length} ticker.enabled=${ticker.enabled} gatewayRunning=${ticker.gatewayRunning}`,
    body.warning ? { detail: `warning=${body.warning}` } : undefined,
  );
}

async function checkSubagents(base) {
  const { status, body } = await get(base, "/api/hermes/subagents");
  jsonBodies.push(body);
  if (status !== 200 || !isObject(body) || !Array.isArray(body.subagents)) {
    fail("/api/hermes/subagents", status, "期望 200 + {subagents:[...],support:{}}");
    return;
  }
  const support = isObject(body.support) ? body.support : {};
  pass(
    "/api/hermes/subagents",
    status,
    `subagents=${body.subagents.length} spawnApi=${support.spawnApi} controlApi=${support.controlApi} events=${support.events}`,
    support.mechanism ? { detail: `mechanism=${support.mechanism}` } : undefined,
  );
}

async function checkHooksLog(base) {
  const { status, body } = await get(base, "/api/hooks/log");
  jsonBodies.push(body);
  if (status !== 200 || !isObject(body) || !Array.isArray(body.entries)) {
    fail("/api/hooks/log", status, "期望 200 + {entries:[...]}");
    return;
  }
  pass("/api/hooks/log", status, `entries=${body.entries.length} total=${body.total}`);
}

async function checkRoot(base) {
  const { status, contentType, body } = await get(base, "/");
  if (status !== 200) {
    fail("GET /", status, "期望 200");
    return;
  }
  if (contentType.includes("text/html")) {
    const hasHtml = typeof body === "string" && /<html[\s>]/i.test(body);
    if (hasHtml) {
      pass("GET /", status, "静态托管返回 HTML（dist/web 已构建）");
    } else {
      fail("GET /", status, "content-type 为 HTML 但正文不像 HTML");
    }
    return;
  }
  if (isObject(body) && body.name === "24H-OS") {
    pass("GET /", status, "纯 API 模式返回服务自述 JSON（未构建 dist/web）");
    return;
  }
  fail(
    "GET /",
    status,
    "期望 HTML（已构建）或 24H-OS 自述 JSON",
    { detail: `content-type=${contentType}` },
  );
}

async function checkPanelYaml(base) {
  // 声明式面板 uiRoot = <skill>/ui，故 URL 为 /skill-ui/outline/panel.yaml。
  const { status, contentType, body } = await get(
    base,
    "/skill-ui/outline/panel.yaml",
  );
  if (status !== 200) {
    fail(
      "/skill-ui/outline/panel.yaml",
      status,
      "期望 200（检查示例 skill 与 OS_SKILL_ROOTS）",
    );
    return;
  }
  const looksYaml = typeof body === "string" && /protocol:\s*24os-skill-panel\/1/.test(body);
  if (looksYaml) {
    pass(
      "/skill-ui/outline/panel.yaml",
      status,
      `content-type=${contentType}`,
    );
  } else {
    fail(
      "/skill-ui/outline/panel.yaml",
      status,
      "返回 200 但内容不是 24os-skill-panel/1",
    );
  }
}

/* ---------------- 聚合：明文密钥泄露扫描 ---------------- */

/** 敏感字段名（小写精确匹配）与后缀模式。 */
const SENSITIVE_KEYS = new Set([
  "api_key",
  "apikey",
  "api-key",
  "token",
  "access_token",
  "refresh_token",
  "secret",
  "client_secret",
  "password",
  "passwd",
  "authorization",
  "private_key",
]);

function isSensitiveKey(key) {
  const lower = key.toLowerCase();
  return SENSITIVE_KEYS.has(lower) || lower.endsWith("_token") || lower.endsWith("_secret");
}

/** 递归查找疑似明文密钥字段；返回命中的路径列表。 */
function findSecretEcho(value, path = "$", hits = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => findSecretEcho(item, `${path}[${index}]`, hits));
    return hits;
  }
  if (!isObject(value)) return hits;
  for (const [key, child] of Object.entries(value)) {
    const here = `${path}.${key}`;
    if (isSensitiveKey(key)) {
      // 值非空且非脱敏占位符才视为泄露。
      const isPlaintext =
        (typeof child === "string" && child.trim() !== "" && child.trim() !== "***") ||
        (typeof child === "number" && Number.isFinite(child));
      if (isPlaintext) hits.push(here);
    }
    findSecretEcho(child, here, hits);
  }
  return hits;
}

function checkNoSecretEcho() {
  const hits = [];
  for (const body of jsonBodies) {
    if (body === null || body === undefined) continue;
    findSecretEcho(body, "$", hits);
  }
  if (hits.length === 0) {
    pass("no-secret-echo", 200, "所有响应未见 api_key/token/secret 等明文值");
  } else {
    fail(
      "no-secret-echo",
      200,
      `响应出现疑似明文密钥字段 ${hits.length} 处`,
      { detail: hits.slice(0, 10).join(", ") },
    );
  }
}

/* ---------------- main ---------------- */

async function main() {
  const base = normalizeBase(resolveBase(process.argv.slice(2)));
  // eslint-disable-next-line no-console
  console.log(`\n24H-OS 只读验收冒烟\n目标：${base}`);
  // eslint-disable-next-line no-console
  console.log("（本脚本只发 GET：零写入、零模型调用、不触碰 ~/.hermes / ~/.24os）\n");

  let reachable = false;
  try {
    reachable = await checkHealth(base);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // eslint-disable-next-line no-console
    console.log(`[FAIL] 无法连接 ${base}：${message}`);
    // eslint-disable-next-line no-console
    console.log(
      "\n请先启动 server：\n" +
        "  npm run dev                     # 开发（server 4319 + web 5173）\n" +
        "  npm run build && npm start      # 生产式（http://127.0.0.1:4319）\n" +
        "或用 --base / OS_E2E_BASE 指定其它地址。\n",
    );
    process.exit(1);
  }

  if (reachable) {
    const agents = await checkAgents(base).catch((error) => {
      fail("/api/agents", null, error instanceof Error ? error.message : String(error));
      return null;
    });
    const agentId = await checkAgentDetail(base, agents).catch(() => null);
    await checkAgentConfig(base, agentId).catch(() => {});
    await checkSkillUis(base).catch(() => {});
    await checkMarket(base).catch(() => {});
    await checkCron(base).catch(() => {});
    await checkSubagents(base).catch(() => {});
    await checkHooksLog(base).catch(() => {});
    await checkRoot(base).catch(() => {});
    await checkPanelYaml(base).catch(() => {});
    checkNoSecretEcho();
  }

  const passed = results.filter((item) => item.outcome === "PASS").length;
  const failed = results.filter((item) => item.outcome === "FAIL").length;
  const skipped = results.filter((item) => item.outcome === "SKIP").length;

  // eslint-disable-next-line no-console
  console.log(`\n${"─".repeat(64)}`);
  // eslint-disable-next-line no-console
  console.log(`汇总：${passed} PASS / ${failed} FAIL / ${skipped} SKIP`);
  if (failed === 0) {
    // eslint-disable-next-line no-console
    console.log("结果：全部通过 ✅\n");
    process.exit(0);
  }
  // eslint-disable-next-line no-console
  console.log("结果：存在失败 ❌（请按上方 FAIL 行排查，见 docs/ACCEPTANCE_CHECKLIST.md）\n");
  process.exit(1);
}

void main();
