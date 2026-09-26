/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  API_BASE,
  ApiRequestError,
  addCronJob,
  addMcpServer,
  backupAgent,
  decideChat,
  deleteAgent,
  fetchAgent,
  fetchAgentAvatar,
  fetchAgentConfig,
  fetchAgents,
  fetchCronJobs,
  fetchHermesStatus,
  fetchMarket,
  fetchModelOptions,
  fetchSkillUis,
  installAgent,
  newChatId,
  pauseCronJob,
  removeCronJob,
  removeEnvVar,
  removeMcpServer,
  restoreAgentConfigBackup,
  resumeCronJob,
  runCronJob,
  setEnvVar,
  setSkillEnabled,
  updateAgent,
  updateAgentConfig,
  updateMcpServer,
  uploadAgentAvatar,
} from "./api";
import {
  jsonResponse,
  makeAgent,
  makeAgentConfig,
  makeStatus,
  makeLifecycleResult,
} from "./test-utils";

type FetchCall = [string, RequestInit];

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => jsonResponse({}));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function lastCall(): FetchCall {
  return fetchMock.mock.calls.at(-1) as unknown as FetchCall;
}

function jsonBody(call: FetchCall): Record<string, unknown> {
  return JSON.parse(String(call[1].body)) as Record<string, unknown>;
}

describe("web 测试环境", () => {
  it("在 jsdom 下执行（document / navigator 可用）", () => {
    expect(typeof document).toBe("object");
    expect(typeof window).toBe("object");
    expect(navigator.userAgent).toContain("jsdom");
  });
});

describe("api · GET 请求与 URL 编码", () => {
  it("fetchAgents 命中 /api/agents 且只带 Accept（无 body 不设 Content-Type）", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ agents: [], status: makeStatus() }),
    );
    await fetchAgents();
    const [url, init] = lastCall();
    expect(url).toBe(`${API_BASE}/api/agents`);
    expect(init.method).toBeUndefined();
    expect(init.body).toBeUndefined();
    expect(init.headers).toEqual({ Accept: "application/json" });
  });

  it("fetchAgent 对 id 做 encodeURIComponent 防注入", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(makeAgent()));
    await fetchAgent("a/b c");
    expect(lastCall()[0]).toBe(`${API_BASE}/api/agents/a%2Fb%20c`);
  });

  it("fetchHermesStatus / fetchSkillUis / fetchMarket 指向正确端点", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    await fetchHermesStatus();
    expect(lastCall()[0]).toBe(`${API_BASE}/api/hermes/status`);
    await fetchSkillUis();
    expect(lastCall()[0]).toBe(`${API_BASE}/api/skill-uis`);
    await fetchMarket();
    expect(lastCall()[0]).toBe(`${API_BASE}/api/market`);
  });

  it("fetchAgentConfig 指向 /config（env 只有键名，响应形状原样透传）", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(makeAgentConfig({ envKeys: ["TOKEN", "KEY"] })),
    );
    const config = await fetchAgentConfig("alpha");
    expect(lastCall()[0]).toBe(`${API_BASE}/api/agents/alpha/config`);
    expect(config.envKeys).toEqual(["TOKEN", "KEY"]);
    expect(JSON.stringify(config)).not.toContain("secret-value");
  });
});

