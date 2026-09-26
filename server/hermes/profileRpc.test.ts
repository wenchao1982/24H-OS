import { afterEach, describe, expect, it } from "vitest";
import { LifecycleError } from "./errors";
import {
  AVATAR_MAX_BYTES,
  configureProfile,
  createProfile,
  describeProfile,
  getProfileAsset,
  listProfiles,
  setProfileAsset,
  validateAvatarData,
  validateProfileName,
  type ProfileRpcClient,
} from "./profileRpc";

/**
 * 官方 Profile RPC 薄封装单测：mock gateway 客户端，绝不连真实 gateway / 不触碰真实 home。
 */

/** 1x1 PNG（最小合法图）。 */
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

interface FakeRpc {
  client: ProfileRpcClient;
  calls: Array<{ method: string; params: Record<string, unknown> }>;
}

function makeFakeRpc(
  impl: (method: string, params: Record<string, unknown>) => unknown,
): FakeRpc {
  const calls: FakeRpc["calls"] = [];
  const client: ProfileRpcClient = {
    async call<T = unknown>(
      method: string,
      params: Record<string, unknown> = {},
    ): Promise<T> {
      calls.push({ method, params });
      const result = impl(method, params);
      if (result instanceof Error) throw result;
      return result as T;
    },
  };
  return { client, calls };
}

const savedCli = process.env.OS_HERMES_CLI;

afterEach(() => {
  if (savedCli === undefined) delete process.env.OS_HERMES_CLI;
  else process.env.OS_HERMES_CLI = savedCli;
});

describe("listProfiles", () => {
  it("调用 profiles.list 并归一化 roster", async () => {
    const rpc = makeFakeRpc(() => ({
      profiles: [
        {
          name: "alpha",
          path: "/home/u/.hermes/profiles/alpha",
          is_default: false,
          model: "deepseek/flash",
          provider: "deepseek",
          description: "运维 bot",
          display_name: "Alpha",
          skill_count: 2,
          has_avatar: true,
        },
      ],
      bot_mode_protocol: true,
    }));
    const result = await listProfiles({ includeSessions: false }, { client: rpc.client });
    expect(rpc.calls[0]).toEqual({
      method: "profiles.list",
      params: { include_sessions: false },
    });
    expect(result.botModeProtocol).toBe(true);
    expect(result.profiles[0]).toMatchObject({
      name: "alpha",
      isDefault: false,
      displayName: "Alpha",
      hasAvatar: true,
      skillCount: 2,
    });
  });
});

describe("describeProfile", () => {
  it("归一化 soul / model / skills / mcp", async () => {
    const rpc = makeFakeRpc(() => ({
      name: "alpha",
      description: "运维 bot",
      soul: "You are a careful ops bot.",
      model: { provider: "deepseek", default: "deepseek/flash" },
      skills: [{ name: "ppt", enabled: false }],
      mcp_servers: [{ name: "files", enabled: true, transport: "stdio" }],
      toolsets_pinned: true,
    }));
    const result = await describeProfile("alpha", { client: rpc.client });
    expect(rpc.calls[0]).toEqual({
      method: "profiles.describe",
      params: { name: "alpha" },
    });
    expect(result).toMatchObject({
      name: "alpha",
      description: "运维 bot",
      soul: "You are a careful ops bot.",
      model: { provider: "deepseek", default: "deepseek/flash" },
      skills: [{ name: "ppt", enabled: false }],
      mcpServers: [{ name: "files", enabled: true, transport: "stdio" }],
      toolsetsPinned: true,
    });
  });
});

describe("configureProfile", () => {
  it("透传 soul / description / disabled_skills 并归一 applied", async () => {
    const rpc = makeFakeRpc(() => ({
      ok: true,
      applied: { soul: true, skills: true },
    }));
    const result = await configureProfile(
      "alpha",
      { soul: "persona", description: "短描述", disabledSkills: ["ppt"] },
      { client: rpc.client },
    );
    expect(rpc.calls[0]).toEqual({
      method: "profiles.configure",
      params: { name: "alpha", soul: "persona", description: "短描述", disabled_skills: ["ppt"] },
    });
    expect(result).toMatchObject({
      ok: true,
      applied: { soul: true, skills: true },
      confirmRequired: false,
    });
  });

  it("confirm_required / confirm_message 透出", async () => {
    const rpc = makeFakeRpc(() => ({
      ok: false,
      applied: {},
      confirm_required: true,
      confirm_message: "expensive",
    }));
    const result = await configureProfile(
      "alpha",
      { model: "gpt-5", provider: "openai" },
      { client: rpc.client },
    );
    expect(result.confirmRequired).toBe(true);
    expect(result.confirmMessage).toBe("expensive");
  });
});

