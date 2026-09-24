import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { MarketEntry, MarketResponse } from "@shared/types";

/**
 * 小市场（M2-core）。
 * 读取仓库内 `market/index.json`，返回静态的可安装 distribution 列表。
 * 文件不存在 / 解析失败时降级为空列表 + 说明，绝不抛异常。
 */

/** 仓库根目录（server/market.ts → ../）。 */
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/** market/index.json 的绝对路径（可用 OS_MARKET_FILE 覆盖，便于测试）。 */
export function getMarketFile(): string {
  const override = process.env.OS_MARKET_FILE?.trim();
  return override && override.length > 0
    ? override
    : path.join(REPO_ROOT, "market", "index.json");
}

/** 规范化单个条目；缺关键字段则丢弃。 */
function normalizeEntry(raw: unknown): MarketEntry | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;

  const id = typeof obj.id === "string" ? obj.id.trim() : "";
  const name = typeof obj.name === "string" ? obj.name.trim() : "";
  const source = typeof obj.source === "string" ? obj.source.trim() : "";
  if (!id || !name || !source) return null;

  const version = typeof obj.version === "string" ? obj.version : undefined;
  const tags = Array.isArray(obj.tags)
    ? obj.tags.filter((tag): tag is string => typeof tag === "string")
    : undefined;

  return {
    id,
    name,
    description: typeof obj.description === "string" ? obj.description : "",
    source,
    ...(version ? { version } : {}),
    ...(tags ? { tags } : {}),
  };
}

/** 读取并解析市场清单。 */
export function readMarket(): MarketResponse {
  const file = getMarketFile();

  if (!existsSync(file)) {
    return {
      entries: [],
      message: `未找到市场清单（${path.relative(REPO_ROOT, file) || file}），当前市场为空。`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return {
      entries: [],
      message: `市场清单解析失败：${(error as Error).message}`,
    };
  }

  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { entries?: unknown }).entries)
      ? ((parsed as { entries: unknown[] }).entries)
      : [];

  const entries = list
    .map(normalizeEntry)
    .filter((entry): entry is MarketEntry => entry !== null);

  return {
    entries,
    message: `市场共 ${entries.length} 个可安装 distribution。`,
  };
}
