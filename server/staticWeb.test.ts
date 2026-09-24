import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isReservedStaticPath,
  resolveWebDistRoot,
  serveStaticPath,
  shouldBypassWebToken,
  stripQuery,
  tryHandleStaticRequest,
} from "./staticWeb";

/**
 * 生产静态托管测试（全部使用临时 web/dist fixture，不触碰真实产物）：
 *   - resolveWebDistRoot 候选顺序（OS_WEB_DIST / dist/web / web/dist）；
 *   - `/` → index.html、`/assets/app.js` → 200、`/foo/bar` → SPA fallback；
 *   - `/../secret` → 拒（404）；带扩展名的缺失资源不 fallback；
 *   - `/api`、`/skill-ui` 保留路径不进 fallback；
 *   - 无 dist 时 tryHandleStaticRequest 返回 false（纯 API 行为不变）；
 *   - token 豁免仅回环 + 静态 + GET/HEAD。
 */

const tempDirs: string[] = [];
let app: FastifyInstance;

function newTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** 写一个最小 web/dist fixture（index.html + assets/app.js + dist 外 secret）。 */
function writeDistFixture(base: string): { dist: string; secret: string } {
  const dist = path.join(base, "dist", "web");
  mkdirSync(path.join(dist, "assets"), { recursive: true });
  writeFileSync(
    path.join(dist, "index.html"),
    '<!doctype html><html><body><div id="root"></div></body></html>',
    "utf8",
  );
  writeFileSync(path.join(dist, "assets", "app.js"), "console.log('app');", "utf8");
  const secret = path.join(base, "secret.txt");
  writeFileSync(secret, "top-secret", "utf8");
  return { dist, secret };
}

/** 组装与 server/index.ts 同构的最小 app（notFound 走静态/SPA）。 */
function buildApp(webDistRoot: string | null): FastifyInstance {
  const instance = Fastify({ logger: false });
  instance.get("/", async (request, reply) => {
    const handled = await tryHandleStaticRequest(
      webDistRoot,
      request.method,
      "/",
      reply,
    );
    if (handled) return reply;
    reply.code(404);
    return { error: "NOT_FOUND", message: "no dist" };
  });
  instance.get("/api/health", async () => ({ ok: true, service: "24H-OS" }));
  instance.setNotFoundHandler(async (request, reply) => {
    const handled = await tryHandleStaticRequest(
      webDistRoot,
      request.method,
      request.url,
      reply,
    );
    if (handled) return reply;
    reply.code(404);
    return {
      error: "NOT_FOUND",
      message: `未找到路由：${request.method} ${request.url}`,
    };
  });
  return instance;
}

beforeEach(() => {
  app = Fastify({ logger: false });
});

afterEach(async () => {
  await app.close();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveWebDistRoot", () => {
  it("找到 dist/web 与 web/dist；OS_WEB_DIST 显式覆盖；无效覆盖返回 null", () => {
    const base = newTempDir("24os-webdist-");
    const { dist } = writeDistFixture(base);

    expect(resolveWebDistRoot(base)).toBe(dist);

    const legacy = path.join(base, "web", "dist");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(path.join(legacy, "index.html"), "<!doctype html>", "utf8");
    // dist/web 优先于 web/dist。
    expect(resolveWebDistRoot(base)).toBe(dist);

    // 显式覆盖有效目录。
    expect(resolveWebDistRoot(base, { OS_WEB_DIST: legacy } as NodeJS.ProcessEnv)).toBe(
      legacy,
    );
    // 显式覆盖无效 → null（不回退）。
    expect(
      resolveWebDistRoot(base, {
        OS_WEB_DIST: path.join(base, "nope"),
      } as NodeJS.ProcessEnv),
    ).toBeNull();
  });

  it("无任何产物 → null", () => {
    const base = newTempDir("24os-webdist-empty-");
    expect(resolveWebDistRoot(base)).toBeNull();
  });
});

