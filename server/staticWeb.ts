import { statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { FastifyReply } from "fastify";
import type { ApiError } from "@shared/types";
import { APP_ROOT } from "./paths";

/**
 * 生产静态托管（M2 Electron 外壳 / 部署前置）。
 *
 * 当构建产物（默认 `dist/web/index.html`，兼容 `web/dist`，可用 `OS_WEB_DIST` 覆盖）
 * 存在时，server 兼作静态站点：
 *   - `GET /` 与未知路径 → 文件存在则送文件，否则 SPA fallback 回 `index.html`；
 *   - `GET /assets/*` 等 → 送文件（白名单扩展名）；
 *   - `/api/*`、`/skill-ui/*` 一律保留给路由（不进 fallback，未命中仍 JSON 404）；
 *   - 路径解析后必须仍在 web dist 根内（防穿越，复用 skillui/static 的校验风格）。
 *
 * 产物不存在时本模块不改变任何行为（纯 API 模式，dev 不受影响）。
 * Token：回环监听下静态资源可免 `x-24os-token`（页面无法带自定义头）；
 * 非回环监听不豁免（安全基线不放松，见 shouldBypassWebToken）。
 */

/** 允许托管的扩展名（小写，含点）。 */
export const WEB_ASSET_EXTENSIONS: readonly string[] = [
  ".html",
  ".htm",
  ".js",
  ".mjs",
  ".cjs",
  ".css",
  ".json",
  ".map",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".txt",
  ".webmanifest",
  ".wasm",
];

/** 扩展名 → Content-Type。 */
export function webContentTypeFor(ext: string): string {
  switch (ext.toLowerCase()) {
    case ".html":
    case ".htm":
      return "text/html; charset=utf-8";
    case ".js":
    case ".mjs":
    case ".cjs":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
    case ".map":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".avif":
      return "image/avif";
    case ".ico":
      return "image/x-icon";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    case ".ttf":
      return "font/ttf";
    case ".txt":
      return "text/plain; charset=utf-8";
    case ".webmanifest":
      return "application/manifest+json; charset=utf-8";
    case ".wasm":
      return "application/wasm";
    default:
      return "application/octet-stream";
  }
}

/** 去掉 query/hash，保留原始 path（不用 URL 解析器，避免提前归一化 `..`）。 */
export function stripQuery(rawUrl: string): string {
  const idx = rawUrl.search(/[?#]/);
  return idx === -1 ? rawUrl : rawUrl.slice(0, idx);
}

/** 是否保留给 API / Skill UI 路由（不做静态 fallback）。 */
export function isReservedStaticPath(pathname: string): boolean {
  return (
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname === "/skill-ui" ||
    pathname.startsWith("/skill-ui/")
  );
}

/**
 * 解析 web 构建产物根目录。
 * 优先级：`OS_WEB_DIST`（显式覆盖，无效则 null，不回退）→ `<base>/dist/web` → `<base>/web/dist`。
 * 仅当根下存在 `index.html` 才视为有效。
 */
export function resolveWebDistRoot(
  baseDir?: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const root = baseDir ?? APP_ROOT;
  const override = env.OS_WEB_DIST?.trim();
  const candidates = override
    ? [path.resolve(override)]
    : [path.join(root, "dist", "web"), path.join(root, "web", "dist")];
  for (const candidate of candidates) {
    try {
      if (statSync(path.join(candidate, "index.html")).isFile()) return candidate;
    } catch {
      // 不存在则试下一个候选。
    }
  }
  return null;
}

/** 静态响应结果。 */
export type StaticServeResult =
  | { status: 200; body: Buffer; contentType: string; cacheControl: string }
  | { status: 404; message: string };

/**
 * 把 URL path 安全地解析为 web dist 内的文件并读出。
 *  - 越界（`..`、绝对路径逃逸、NUL）→ 404 拒绝；
 *  - 非白名单扩展名 → 404 拒绝；
 *  - 文件存在 → 200 + 内容；
 *  - 不存在且最后一段像文件名（带扩展名，非 .html）→ 404；
 *  - 不存在且像路由路径 → SPA fallback 读 `index.html`（不存在则 404）。
 */
export async function serveStaticPath(
  webDistRoot: string,
  rawPath: string,
): Promise<StaticServeResult> {
  let pathname = rawPath;
  try {
    pathname = decodeURIComponent(rawPath);
  } catch {
    // 解码失败：保留原始串，下面按字面解析（多半会 404）。
  }
  if (pathname.includes("\0")) {
    return { status: 404, message: "拒绝服务该资源（非法路径）。" };
  }

  let cleaned = pathname.replace(/\\/g, "/").replace(/^\/+/, "");
  const lastSegment = cleaned.split("/").filter(Boolean).pop() ?? "";
  const looksLikeFile = path.extname(lastSegment) !== "";
  if (cleaned === "" || cleaned.endsWith("/")) {
    cleaned = `${cleaned}index.html`;
  }

  const root = path.resolve(webDistRoot);
  const absolute = path.resolve(root, cleaned);
  // 必须仍在 root 内（严格前缀 + 分隔符，防 ../ 与前缀混淆）。
  if (absolute !== root && !absolute.startsWith(root + path.sep)) {
    return { status: 404, message: "拒绝服务该资源（路径越界）。" };
  }

  const ext = path.extname(absolute).toLowerCase();
  if (ext !== "" && !WEB_ASSET_EXTENSIONS.includes(ext)) {
    return { status: 404, message: "拒绝服务该资源（类型不允许）。" };
  }

  let isFile = false;
  try {
    const st = await stat(absolute);
    isFile = st.isFile();
  } catch {
    isFile = false;
  }

  if (isFile) {
    if (ext === "" || !WEB_ASSET_EXTENSIONS.includes(ext)) {
      return { status: 404, message: "拒绝服务该资源（类型不允许）。" };
    }
    const body = await readFile(absolute);
    return {
      status: 200,
      body,
      contentType: webContentTypeFor(ext),
      cacheControl: ext === ".html" || ext === ".htm" ? "no-cache" : "public, max-age=3600",
    };
  }

  // 文件不存在：带扩展名的资源请求不 fallback（避免 .js 404 返回 HTML）。
  if (looksLikeFile && ext !== ".html" && ext !== ".htm") {
    return { status: 404, message: `未找到资源：${cleaned}` };
  }

  // SPA fallback → 根 index.html。
  const indexPath = path.join(root, "index.html");
  try {
    const st = await stat(indexPath);
    if (st.isFile()) {
      const body = await readFile(indexPath);
      return {
        status: 200,
        body,
        contentType: "text/html; charset=utf-8",
        cacheControl: "no-cache",
      };
    }
  } catch {
    // index.html 缺失 → 落到 404。
  }
  return { status: 404, message: `未找到资源：${cleaned}` };
}

/**
 * 尝试按静态/SPA 规则处理一次 GET/HEAD。
 * 返回 true 表示已写 reply（200 文件 / 200 index / 404 拒绝）；
 * 返回 false 表示交回调用方（无产物、非 GET、或 /api、/skill-ui 保留路径）。
 */
export async function tryHandleStaticRequest(
  webDistRoot: string | null,
  method: string,
  rawUrl: string,
  reply: FastifyReply,
): Promise<boolean> {
  if (!webDistRoot) return false;
  if (method !== "GET" && method !== "HEAD") return false;
  const pathname = stripQuery(rawUrl);
  if (isReservedStaticPath(pathname)) return false;

  const result = await serveStaticPath(webDistRoot, pathname);
  reply.code(result.status);
  if (result.status === 200) {
    reply.type(result.contentType);
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Cache-Control", result.cacheControl);
    void reply.send(result.body);
  } else {
    void reply.send({
      error: "NOT_FOUND",
      message: result.message,
    } satisfies ApiError);
  }
  return true;
}

/**
 * 静态资源是否可在带 TOKEN 时跳过 x-24os-token 校验。
 * 仅：启用了静态托管 + 回环监听 + GET/HEAD + 非 /api、/skill-ui 保留路径。
 * 非回环监听一律不豁免（安全基线不放松）。
 */
export function shouldBypassWebToken(
  method: string,
  rawUrl: string,
  webDistRoot: string | null,
  loopback: boolean,
): boolean {
  if (!webDistRoot || !loopback) return false;
  if (method !== "GET" && method !== "HEAD") return false;
  return !isReservedStaticPath(stripQuery(rawUrl));
}
