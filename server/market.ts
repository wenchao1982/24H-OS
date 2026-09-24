import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { MarketEntry, MarketResponse } from "@shared/types";
import { APP_ROOT } from "./paths";
import {
  findBuiltinAppManifest,
  listBuiltinAppManifests,
} from "./appmanifest/manifest";

/**
 * 小市场（M2-core，M6 增强）。
 * 读取仓库内 `market/index.json`，返回静态的可安装 distribution 列表。
 * M6：同 id 的 `market/apps/*.app.yaml`（AppManifest）会把 ui.host / hooks 等
 * 元信息合并进条目；仅存在于 apps 目录的 App 追加为新条目（appManifest: true）。
 * 文件不存在 / 解析失败时降级为空列表 + 说明，绝不抛异常。
 */

/** 仓库根目录（统一由 server/paths.ts 解析，兼容源码 / 打包形态）。 */
const REPO_ROOT = APP_ROOT;

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

  // 保留已合并的 AppManifest 字段（index.json 原始条目一般没有）。
  const uiHost =
    obj.uiHost === "iframe" || obj.uiHost === "declarative"
      ? obj.uiHost
      : undefined;

  return {
    id,
    name,
    description: typeof obj.description === "string" ? obj.description : "",
    source,
    ...(version ? { version } : {}),
    ...(tags ? { tags } : {}),
    ...(uiHost ? { uiHost } : {}),
    ...(obj.hooks && typeof obj.hooks === "object" && !Array.isArray(obj.hooks)
      ? { hooks: obj.hooks as MarketEntry["hooks"] }
      : {}),
    ...(obj.appManifest === true ? { appManifest: true } : {}),
  };
}

/** 读取并解析市场清单（index.json + market/apps/*.app.yaml 合并）。 */
export function readMarket(): MarketResponse {
  const file = getMarketFile();
  let entries: MarketEntry[] = [];
  // null 表示 index.json 正常读取：文案数量在合并 AppManifest 后按实际条目数动态生成。
  let baseMessage: string | null = null;

  if (!existsSync(file)) {
    baseMessage = `未找到市场清单（${path.relative(REPO_ROOT, file) || file}），仅显示 AppManifest 条目。`;
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      baseMessage = `市场清单解析失败：${(error as Error).message}`;
      parsed = null;
    }

    if (parsed !== null) {
      const list = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === "object" && Array.isArray((parsed as { entries?: unknown }).entries)
          ? ((parsed as { entries: unknown[] }).entries)
          : [];
      entries = list
        .map(normalizeEntry)
        .filter((entry): entry is MarketEntry => entry !== null);
    }
  }

  // M6：合并 AppManifest 元信息 + 追加仅存在于 market/apps 的 App。
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  for (const app of listBuiltinAppManifests()) {
    const existing = byId.get(app.id);
    if (existing) {
      existing.version = app.version;
      existing.name = app.name;
      if (app.description) existing.description = app.description;
      if (app.ui?.host) existing.uiHost = app.ui.host;
      if (app.hooks) existing.hooks = app.hooks;
      existing.appManifest = true;
      continue;
    }
    const source =
      app.source.path ?? app.source.url ?? `app:${app.id}`;
    const appended: MarketEntry = {
      id: app.id,
      name: app.name,
      description: app.description ?? "",
      source,
      version: app.version,
      appManifest: true,
      ...(app.ui?.host ? { uiHost: app.ui.host } : {}),
      ...(app.hooks ? { hooks: app.hooks } : {}),
    };
    entries.push(appended);
    byId.set(app.id, appended);
  }

  const appCount = entries.filter((entry) => entry.appManifest).length;
  const rootMessage =
    baseMessage ?? `市场共 ${entries.length} 个可安装 distribution。`;
  const message =
    appCount > 0
      ? `${rootMessage.replace(/。$/, "")}（含 ${appCount} 个 AppManifest）。`
      : rootMessage;

  return { entries, message };
}

/** 按 id 读取解析后的 AppManifest（builtin market/apps）。 */
export function readMarketAppManifest(id: string): ReturnType<typeof findBuiltinAppManifest> {
  return findBuiltinAppManifest(id);
}
