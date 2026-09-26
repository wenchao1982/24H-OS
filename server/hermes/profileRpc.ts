import { lifecycleError } from "./errors";

/**
 * 官方 Profile RPC 薄封装（M9）。
 *
 * 一个 Hermes profile = 一个 agent。工作台把「身份 / 配置」对齐到官方原语
 * （profile = Bot），而不是自研 `meta.json`：
 *   - `profiles.list`       roster（含 description / display_name / has_avatar）；
 *   - `profiles.describe`   编辑器快照（soul / description / model / skills / mcp_servers）；
 *   - `profiles.configure`  Editor Save（soul / description / disabled_skills / model …）；
 *   - `profiles.create`     创建 profile（含 soul）；
 *   - `profiles.set_asset` / `profiles.get_asset`  头像（PNG/JPEG/WebP）。
 *
 * 契约来源（只读参考，未修改）：
 *   ~/hermes-desktop/home/hermes-agent/tui_gateway/contracts/profiles_vault_complete_foreign_subagents.py
 *     → `profiles.*` 参数 / 结果形状；
 *   ~/hermes-desktop/home/hermes-agent/tui_gateway/methods_profiles.py
 *     → handler：soul → `<profileDir>/SOUL.md`；description → `<profileDir>/profile.yaml`；
 *       disabled_skills → `config.yaml skills.disabled`；头像 → `<profileDir>/assets/avatar.<ext>`。
 *
 * 安全 / 风格：与 `cron.ts` 一致——不引新依赖，统一结构化错误，RPC 客户端可注入（测试）。
 * 传输层不可用（gateway 未起 / 超时 / 无 CLI）保留 GATEWAY_* 与 HERMES_CLI_UNAVAILABLE 语义，
 * 便于调用方决定「回退文件写」；官方返回的业务错误归一为 PROFILE_RPC_ERROR / PROFILE_NOT_FOUND。
 */

/** profile 名合法格式（与仓库 id / 官方 `_PROFILE_ID_RE` 一致）。 */
export const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** 工作台层头像大小上限（官方 2MB；工作台收紧到 256KB 防滥用）。 */
export const AVATAR_MAX_BYTES = 256 * 1024;

/** gateway 客户端的最小结构（`GatewayClient` 天然满足）。 */
export interface ProfileRpcClient {
  call<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ): Promise<T>;
}

/** 依赖注入（测试用；生产全部走默认）。 */
export interface ProfileRpcDeps {
  /** 直接注入客户端（测试）。 */
  client?: ProfileRpcClient;
  /** 客户端解析函数（默认 detectHermes + ensureGateway）。 */
  getClient?: () => Promise<ProfileRpcClient>;
  /** RPC 默认超时（毫秒），默认 30000。 */
  timeoutMs?: number;
}

/* ------------------------------------------------------------------ *
 * 结果形状（snake_case → camelCase 归一）
 * ------------------------------------------------------------------ */

/** `profiles.list` 的一行。 */
export interface ProfileListRow {
  name: string;
  path: string;
  isDefault: boolean;
  model: string | null;
  provider: string | null;
  description: string;
  displayName: string;
  skillCount: number;
  hasAvatar: boolean;
  [key: string]: unknown;
}

/** `profiles.list` 结果。 */
export interface ProfileListResult {
  profiles: ProfileListRow[];
  /** 后端是否自带 bot_mode 协议（客户端不应再往 SOUL.md 追加协议文本）。 */
  botModeProtocol: boolean;
}

/** `profiles.describe` 归一结果。 */
export interface ProfileDescribe {
  name: string;
  description: string;
  soul: string;
  model: { provider: string; default: string };
  skills: Array<{ name: string; enabled: boolean }>;
  mcpServers: Array<{ name: string; enabled: boolean; transport: string }>;
  toolsetsPinned: boolean;
}

/** `profiles.configure` 的补丁（仅提供需修改的 section）。 */
export interface ProfileConfigurePatch {
  soul?: string;
  description?: string;
  model?: string;
  provider?: string;
  confirmExpensiveModel?: boolean;
  disabledSkills?: string[];
  enabledToolsets?: string[];
  enabledMcpServers?: string[];
}

