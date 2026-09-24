import { parse as parseYaml } from "yaml";
import type {
  PanelAction,
  PanelField,
  PanelFieldType,
  PanelOption,
  PanelPreview,
  PanelPreviewKind,
  PanelSpec,
  PanelTemplates,
  PanelView,
} from "@shared/types";
import { PANEL_FIELD_TYPES, PANEL_PROTOCOL } from "@shared/types";

/**
 * 声明式 Skill UI（`24os-skill-panel/1`）的解析与校验。
 *
 * 设计取舍：
 * - 与 `discover.ts#parseManifest` 保持一致，采用**手写校验**而非引入 zod，
 *   保持依赖最小（AGENTS.md 要求）并与现有风格统一；
 * - `validatePanel` 返回带原因的失败（便于路由/日志），`parsePanel` 为宽松包装
 *   （非法即视为“无 UI”），`parsePanelYaml` 负责 YAML 文本解析。
 *
 * 校验规则（v1）：
 *   - `protocol` 必须为 `24os-skill-panel/1`；
 *   - `skill` / `title` 必填；
 *   - `view` ∈ {form, wizard}（缺省 form；wizard 当前按 form 渲染）；
 *   - `fields[].type` ∈ PANEL_FIELD_TYPES；`key` 唯一且匹配 `[A-Za-z_][A-Za-z0-9_]*`；
 *   - `select` 必须提供非空 `options` 或 `options_from`；
 *   - `actions[].kind` 恒为 `prompt`，`prompt` 必填非空，`id` 唯一。
 */

export type PanelValidation =
  | { ok: true; spec: PanelSpec }
  | { ok: false; error: string };

