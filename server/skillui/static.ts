import { statSync } from "node:fs";
import path from "node:path";

/**
 * Skill UI 静态托管的路径解析与响应头策略。
 *
 * 安全约束：
 *   - resolve 后必须仍位于该 skill 的 uiRoot 内（防目录穿越）；
 *   - 仅允许白名单扩展名；
 *   - 由路由统一附加严格 CSP + nosniff。
 */

/** 允许托管的文件扩展名（小写，含点）。 */
export const ALLOWED_UI_EXTENSIONS: readonly string[] = [
  ".html",
  ".js",
  ".css",
  ".json",
  ".png",
  ".svg",
  ".woff2",
  // M4.1：声明式面板需要托管 panel.yaml 与模板清单/预览。
  ".yaml",
  ".yml",
  ".md",
];

/** 严格 CSP：一切网络与能力调用都只能通过 RPC，UI 自身不允许联网。 */
export const SKILL_UI_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'self'; connect-src 'none'";

/** 扩展名 → Content-Type。 */
export function contentTypeFor(ext: string): string {
  switch (ext.toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    case ".woff2":
      return "font/woff2";
    case ".yaml":
    case ".yml":
      return "text/yaml; charset=utf-8";
    case ".md":
      return "text/markdown; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

/** 路径解析结果。 */
export interface ResolvedUiAsset {
  /** 相对 uiRoot 的路径（POSIX 分隔符，用于日志）。 */
  relative: string;
  /** 绝对文件路径。 */
  absolute: string;
  /** 扩展名（含点，小写）。 */
  ext: string;
}

/**
 * 把 URL 中的相对路径安全地解析到 uiRoot 内的真实文件。
 * 任何穿越、非白名单扩展名、非文件都会被拒绝（返回 null）。
 */
export function resolveUiAsset(
  uiRoot: string,
  relPath: string,
): ResolvedUiAsset | null {
  if (typeof relPath !== "string" || relPath.includes("\0")) return null;

  // 统一为 POSIX，去掉前导分隔符，空路径回退到 index.html。
  let cleaned = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (cleaned === "" || cleaned.endsWith("/")) {
    cleaned = `${cleaned}index.html`;
  }

  const root = path.resolve(uiRoot);
  const absolute = path.resolve(root, cleaned);

  // 必须仍在 root 内（root 本身不是文件，故需严格前缀 + 分隔符）。
  if (absolute !== root && !absolute.startsWith(root + path.sep)) {
    return null;
  }

  const ext = path.extname(absolute).toLowerCase();
  if (!ALLOWED_UI_EXTENSIONS.includes(ext)) return null;

  try {
    if (!statSync(absolute).isFile()) return null;
  } catch {
    return null;
  }

  return {
    relative: path.relative(root, absolute).split(path.sep).join("/"),
    absolute,
    ext,
  };
}