describe("createProfile", () => {
  it("camelCase → snake_case 并归一", async () => {
    const rpc = makeFakeRpc(() => ({
      ok: true,
      name: "beta",
      path: "/home/u/.hermes/profiles/beta",
      soul_written: true,
      model_set: false,
    }));
    const result = await createProfile(
      { name: "beta", soul: "hi", noAlias: true, mirrorCredentials: false },
      { client: rpc.client },
    );
    expect(rpc.calls[0]).toEqual({
      method: "profiles.create",
      params: { name: "beta", soul: "hi", no_alias: true, mirror_credentials: false },
    });
    expect(result).toMatchObject({ ok: true, soulWritten: true, modelSet: false });
  });
});

describe("头像 assets", () => {
  it("getProfileAsset：missing 返回 found:false", async () => {
    const rpc = makeFakeRpc(() => ({ found: false }));
    const result = await getProfileAsset("alpha", "avatar", { client: rpc.client });
    expect(rpc.calls[0]).toEqual({
      method: "profiles.get_asset",
      params: { name: "alpha", asset: "avatar" },
    });
    expect(result).toEqual({ found: false, mime: null, size: null, data: null });
  });

  it("setProfileAsset：透传 data 并归一", async () => {
    const rpc = makeFakeRpc(() => ({ ok: true, asset: "avatar", size: 68 }));
    const result = await setProfileAsset("alpha", `data:image/png;base64,${PNG_1X1}`, {
      client: rpc.client,
    });
    expect(rpc.calls[0].method).toBe("profiles.set_asset");
    expect(rpc.calls[0].params.asset).toBe("avatar");
    expect(result).toMatchObject({ ok: true, asset: "avatar", size: 68 });
  });
});

describe("错误归一化", () => {
  it("GATEWAY_RPC_ERROR not found → PROFILE_NOT_FOUND；其它 → PROFILE_RPC_ERROR", async () => {
    const notFound = makeFakeRpc(
      () => new LifecycleError("GATEWAY_RPC_ERROR", "profile 'x' not found"),
    );
    await expect(
      describeProfile("x", { client: notFound.client }),
    ).rejects.toMatchObject({ code: "PROFILE_NOT_FOUND" });

    const other = makeFakeRpc(() => new LifecycleError("GATEWAY_RPC_ERROR", "boom"));
    await expect(
      configureProfile("alpha", { soul: "x" }, { client: other.client }),
    ).rejects.toMatchObject({ code: "PROFILE_RPC_ERROR" });
  });

  it("传输层不可用保留原错误码（不误判为 not found）", async () => {
    const down = makeFakeRpc(
      () => new LifecycleError("GATEWAY_UNAVAILABLE", "down"),
    );
    await expect(
      listProfiles({}, { client: down.client }),
    ).rejects.toMatchObject({ code: "GATEWAY_UNAVAILABLE" });
  });

  it("无可用 CLI → HERMES_CLI_UNAVAILABLE（不回退探测 / 不 spawn）", async () => {
    process.env.OS_HERMES_CLI = "/tmp/24os-definitely-missing-hermes";
    await expect(listProfiles()).rejects.toMatchObject({
      code: "HERMES_CLI_UNAVAILABLE",
    });
  });
});

describe("validateProfileName / validateAvatarData", () => {
  it("非法 profile 名 → INVALID_NAME", () => {
    expect(validateProfileName("alpha-1")).toBe("alpha-1");
    expect(() => validateProfileName("Bad Name")).toThrow(LifecycleError);
    expect(() => validateProfileName("")).toThrow(LifecycleError);
  });

  it("合法 PNG data URL 通过并规范化", () => {
    const upload = validateAvatarData(`data:image/png;base64,${PNG_1X1}`);
    expect(upload.mime).toBe("image/png");
    expect(upload.bytes).toBeGreaterThan(0);
    expect(upload.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("裸 base64 也接受", () => {
    const upload = validateAvatarData(PNG_1X1);
    expect(upload.mime).toBe("image/png");
  });

  it("非法 base64 / 非图片 / 过大 → INVALID_ASSET", () => {
    expect(() => validateAvatarData("not base64!!!")).toThrow(LifecycleError);
    const textBlob = Buffer.from("hello world").toString("base64");
    expect(() => validateAvatarData(textBlob)).toThrow(LifecycleError);
    // 构造超过上限的 PNG 前缀 blob。
    const big = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(AVATAR_MAX_BYTES)]);
    expect(() => validateAvatarData(big.toString("base64"))).toThrow(LifecycleError);
    expect(() => validateAvatarData("")).toThrow(LifecycleError);
  });
});