describe("serveStaticPath", () => {
  it("index.html 与 assets 送文件；目录与未知路由 fallback 到 index", async () => {
    const base = newTempDir("24os-static-serve-");
    const { dist } = writeDistFixture(base);

    const index = await serveStaticPath(dist, "/");
    expect(index.status).toBe(200);
    if (index.status === 200) {
      expect(index.body.toString("utf8")).toContain('<div id="root">');
      expect(index.contentType).toContain("text/html");
    }

    const asset = await serveStaticPath(dist, "/assets/app.js");
    expect(asset.status).toBe(200);
    if (asset.status === 200) {
      expect(asset.body.toString("utf8")).toContain("console.log");
      expect(asset.contentType).toContain("text/javascript");
    }

    const route = await serveStaticPath(dist, "/foo/bar");
    expect(route.status).toBe(200);
    if (route.status === 200) {
      expect(route.body.toString("utf8")).toContain('<div id="root">');
    }
  });

  it("/../secret 与编码穿越被拒；dist 外文件不可达", async () => {
    const base = newTempDir("24os-static-escape-");
    const { dist, secret } = writeDistFixture(base);
    // secret 在 dist 之外，若穿越成功会读到 top-secret。
    expect(secret.startsWith(dist)).toBe(false);

    for (const attack of [
      "/../secret.txt",
      "/assets/../../secret.txt",
      "/assets/..%2f..%2fsecret.txt",
      "/%2e%2e/secret.txt",
      "/..%00/secret.txt",
    ]) {
      const result = await serveStaticPath(dist, attack);
      expect(result.status, attack).toBe(404);
      if (result.status === 404) {
        expect(result.message).not.toContain("top-secret");
      }
    }
  });

  it("缺失的带扩展名资源不 fallback（404），避免 .js 返回 HTML", async () => {
    const base = newTempDir("24os-static-missing-");
    const { dist } = writeDistFixture(base);
    const missing = await serveStaticPath(dist, "/assets/missing.js");
    expect(missing.status).toBe(404);
  });

  it("非白名单扩展名被拒", async () => {
    const base = newTempDir("24os-static-ext-");
    const { dist } = writeDistFixture(base);
    writeFileSync(path.join(dist, "evil.sh"), "#!/bin/sh", "utf8");
    const result = await serveStaticPath(dist, "/evil.sh");
    expect(result.status).toBe(404);
  });
});

describe("tryHandleStaticRequest + 路由装配", () => {
  it("有 dist：/ → 200 index、/assets/app.js → 200、/foo/bar → 200 index、穿越 404", async () => {
    const base = newTempDir("24os-static-app-");
    const { dist } = writeDistFixture(base);
    await app.close();
    app = buildApp(dist);

    const root = await app.inject({ method: "GET", url: "/" });
    expect(root.statusCode).toBe(200);
    expect(root.body).toContain('<div id="root">');

    const asset = await app.inject({ method: "GET", url: "/assets/app.js" });
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toContain("console.log");

    const spa = await app.inject({ method: "GET", url: "/foo/bar" });
    expect(spa.statusCode).toBe(200);
    expect(spa.body).toContain('<div id="root">');

    const escape = await app.inject({ method: "GET", url: "/assets/..%2f..%2fsecret.txt" });
    expect(escape.statusCode).toBe(404);

    // 保留路径：/api 未命中仍 JSON 404，不 fallback 成 HTML。
    const apiMiss = await app.inject({ method: "GET", url: "/api/nope" });
    expect(apiMiss.statusCode).toBe(404);
    expect(apiMiss.json<{ error: string }>().error).toBe("NOT_FOUND");

    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json<{ ok: boolean }>().ok).toBe(true);
  });

  it("无 dist：tryHandleStaticRequest 返回 false，/ 与未知路径维持纯 API 404", async () => {
    await app.close();
    app = buildApp(null);

    const root = await app.inject({ method: "GET", url: "/" });
    expect(root.statusCode).toBe(404);
    expect(root.json<{ error: string }>().error).toBe("NOT_FOUND");

    const unknown = await app.inject({ method: "GET", url: "/foo/bar" });
    expect(unknown.statusCode).toBe(404);

    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
  });
});

describe("工具函数", () => {
  it("stripQuery 保留原始 path（不归一化 ..）", () => {
    expect(stripQuery("/foo/bar?x=1")).toBe("/foo/bar");
    expect(stripQuery("/foo#hash")).toBe("/foo");
    expect(stripQuery("/../secret")).toBe("/../secret");
  });

  it("isReservedStaticPath 只保留 /api 与 /skill-ui", () => {
    expect(isReservedStaticPath("/api")).toBe(true);
    expect(isReservedStaticPath("/api/agents")).toBe(true);
    expect(isReservedStaticPath("/skill-ui/ppt/index.html")).toBe(true);
    expect(isReservedStaticPath("/assets/app.js")).toBe(false);
    expect(isReservedStaticPath("/apifoo")).toBe(false);
  });

  it("shouldBypassWebToken：仅回环 + 静态启用 + GET/HEAD + 非保留路径", () => {
    expect(shouldBypassWebToken("GET", "/", "/dist", true)).toBe(true);
    expect(shouldBypassWebToken("HEAD", "/assets/a.js", "/dist", true)).toBe(true);
    // 非回环不豁免（安全基线）。
    expect(shouldBypassWebToken("GET", "/", "/dist", false)).toBe(false);
    // 保留路径不豁免。
    expect(shouldBypassWebToken("GET", "/api/agents", "/dist", true)).toBe(false);
    expect(shouldBypassWebToken("GET", "/skill-ui/x/y", "/dist", true)).toBe(false);
    // 未启用静态 → 不豁免。
    expect(shouldBypassWebToken("GET", "/", null, true)).toBe(false);
    // POST 不豁免。
    expect(shouldBypassWebToken("POST", "/", "/dist", true)).toBe(false);
  });
});