const FIELD_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const VIEWS: readonly PanelView[] = ["form", "wizard"];
const PREVIEW_KINDS: readonly PanelPreviewKind[] = ["iframe", "markdown", "none"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 取非空字符串（不 trim 内容本身，仅判空时 trim）。 */
function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asTrimmed(value: unknown): string | undefined {
  const s = asString(value)?.trim();
  return s ? s : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 规范化 select 的 options；返回 undefined=未提供，null=非法。 */
function normalizeOptions(raw: unknown): PanelOption[] | null | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return null;
  const options: PanelOption[] = [];
  for (const item of raw) {
    if (typeof item === "string" && item.trim() !== "") {
      options.push({ value: item, label: item });
      continue;
    }
    if (isRecord(item)) {
      const value = asTrimmed(item.value);
      if (!value) return null;
      const label = asTrimmed(item.label);
      options.push(label ? { value, label } : { value });
      continue;
    }
    return null;
  }
  return options;
}

/** 校验单个字段。 */
function validateField(
  raw: unknown,
  index: number,
): { field: PanelField } | { error: string } {
  if (!isRecord(raw)) return { error: `fields[${index}] 必须是对象` };

  const key = asTrimmed(raw.key);
  if (!key || !FIELD_KEY.test(key)) {
    return { error: `fields[${index}].key 非法（需匹配 ${FIELD_KEY.source}）` };
  }
  const label = asTrimmed(raw.label);
  if (!label) return { error: `字段 ${key} 缺少 label` };

  const type = asString(raw.type);
  if (!type || !(PANEL_FIELD_TYPES as readonly string[]).includes(type)) {
    return { error: `字段 ${key} 的 type 非法：${type ?? "(空)"}` };
  }

  const field: PanelField = { key, label, type: type as PanelFieldType };

  if (raw.required !== undefined) {
    if (typeof raw.required !== "boolean") {
      return { error: `字段 ${key} 的 required 必须为布尔值` };
    }
    field.required = raw.required;
  }

  const placeholder = asTrimmed(raw.placeholder);
  if (placeholder) field.placeholder = placeholder;

  if (raw.default !== undefined) {
    const def = raw.default;
    if (typeof def === "string" || asFiniteNumber(def) !== undefined) {
      field.default = def as string | number;
    } else {
      return { error: `字段 ${key} 的 default 必须为字符串或数字` };
    }
  }

  if (field.type === "slider") {
    const min = asFiniteNumber(raw.min);
    const max = asFiniteNumber(raw.max);
    const step = asFiniteNumber(raw.step);
    if (raw.min !== undefined && min === undefined) return { error: `字段 ${key} 的 min 必须为数字` };
    if (raw.max !== undefined && max === undefined) return { error: `字段 ${key} 的 max 必须为数字` };
    if (raw.step !== undefined && step === undefined) return { error: `字段 ${key} 的 step 必须为数字` };
    if (min !== undefined && max !== undefined && min > max) {
      return { error: `字段 ${key} 的 min 不能大于 max` };
    }
    if (min !== undefined) field.min = min;
    if (max !== undefined) field.max = max;
    if (step !== undefined) field.step = step;
  }

  if (field.type === "select") {
    const options = normalizeOptions(raw.options);
    if (options === null) return { error: `字段 ${key} 的 options 非法` };
    const optionsFrom = asTrimmed(raw.options_from);
    if ((!options || options.length === 0) && !optionsFrom) {
      return { error: `select 字段 ${key} 需要 options 或 options_from` };
    }
    if (options && options.length > 0) field.options = options;
    if (optionsFrom) field.options_from = optionsFrom;
  }

  return { field };
}

/** 校验并规范化一个声明式面板对象。 */
export function validatePanel(raw: unknown): PanelValidation {
  if (!isRecord(raw)) return { ok: false, error: "panel 必须是对象" };

  const protocol = asString(raw.protocol);
  if (protocol !== PANEL_PROTOCOL) {
    return { ok: false, error: `protocol 必须为 ${PANEL_PROTOCOL}` };
  }

  const skill = asTrimmed(raw.skill);
  if (!skill) return { ok: false, error: "skill 必填" };
  const title = asTrimmed(raw.title);
  if (!title) return { ok: false, error: "title 必填" };

  const viewRaw = raw.view === undefined ? "form" : asString(raw.view);
  if (!viewRaw || !VIEWS.includes(viewRaw as PanelView)) {
    return { ok: false, error: `view 必须为 ${VIEWS.join(" | ")}` };
  }

  const description = asTrimmed(raw.description);

  if (raw.fields !== undefined && !Array.isArray(raw.fields)) {
    return { ok: false, error: "fields 必须是数组" };
  }
  const rawFields = Array.isArray(raw.fields) ? raw.fields : [];
  const fields: PanelField[] = [];
  const seenKeys = new Set<string>();
  for (let i = 0; i < rawFields.length; i += 1) {
    const result = validateField(rawFields[i], i);
    if ("error" in result) return { ok: false, error: result.error };
    if (seenKeys.has(result.field.key)) {
      return { ok: false, error: `字段 key 重复：${result.field.key}` };
    }
    seenKeys.add(result.field.key);
    fields.push(result.field);
  }

  let templates: PanelTemplates | undefined;
  if (raw.templates !== undefined) {
    if (!isRecord(raw.templates)) return { ok: false, error: "templates 必须是对象" };
    const dir = asTrimmed(raw.templates.dir);
    const index = asTrimmed(raw.templates.index);
    templates = { ...(dir ? { dir } : {}), ...(index ? { index } : {}) };
  }

  let preview: PanelPreview | undefined;
  if (raw.preview !== undefined) {
    if (!isRecord(raw.preview)) return { ok: false, error: "preview 必须是对象" };
    const kind = (asString(raw.preview.kind) ?? "none") as PanelPreviewKind;
    if (!PREVIEW_KINDS.includes(kind)) {
      return { ok: false, error: `preview.kind 必须为 ${PREVIEW_KINDS.join(" | ")}` };
    }
    const source = asTrimmed(raw.preview.source);
    if (kind !== "none" && !source) {
      return { ok: false, error: `preview.kind=${kind} 需要 source` };
    }
    preview = { kind, ...(source ? { source } : {}) };
  }

  if (raw.actions !== undefined && !Array.isArray(raw.actions)) {
    return { ok: false, error: "actions 必须是数组" };
  }
  const rawActions = Array.isArray(raw.actions) ? raw.actions : [];
  const actions: PanelAction[] = [];
  const seenActionIds = new Set<string>();
  for (let i = 0; i < rawActions.length; i += 1) {
    const item = rawActions[i];
    if (!isRecord(item)) return { ok: false, error: `actions[${i}] 必须是对象` };
    const id = asTrimmed(item.id);
    if (!id) return { ok: false, error: `actions[${i}] 缺少 id` };
    const label = asTrimmed(item.label);
    if (!label) return { ok: false, error: `action ${id} 缺少 label` };
    const kind = asString(item.kind);
    if (kind !== "prompt") return { ok: false, error: `action ${id} 的 kind 必须为 prompt` };
    const prompt = asString(item.prompt);
    if (!prompt || prompt.trim() === "") {
      return { ok: false, error: `action ${id} 缺少 prompt` };
    }
    if (seenActionIds.has(id)) return { ok: false, error: `action id 重复：${id}` };
    seenActionIds.add(id);
    actions.push({ id, label, kind: "prompt", prompt });
  }

  return {
    ok: true,
    spec: {
      protocol,
      skill,
      title,
      view: viewRaw as PanelView,
      ...(description ? { description } : {}),
      fields,
      ...(templates ? { templates } : {}),
      ...(preview ? { preview } : {}),
      actions,
    },
  };
}

/** 解析 `ui/panel.yaml` 文本并校验。 */
export function parsePanelYaml(text: string): PanelValidation {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    return { ok: false, error: `YAML 解析失败：${(error as Error).message}` };
  }
  return validatePanel(raw);
}

/** 宽松包装：非法返回 null（视为无声明式 UI）。 */
export function parsePanel(raw: unknown): PanelSpec | null {
  const result = validatePanel(raw);
  return result.ok ? result.spec : null;
}