describe("api · POST/PATCH/DELETE 方法、query 与 body 关键字段", () => {
  it("decideChat POST 携带 chatId/type/choice", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: true, chatId: "c1", requestId: "r1", type: "approval", decision: {} }),
    );
    await decideChat({ chatId: "c1", type: "approval", choice: "once" });
    const [url, init] = lastCall();
    expect(url).toBe(`${API_BASE}/api/hermes/chat/decide`);
    expect(init.method).toBe("POST");
    expect(jsonBody([url, init])).toEqual({
      chatId: "c1",
      type: "approval",
      choice: "once",
    });
    expect(init.headers).toMatchObject({ "Content-Type": "application/json" });
  });

  it("decideChat clarify 携带 answer（空串 = 跳过也照发）", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await decideChat({ chatId: "c2", type: "clarify", answer: "" });
    expect(jsonBody(lastCall())).toEqual({ chatId: "c2", type: "clarify", answer: "" });
  });

  it("installAgent POST 正确透传 confirm / dryRun / name / alias", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(makeLifecycleResult({ action: "install" })));
    await installAgent({
      source: "https://github.com/org/agent.git",
      name: "beta",
      alias: true,
      confirm: true,
      dryRun: false,
    });
    const [url, init] = lastCall();
    expect(url).toBe(`${API_BASE}/api/agents`);
    expect(init.method).toBe("POST");
    expect(jsonBody([url, init])).toEqual({
      source: "https://github.com/org/agent.git",
      name: "beta",
      alias: true,
      confirm: true,
      dryRun: false,
    });
  });

  it("updateAgent / backupAgent 指向子路径并带 dryRun", async () => {
    fetchMock.mockResolvedValue(jsonResponse(makeLifecycleResult()));
    await updateAgent("alpha", { dryRun: true });
    expect(lastCall()[0]).toBe(`${API_BASE}/api/agents/alpha/update`);
    expect(jsonBody(lastCall())).toEqual({ dryRun: true });
    await backupAgent("alpha");
    expect(lastCall()[0]).toBe(`${API_BASE}/api/agents/alpha/backup`);
    expect(jsonBody(lastCall())).toEqual({});
  });

  it("deleteAgent 使用 DELETE 并携带 confirm/backup", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(makeLifecycleResult({ action: "delete" })));
    await deleteAgent("alpha", { confirm: true, backup: true });
    const [url, init] = lastCall();
    expect(url).toBe(`${API_BASE}/api/agents/alpha`);
    expect(init.method).toBe("DELETE");
    expect(jsonBody([url, init])).toEqual({ confirm: true, backup: true });
  });

  it("updateAgentConfig PATCH，config 编辑一律带 confirm", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await updateAgentConfig("alpha", {
      model: "m",
      description: "d",
      tags: ["x"],
      confirm: true,
    });
    const [url, init] = lastCall();
    expect(url).toBe(`${API_BASE}/api/agents/alpha/config`);
    expect(init.method).toBe("PATCH");
    expect(jsonBody([url, init])).toEqual({
      model: "m",
      description: "d",
      tags: ["x"],
      confirm: true,
    });
  });

  it("addMcpServer POST /mcp 透传 name/spec/confirm", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await addMcpServer("alpha", {
      name: "files",
      spec: { command: "npx", args: ["-y", "server"] },
      confirm: true,
    });
    expect(lastCall()[0]).toBe(`${API_BASE}/api/agents/alpha/mcp`);
    expect(jsonBody(lastCall())).toEqual({
      name: "files",
      spec: { command: "npx", args: ["-y", "server"] },
      confirm: true,
    });
  });

  it("updateMcpServer PATCH，name 做 URL 编码", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await updateMcpServer("alpha", "my server", { spec: { url: "http://x" }, confirm: true });
    expect(lastCall()[0]).toBe(`${API_BASE}/api/agents/alpha/mcp/my%20server`);
    expect(lastCall()[1].method).toBe("PATCH");
  });

  it("removeMcpServer DELETE 默认 body 为空对象", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await removeMcpServer("alpha", "files");
    expect(lastCall()[0]).toBe(`${API_BASE}/api/agents/alpha/mcp/files`);
    expect(lastCall()[1].method).toBe("DELETE");
    expect(jsonBody(lastCall())).toEqual({});
  });

  it("setEnvVar POST 发送 key/value（值由服务端落盘，前端不回显）", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await setEnvVar("alpha", { key: "API_KEY", value: "sk-secret", confirm: true });
    const [url, init] = lastCall();
    expect(url).toBe(`${API_BASE}/api/agents/alpha/env`);
    expect(init.method).toBe("POST");
    expect(jsonBody([url, init])).toEqual({
      key: "API_KEY",
      value: "sk-secret",
      confirm: true,
    });
  });

  it("removeEnvVar DELETE，key 做 URL 编码", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await removeEnvVar("alpha", "A B/C");
    expect(lastCall()[0]).toBe(`${API_BASE}/api/agents/alpha/env/A%20B%2FC`);
    expect(lastCall()[1].method).toBe("DELETE");
  });

  it("restoreAgentConfigBackup POST 携带 backupFileName", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await restoreAgentConfigBackup("alpha", { backupFileName: "config.yaml.1.bak", confirm: true });
    expect(lastCall()[0]).toBe(`${API_BASE}/api/agents/alpha/config/restore`);
    expect(jsonBody(lastCall())).toEqual({
      backupFileName: "config.yaml.1.bak",
      confirm: true,
    });
  });

  it("setSkillEnabled POST /skills 携带 name/enabled/confirm", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await setSkillEnabled("alpha", { name: "ppt", enabled: false, confirm: true });
    expect(lastCall()[0]).toBe(`${API_BASE}/api/agents/alpha/skills`);
    expect(jsonBody(lastCall())).toEqual({ name: "ppt", enabled: false, confirm: true });
  });

  it("updateAgentConfig 可携带 soul（人设 SOUL）", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await updateAgentConfig("alpha", { soul: "You are careful.", confirm: true });
    expect(lastCall()[0]).toBe(`${API_BASE}/api/agents/alpha/config`);
    expect(jsonBody(lastCall())).toEqual({ soul: "You are careful.", confirm: true });
  });

  it("fetchAgentAvatar GET /avatar；uploadAgentAvatar POST 自动带 confirm", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ found: true, mime: "image/png", size: 68, data: "data:image/png;base64,AA" }),
    );
    const avatar = await fetchAgentAvatar("a b");
    expect(lastCall()[0]).toBe(`${API_BASE}/api/agents/a%20b/avatar`);
    expect(avatar.found).toBe(true);

    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, size: 68, message: "ok" }));
    await uploadAgentAvatar("alpha", "data:image/png;base64,AA");
    const [url, init] = lastCall();
    expect(url).toBe(`${API_BASE}/api/agents/alpha/avatar`);
    expect(init.method).toBe("POST");
    expect(jsonBody([url, init])).toEqual({
      data: "data:image/png;base64,AA",
      confirm: true,
    });
  });
});

