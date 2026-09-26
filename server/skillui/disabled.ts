import path from "node:path";
import type { SkillUiInfo } from "@shared/types";
import { listDisabledSkillNames } from "../hermes/configEdit";

/**
 * Skill 启停聚合判定（与 `GET /api/skill-uis` 的 `disabled` 口径**完全一致**）。
 *
 * 口径（M9 对齐官方）：官方 `config.yaml skills.disabled` 优先（经
 * `configEdit#listDisabledSkillNames` 扫描），工作台 meta.json 的
 * `skills.<name>.enabled === false` 仅作回退；任一来源命中即禁用。键命中同时匹配
 * `SkillUiInfo.id` 与 skill 目录名（`path.basename(skillPath)`），大小写不敏感。
 *
 * 缓存：`listDisabledSkillNames` 每次直接读盘（不走 `invalidateAgentsCache`
 * 的 agent 快照缓存），写入后立即生效，无需额外失效。
 */

/** 判定用的键（小写化，与官方 disabled_skills 的 lower() 口径一致）。 */
function skillKeys(skill: Pick<SkillUiInfo, "id" | "skillPath">): string[] {
  return [skill.id, path.basename(skill.skillPath)]
    .filter((key) => key.length > 0)
    .map((key) => key.toLowerCase());
}

/** 单个 skill 是否被任一 agent 标记禁用。 */
export async function isSkillDisabled(
  skill: Pick<SkillUiInfo, "id" | "skillPath">,
): Promise<boolean> {
  const disabled = await listDisabledSkillNames();
  if (disabled.size === 0) return false;
  return skillKeys(skill).some((key) => disabled.has(key));
}

/** 给发现结果批量标注 `disabled:true`（与单个判定同一口径）。 */
export async function withDisabledFlags(
  items: SkillUiInfo[],
): Promise<SkillUiInfo[]> {
  if (items.length === 0) return items;
  const disabled = await listDisabledSkillNames();
  if (disabled.size === 0) return items;
  return items.map((item) =>
    skillKeys(item).some((key) => disabled.has(key))
      ? { ...item, disabled: true }
      : item,
  );
}
