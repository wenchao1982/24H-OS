import type { AgentsResponse } from "@shared/types";
import { buildStatus, decideMode, detectHermes } from "./detect";
import { getMockAgents } from "./mock";
import { readProfiles } from "./profiles";

/**
 * Hermes 内核桥接层的聚合入口。
 * 一次探测 + 读取，产出 { agents, status } 快照；结果做进程内缓存（带 TTL）。
 *
 * 写操作（lifecycle / configEdit / appmanifest apply）成功后必须调用
 * invalidateAgentsCache()，让下一次 getSnapshot() 立即反映磁盘新数据（不等 TTL）。
 */

/** 缓存存活时间（毫秒），默认 2000ms，可用 OS_CACHE_TTL_MS 覆盖。<=0 表示不缓存。 */
const CACHE_TTL_MS = (() => {
  const raw = process.env.OS_CACHE_TTL_MS;
  if (raw === undefined || raw.trim() === "") return 2000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 2000;
})();

interface CacheEntry {
  value: Promise<AgentsResponse>;
  expiresAt: number;
}

let cache: CacheEntry | null = null;

async function computeSnapshot(): Promise<AgentsResponse> {
  const detection = await detectHermes();
  const mode = decideMode(detection);
  const agents =
    mode === "live" ? readProfiles(detection.activeHome) : getMockAgents();
  const status = buildStatus(detection, mode, agents.length);
  return { agents, status };
}

/** 获取当前快照（带 TTL 缓存；过期后重新读取磁盘）。 */
export function getSnapshot(): Promise<AgentsResponse> {
  const now = Date.now();
  if (cache && CACHE_TTL_MS > 0 && now < cache.expiresAt) {
    return cache.value;
  }

  const value = computeSnapshot().catch((error: unknown) => {
    cache = null; // 失败不缓存，允许下次重试。
    throw error;
  });
  cache = { value, expiresAt: now + CACHE_TTL_MS };
  return value;
}

/**
 * 失效 agents 快照缓存（写操作后调用；不触发重算）。
 * 覆盖：lifecycle install/update/delete/backup、configEdit 各写入、
 * appmanifest apply（install/update/uninstall/rollback）。
 */
export function invalidateAgentsCache(): void {
  cache = null;
}

/** 清空缓存并重新探测（写操作后需要立即拿到新快照时用）。 */
export function refreshSnapshot(): Promise<AgentsResponse> {
  cache = null;
  return getSnapshot();
}
