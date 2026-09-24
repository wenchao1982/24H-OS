import path from "node:path";
import type { SkillUiInfo } from "@shared/types";
import { listDisabledSkillNames } from "../hermes/configEdit";

/**
 * Skill 启停聚合判定（与 `GET /api/skill-uis` 的 `disabled` 口径**完全一致**）。
 *
 * 口径：扫描所有 agent 的 `~/.24os/agents/<id>/meta.json`，任一 agent 的
 * `skills.<name>.enabled === false` 即视为禁用；键命中同时匹配
 * `SkillUiInfo.id` 与 skill 目录名（`path.basename(skillPath)`）。
 *
 * 缓存：`listDisabledSkillNames` 每次直接读盘（不走 `invalidateAgentsCache`
 * 的 agent 快照缓存），meta 写入后立即生效，无需额外失效。
 */

/** 单个 skill 是否被任一 agent meta 标记禁用。 */
export async function isSkillDisabled(
  skill: Pick<SkillUiInfo, "id" | "skillPath">,
): Promise<boolean> {
  const disabled = await listDisabledSkillNames();
  if (disabled.size === 0) return false;
  const keys = [skill.id, path.basename(skill.skillPath)];
  return keys.some((key) => disabled.has(key));
}

/** 给发现结果批量标注 `disabled:true`（与单个判定同一口径）。 */
export async function withDisabledFlags(
  items: SkillUiInfo[],
): Promise<SkillUiInfo[]> {
  if (items.length === 0) return items;
  const disabled = await listDisabledSkillNames();
  if (disabled.size === 0) return items;
  return items.map((item) => {
    const keys = [item.id, path.basename(item.skillPath)];
    return keys.some((key) => disabled.has(key))
      ? { ...item, disabled: true }
      : item;
  });
}
