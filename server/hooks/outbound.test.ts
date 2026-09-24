import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildPushHeaders,
  findPluginByName,
  pushNotify,
  readProfileEnvValues,
  signPushBody,
} from "./outbound";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * hooks.outbound 测试（M7）：
 * - 无 endpoint → skipped
 * - token 缺失 / 脱敏 → skipped
 * - HMAC 可用同 token 复算一致
 * - mock fetch 断言 header
 */

const tempDirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

afterEach(() => {
  for (const key of Object.keys(savedEnv)) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe("signPushBody / buildPushHeaders", () => {
  it("HMAC 用同 token 复算一致", () => {
    const token = "tok-secret";
    const ts = 1700000000000;
    const body = JSON.stringify({ hello: "world" });
    const sig = signPushBody(token, ts, body);
    const expected = createHmac("sha256", token)
      .update(`${ts}.${body}`)
      .digest("hex");
    expect(sig).toBe(expected);
    expect(sig).toMatch(/^[a-f0-9]{64}$/);

    const headers = buildPushHeaders(token, ts, body);
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["x-24os-timestamp"]).toBe(String(ts));
    expect(headers["x-24os-signature"]).toBe(`sha256=${sig}`);
  });
});

describe("pushNotify", () => {
  it("无 endpoint → skipped（不报错）", async () => {
    const result = await pushNotify({ name: "p", endpoint: undefined }, { a: 1 });
    expect(result.status).toBe("skipped");
    expect(result.reason).toContain("endpoint");
  });

  it("有 endpoint 但无 token → skipped", async () => {
    const result = await pushNotify(
      { name: "p", endpoint: "http://127.0.0.1:9/hook", envKey: "K" },
      { a: 1 },
      { env: {} },
    );
    expect(result.status).toBe("skipped");
    expect(result.reason).toContain("token");
  });

  it("env 中 token 为脱敏 *** → skipped", async () => {
    const result = await pushNotify(
      { name: "p", endpoint: "http://127.0.0.1:9/hook", envKey: "K" },
      { a: 1 },
      { env: { K: "***" } },
    );
    expect(result.status).toBe("skipped");
  });

  it("mock fetch：签名 header 可复算且与 body 一致", async () => {
    const token = "my-token";
    const bodyObj = { event: "app.hook", appId: "demo" };
    let captured: { url: string; init: RequestInit } | null = null;

    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      captured = { url: String(url), init: init ?? {} };
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    const result = await pushNotify(
      {
        name: "ops-push",
        endpoint: "http://example.test/hook",
        envKey: "REPORT_WEBHOOK",
      },
      bodyObj,
      { env: { REPORT_WEBHOOK: token }, fetchImpl },
    );

    expect(result.status).toBe("ok");
    expect(captured).not.toBeNull();
    const { url, init } = captured!;
    expect(url).toBe("http://example.test/hook");

    const headers = init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    const ts = Number(headers["x-24os-timestamp"]);
    expect(Number.isFinite(ts)).toBe(true);

    const body = String(init.body);
    expect(JSON.parse(body)).toEqual(bodyObj);

    const provided = headers["x-24os-signature"];
    expect(provided.startsWith("sha256=")).toBe(true);
    const recomputed = createHmac("sha256", token)
      .update(`${ts}.${body}`)
      .digest("hex");
    expect(provided).toBe(`sha256=${recomputed}`);
  });

  it("HTTP 非 2xx → error", async () => {
    const fetchImpl = (async () =>
      new Response("no", { status: 500 })) as unknown as typeof fetch;
    const result = await pushNotify(
      { name: "p", endpoint: "http://x/h", envKey: "T" },
      {},
      { token: "t", fetchImpl },
    );
    expect(result.status).toBe("error");
    expect(result.statusCode).toBe(500);
  });
});

describe("readProfileEnvValues", () => {
  it("从 profile .env 读取明文（测试临时 home）", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "24os-out-env-"));
    tempDirs.push(home);
    savedEnv.HERMES_HOME = process.env.HERMES_HOME;
    savedEnv.OS_HERMES_HOME = process.env.OS_HERMES_HOME;
    process.env.HERMES_HOME = home;
    process.env.OS_HERMES_HOME = home;

    const profileDir = path.join(home, "profiles", "demo");
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(
      path.join(profileDir, ".env"),
      'FOO=bar\nQUOTED="with space"\n',
      "utf8",
    );

    const env = await readProfileEnvValues("demo");
    expect(env.FOO).toBe("bar");
    expect(env.QUOTED).toBe("with space");
  });
});

describe("findPluginByName", () => {
  it("命中 / 未命中", () => {
    const plugins = [{ name: "ops-push", kind: "http" as const, endpoint: "http://x" }];
    expect(findPluginByName(plugins, "ops-push")?.name).toBe("ops-push");
    expect(findPluginByName(plugins, "nope")).toBeNull();
    expect(findPluginByName(undefined, "x")).toBeNull();
  });
});