/** `profiles.configure` 归一结果。 */
export interface ProfileConfigureResult {
  ok: boolean;
  applied: Record<string, boolean>;
  /** 昂贵 / 受限模型需二次确认：true 表示尚未写入，客户端应带 `confirm_expensive_model` 重试。 */
  confirmRequired: boolean;
  confirmMessage: string | null;
}

/** `profiles.create` 参数。 */
export interface ProfileCreateParams {
  name: string;
  description?: string;
  cloneFrom?: string;
  cloneAll?: boolean;
  cloneChannels?: boolean;
  noSkills?: boolean;
  noAlias?: boolean;
  soul?: string;
  model?: string;
  provider?: string;
  shareAuth?: boolean;
  mirrorCredentials?: boolean;
}

/** `profiles.create` 归一结果。 */
export interface ProfileCreateResult {
  ok: boolean;
  name: string;
  path: string;
  soulWritten: boolean;
  modelSet: boolean;
}

/** `profiles.get_asset` 归一结果（不存在是 `found:false`，不是错误）。 */
export interface ProfileAssetResult {
  found: boolean;
  mime: string | null;
  size: number | null;
  /** data URL（`data:<mime>;base64,...`）。 */
  data: string | null;
}

/** `profiles.set_asset` 归一结果。 */
export interface ProfileSetAssetResult {
  ok: boolean;
  asset: string;
  size: number;
  removed: number | null;
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 校验 profile 名，非法抛 INVALID_NAME。 */
export function validateProfileName(name: unknown): string {
  const value = typeof name === "string" ? name.trim() : "";
  if (!value || !PROFILE_NAME_PATTERN.test(value)) {
    throw lifecycleError(
      "INVALID_NAME",
      `非法 profile 名：${String(name)}（需匹配 ^[a-z0-9][a-z0-9_-]{0,63}$）`,
    );
  }
  return value;
}

/** 把 gateway / 官方错误归一化为结构化 Profile 错误。 */
function toProfileError(error: unknown): Error {
  const code = (error as { code?: string } | null)?.code;
  if (code === "GATEWAY_RPC_ERROR" || code === "PROFILE_RPC_ERROR") {
    const message = (error as Error).message;
    if (/not found|does not exist|不存在|unknown profile/i.test(message)) {
      return lifecycleError("PROFILE_NOT_FOUND", message);
    }
    return lifecycleError(
      "PROFILE_RPC_ERROR",
      `官方 Profile 返回错误：${message}`,
    );
  }
  // 传输层不可用 / 超时 / 无 CLI：保留原错误码（PROFILE 层归一由调用方决定回退）。
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * 默认客户端：detectHermes → ensureGateway（复用共享 gateway）。
 * 未检测到 CLI 时抛 HERMES_CLI_UNAVAILABLE（调用方据此回退文件写）。
 */
async function defaultGetClient(): Promise<ProfileRpcClient> {
  const { detectHermes } = await import("./detect");
  const detection = await detectHermes();
  if (!detection.cliPath) {
    throw lifecycleError(
      "HERMES_CLI_UNAVAILABLE",
      "未检测到可用的 hermes CLI，无法访问官方 Profile。",
    );
  }
  const { ensureGateway } = await import("./gateway");
  const entry = await ensureGateway(detection.cliPath);
  return entry.client;
}

async function callProfile(
  method: string,
  params: Record<string, unknown>,
  deps: ProfileRpcDeps,
): Promise<Record<string, unknown>> {
  const client = deps.client ?? (await (deps.getClient ?? defaultGetClient)());
  try {
    const result = await client.call<unknown>(method, params, {
      timeoutMs: deps.timeoutMs,
    });
    return asRecord(result);
  } catch (error) {
    throw toProfileError(error);
  }
}

/* ------------------------------------------------------------------ *
 * profiles.list / describe / configure / create
 * ------------------------------------------------------------------ */

function normalizeListRow(raw: unknown): ProfileListRow {
  const obj = asRecord(raw);
  return {
    ...obj,
    name: asString(obj.name),
    path: asString(obj.path),
    isDefault: obj.is_default === true,
    model: asStringOrNull(obj.model),
    provider: asStringOrNull(obj.provider),
    description: asString(obj.description),
    displayName: asString(obj.display_name),
    skillCount: typeof obj.skill_count === "number" ? obj.skill_count : 0,
    hasAvatar: obj.has_avatar === true,
  };
}

/** 列出所有 profile（官方 roster）。 */
export async function listProfiles(
  options: { includeSessions?: boolean } = {},
  deps: ProfileRpcDeps = {},
): Promise<ProfileListResult> {
  const params: Record<string, unknown> = {};
  if (options.includeSessions !== undefined) {
    params.include_sessions = options.includeSessions;
  }
  const result = await callProfile("profiles.list", params, deps);
  const rows = Array.isArray(result.profiles) ? result.profiles : [];
  return {
    profiles: rows.map(normalizeListRow),
    botModeProtocol: result.bot_mode_protocol !== false,
  };
}

/** 读取单个 profile 的编辑器快照（soul / description / skills / mcp）。 */
export async function describeProfile(
  name: unknown,
  deps: ProfileRpcDeps = {},
): Promise<ProfileDescribe> {
  const profile = validateProfileName(name);
  const result = await callProfile("profiles.describe", { name: profile }, deps);
  const model = asRecord(result.model);
  const skills = Array.isArray(result.skills) ? result.skills : [];
  const mcp = Array.isArray(result.mcp_servers) ? result.mcp_servers : [];
  return {
    name: asString(result.name) || profile,
    description: asString(result.description),
    soul: asString(result.soul),
    model: {
      provider: asString(model.provider),
      default: asString(model.default),
    },
    skills: skills.map((item) => {
      const obj = asRecord(item);
      return { name: asString(obj.name), enabled: obj.enabled !== false };
    }),
    mcpServers: mcp.map((item) => {
      const obj = asRecord(item);
      return {
        name: asString(obj.name),
        enabled: obj.enabled !== false,
        transport: asString(obj.transport) || "stdio",
      };
    }),
    toolsetsPinned: result.toolsets_pinned === true,
  };
}

/** Editor Save：应用任意 section 子集（soul / description / disabled_skills / model …）。 */
export async function configureProfile(
  name: unknown,
  patch: ProfileConfigurePatch,
  deps: ProfileRpcDeps = {},
): Promise<ProfileConfigureResult> {
  const profile = validateProfileName(name);
  const params: Record<string, unknown> = { name: profile };
  if (patch.soul !== undefined) params.soul = patch.soul;
  if (patch.description !== undefined) params.description = patch.description;
  if (patch.model !== undefined) params.model = patch.model;
  if (patch.provider !== undefined) params.provider = patch.provider;
  if (patch.confirmExpensiveModel !== undefined) {
    params.confirm_expensive_model = patch.confirmExpensiveModel;
  }
  if (patch.disabledSkills !== undefined) params.disabled_skills = patch.disabledSkills;
  if (patch.enabledToolsets !== undefined) {
    params.enabled_toolsets = patch.enabledToolsets;
  }
  if (patch.enabledMcpServers !== undefined) {
    params.enabled_mcp_servers = patch.enabledMcpServers;
  }
  const result = await callProfile("profiles.configure", params, deps);
  const applied = asRecord(result.applied);
  const normalized: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(applied)) {
    if (typeof value === "boolean") normalized[key] = value;
  }
  return {
    ok: result.ok !== false,
    applied: normalized,
    confirmRequired: result.confirm_required === true,
    confirmMessage:
      typeof result.confirm_message === "string" ? result.confirm_message : null,
  };
}

/** 创建 profile（含 soul）。 */
export async function createProfile(
  input: ProfileCreateParams,
  deps: ProfileRpcDeps = {},
): Promise<ProfileCreateResult> {
  const name = validateProfileName(input.name);
  const params: Record<string, unknown> = { name };
  if (input.description !== undefined) params.description = input.description;
  if (input.cloneFrom !== undefined) params.clone_from = input.cloneFrom;
  if (input.cloneAll !== undefined) params.clone_all = input.cloneAll;
  if (input.cloneChannels !== undefined) params.clone_channels = input.cloneChannels;
  if (input.noSkills !== undefined) params.no_skills = input.noSkills;
  if (input.noAlias !== undefined) params.no_alias = input.noAlias;
  if (input.soul !== undefined) params.soul = input.soul;
  if (input.model !== undefined) params.model = input.model;
  if (input.provider !== undefined) params.provider = input.provider;
  if (input.shareAuth !== undefined) params.share_auth = input.shareAuth;
  if (input.mirrorCredentials !== undefined) {
    params.mirror_credentials = input.mirrorCredentials;
  }
  const result = await callProfile("profiles.create", params, deps);
  return {
    ok: result.ok !== false,
    name: asString(result.name) || name,
    path: asString(result.path),
    soulWritten: result.soul_written === true,
    modelSet: result.model_set === true,
  };
}

/* ------------------------------------------------------------------ *
 * profiles.get_asset / set_asset（头像）
 * ------------------------------------------------------------------ */

/** 读取 profile 资源（默认 avatar）；不存在返回 `{found:false}`。 */
export async function getProfileAsset(
  name: unknown,
  asset = "avatar",
  deps: ProfileRpcDeps = {},
): Promise<ProfileAssetResult> {
  const profile = validateProfileName(name);
  const result = await callProfile(
    "profiles.get_asset",
    { name: profile, asset },
    deps,
  );
  return {
    found: result.found === true,
    mime: asStringOrNull(result.mime),
    size: asNumberOrNull(result.size),
    data: asStringOrNull(result.data),
  };
}

/** 写入 profile avatar（data URL / base64 由调用方先校验）。 */
export async function setProfileAsset(
  name: unknown,
  data: string,
  deps: ProfileRpcDeps = {},
): Promise<ProfileSetAssetResult> {
  const profile = validateProfileName(name);
  const result = await callProfile(
    "profiles.set_asset",
    { name: profile, asset: "avatar", data },
    deps,
  );
  return {
    ok: result.ok !== false,
    asset: asString(result.asset) || "avatar",
    size: typeof result.size === "number" ? result.size : 0,
    removed: asNumberOrNull(result.removed),
  };
}

/* ------------------------------------------------------------------ *
 * 头像上传校验（大小 + 类型，防滥用）
 * ------------------------------------------------------------------ */

/** 校验通过的头像上传。 */
export interface AvatarUpload {
  /** 规范化后的 data URL（`data:image/png;base64,...`）。 */
  dataUrl: string;
  bytes: number;
  mime: "image/png" | "image/jpeg";
}

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/** 按魔数嗅探图片格式；非 PNG/JPEG 返回 null。 */
function sniffImage(blob: Buffer): "image/png" | "image/jpeg" | null {
  if (blob.length >= 8 && blob.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (blob.length >= 3 && blob[0] === 0xff && blob[1] === 0xd8 && blob[2] === 0xff) {
    return "image/jpeg";
  }
  return null;
}

/**
 * 校验头像 data URL / base64：必须是 PNG/JPEG 且 ≤ `maxBytes`（默认 256KB）。
 * 失败抛 INVALID_ASSET（不区分「太大 / 类型不对」以外细节，避免泄露）。
 */
export function validateAvatarData(
  raw: unknown,
  maxBytes: number = AVATAR_MAX_BYTES,
): AvatarUpload {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw lifecycleError("INVALID_ASSET", "头像 data 不能为空（data URL 或 base64）。");
  }
  const text = raw.trim();
  let base64 = text;
  const match = /^data:(image\/(?:png|jpeg|jpg));base64,([\s\S]*)$/i.exec(text);
  if (match) base64 = match[2];
  base64 = base64.replace(/\s+/g, "");
  if (!base64 || !BASE64_PATTERN.test(base64)) {
    throw lifecycleError("INVALID_ASSET", "头像 data 不是合法 base64。");
  }
  const blob = Buffer.from(base64, "base64");
  if (blob.length === 0) {
    throw lifecycleError("INVALID_ASSET", "头像 data 解码为空。");
  }
  if (blob.length > maxBytes) {
    throw lifecycleError(
      "INVALID_ASSET",
      `头像过大（${blob.length} bytes；上限 ${maxBytes} bytes）。`,
    );
  }
  const mime = sniffImage(blob);
  if (!mime) {
    throw lifecycleError("INVALID_ASSET", "仅支持 PNG / JPEG 头像。");
  }
  return {
    dataUrl: `data:${mime};base64,${blob.toString("base64")}`,
    bytes: blob.length,
    mime,
  };
}
