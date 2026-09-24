/**
 * M4.1 声明式 Skill UI 的纯函数工具（前后端共用）。
 *
 * 这里只放**无副作用、无依赖**的逻辑：`{{field_key}}` 插值 + 缺失键检测。
 * panel.yaml 的解析/校验（依赖 yaml 库）放在 `server/skillui/panel.ts`，
 * 前端拿到的是服务端已解析好的 `PanelSpec`，无需在浏览器解析 YAML。
 */

/** 缺失字段的替换策略：empty=替换为空串；keep=原样保留；error=抛错。 */
export type MissingPolicy = "empty" | "keep" | "error";

/** 占位符匹配：`{{ key }}`（key 允许前后空白）。 */
const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/** 插值失败（missing="error" 且存在缺失键）。 */
export class PanelInterpolationError extends Error {
  readonly keys: string[];

  constructor(keys: string[]) {
    super(`缺少字段：${keys.join(", ")}`);
    this.name = "PanelInterpolationError";
    this.keys = keys;
  }
}

/** 字段值是否“存在”（null/undefined 视为缺失，空串视为有效值）。 */
function isMissing(values: Record<string, unknown>, key: string): boolean {
  if (!Object.prototype.hasOwnProperty.call(values, key)) return true;
  const value = values[key];
  return value === undefined || value === null;
}

/**
 * 列出模板中引用、但 values 里缺失（无该键 / 值为 null|undefined）的字段名，
 * 去重并保持首次出现顺序。
 */
export function findMissingKeys(
  template: string,
  values: Record<string, unknown> = {},
): string[] {
  if (typeof template !== "string") return [];
  const missing: string[] = [];
  const seen = new Set<string>();
  const re = new RegExp(PLACEHOLDER.source, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(template)) !== null) {
    const key = match[1];
    if (!seen.has(key) && isMissing(values, key)) {
      seen.add(key);
      missing.push(key);
    }
  }
  return missing;
}

/**
 * 把 `prompt` 里的 `{{key}}` 替换为 values[key]。
 *
 * - 缺省策略 `empty`：缺失键替换为空串；
 * - `keep`：缺失键保留原 `{{key}}` 文本；
 * - `error`：存在缺失键时抛 `PanelInterpolationError`。
 *
 * 值为 `0` / `false` / 空串都会按字符串原样替换（不算缺失）。
 */
export function interpolatePrompt(
  template: string,
  values: Record<string, unknown> = {},
  options: { missing?: MissingPolicy } = {},
): string {
  if (typeof template !== "string") return "";
  const missing = options.missing ?? "empty";

  if (missing === "error") {
    const keys = findMissingKeys(template, values);
    if (keys.length > 0) throw new PanelInterpolationError(keys);
  }

  return template.replace(new RegExp(PLACEHOLDER.source, "g"), (whole, key: string) => {
    if (isMissing(values, key)) return missing === "keep" ? whole : "";
    return String(values[key]);
  });
}