describe("api · fetchModelOptions 模型候选", () => {
  it("指定 agentId 时取该 agent 的 model", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(makeAgent({ model: "m-one" })));
    await expect(fetchModelOptions("alpha")).resolves.toEqual(["m-one"]);
  });

  it("agent 无 model 时返回空数组", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(makeAgent({ model: "" })));
    await expect(fetchModelOptions("alpha")).resolves.toEqual([]);
  });

  it("无 agentId 时聚合全部去重", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        agents: [
          makeAgent({ id: "a", model: "m1" }),
          makeAgent({ id: "b", model: "m2" }),
          makeAgent({ id: "c", model: "m1" }),
          makeAgent({ id: "d", model: "" }),
        ],
        status: makeStatus(),
      }),
    );
    await expect(fetchModelOptions()).resolves.toEqual(["m1", "m2"]);
  });

  it("指定 agent 拉取失败时回退到全量列表", async () => {
    fetchMock
      .mockRejectedValueOnce(new Error("not found"))
      .mockResolvedValueOnce(
        jsonResponse({ agents: [makeAgent({ model: "fallback" })], status: makeStatus() }),
      );
    await expect(fetchModelOptions("ghost")).resolves.toEqual(["fallback"]);
  });
});

describe("api · newChatId", () => {
  it("优先使用 crypto.randomUUID", () => {
    vi.stubGlobal("crypto", { randomUUID: () => "fixed-uuid" });
    expect(newChatId()).toBe("fixed-uuid");
  });

  it("crypto 不可用时回退为 chat- 前缀的随机 id", () => {
    vi.stubGlobal("crypto", {});
    expect(newChatId()).toMatch(/^chat-[a-z0-9]+-[a-z0-9]+$/);
  });
});

describe("api · 错误路径", () => {
  it("非 2xx 且带 {error,message} → 抛 ApiRequestError（code/status/message 正确）", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: "CONFIRM_REQUIRED", message: "需要确认" }, 409),
    );
    await expect(updateAgentConfig("alpha", { confirm: false })).rejects.toMatchObject({
      name: "ApiRequestError",
      code: "CONFIRM_REQUIRED",
      status: 409,
      message: "需要确认",
    });
  });

  it("非 2xx 且响应体不是 JSON → 回退 REQUEST_FAILED 与默认文案", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error("not json");
      },
    });
    await expect(fetchAgents()).rejects.toBeInstanceOf(ApiRequestError);
    await expect(fetchAgents()).rejects.toMatchObject({ code: "REQUEST_FAILED", status: 500 });
  });

  it("网络异常（fetch reject）原样向上抛出", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    await expect(fetchAgents()).rejects.toThrow("network down");
  });
});

describe("api · 官方 Cron（M8）", () => {
  it("fetchCronJobs 拼 include_disabled / profile 查询串", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ jobs: [], count: 0, includeDisabled: true, ticker: {}, message: "" }),
    );
    await fetchCronJobs({ includeDisabled: true, profile: "ops" });
    expect(lastCall()[0]).toBe(
      `${API_BASE}/api/cron/jobs?include_disabled=1&profile=ops`,
    );
  });

  it("fetchCronJobs 无参数时不带查询串", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ jobs: [], count: 0 }));
    await fetchCronJobs();
    expect(lastCall()[0]).toBe(`${API_BASE}/api/cron/jobs`);
  });

  it("addCronJob 自动带 confirm:true", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, action: "add" }));
    await addCronJob({ name: "probe", schedule: "30m", prompt: "x" });
    const [url, init] = lastCall();
    expect(url).toBe(`${API_BASE}/api/cron/jobs`);
    expect(init.method).toBe("POST");
    expect(jsonBody(lastCall())).toMatchObject({ confirm: true, name: "probe" });
  });

  it("pause/resume/remove/run 走对应端点且带 confirm", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    await pauseCronJob("a b");
    expect(lastCall()[0]).toBe(`${API_BASE}/api/cron/jobs/a%20b/pause`);
    await resumeCronJob("probe");
    expect(lastCall()[0]).toBe(`${API_BASE}/api/cron/jobs/probe/resume`);
    await removeCronJob("probe");
    expect(lastCall()[0]).toBe(`${API_BASE}/api/cron/jobs/probe/remove`);
    await runCronJob("probe");
    expect(lastCall()[0]).toBe(`${API_BASE}/api/cron/jobs/probe/run`);
    expect(jsonBody(lastCall())).toEqual({ confirm: true });
  });
});
