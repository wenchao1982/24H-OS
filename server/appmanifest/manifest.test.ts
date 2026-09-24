import { describe, expect, it } from "vitest";
import {
  findBuiltinAppManifest,
  listBuiltinAppManifests,
  parseAppManifest,
  tryParseAppManifest,
  validateAppManifest,
} from "./manifest";
import { APP_MANIFEST_PROTOCOL } from "@shared/types";
import { LifecycleError } from "../hermes/errors";

/**
 * AppManifest 解析 / 校验（M6）。
 * 合法通过；非法 → INVALID_MANIFEST。
 */

const VALID_YAML = `
protocol: 24os-appmanifest/1
id: ppt-maker
name: PPT 制作
version: 1.0.0
description: 选模板生成 PPT
source:
  type: builtin
  path: examples/skills/ppt
profile:
  template: default
  model:
    default: kimi-k2.5
  mcp:
    - name: filesystem
      config: { command: npx, args: ["-y", "@modelcontextprotocol/server-filesystem"] }
  env:
    MY_API_KEY: ""
  skills:
    - ppt
ui:
  skillId: ppt
  host: iframe
hooks:
  oninstall: [ui.open]
  onupdate: []
  ondelete: []
plugins:
  - name: ops-push
    kind: http
    endpoint: ""
    envKey: REPORT_WEBHOOK
sign:
  sha256: ""
`;

function expectInvalid(fn: () => unknown): LifecycleError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(LifecycleError);
    expect((error as LifecycleError).code).toBe("INVALID_MANIFEST");
    return error as LifecycleError;
  }
  throw new Error("expected INVALID_MANIFEST");
}

describe("validateAppManifest / parseAppManifest", () => {
  it("合法 manifest 通过", () => {
    const m = parseAppManifest(VALID_YAML);
    expect(m.protocol).toBe(APP_MANIFEST_PROTOCOL);
    expect(m.id).toBe("ppt-maker");
    expect(m.version).toBe("1.0.0");
    expect(m.source.type).toBe("builtin");
    expect(m.ui?.host).toBe("iframe");
    expect(m.hooks?.oninstall).toEqual(["ui.open"]);
    expect(m.plugins?.[0]?.kind).toBe("http");
    expect(m.profile?.skills).toEqual(["ppt"]);
  });

  it("id 正则非法 → INVALID_MANIFEST", () => {
    expectInvalid(() =>
      parseAppManifest(VALID_YAML.replace("id: ppt-maker", "id: Bad_Id!!")),
    );
  });

  it("version 非法 → INVALID_MANIFEST", () => {
    expectInvalid(() =>
      parseAppManifest(VALID_YAML.replace("version: 1.0.0", "version: 1.0")),
    );
  });

  it("unknown hook → INVALID_MANIFEST", () => {
    expectInvalid(() =>
      parseAppManifest(
        VALID_YAML.replace("oninstall: [ui.open]", "oninstall: [nope.hook]"),
      ),
    );
  });

  it("bad ui.host → INVALID_MANIFEST", () => {
    expectInvalid(() =>
      parseAppManifest(VALID_YAML.replace("host: iframe", "host: webview")),
    );
  });

  it("protocol 不匹配 → INVALID_MANIFEST", () => {
    expectInvalid(() =>
      parseAppManifest(
        VALID_YAML.replace("protocol: 24os-appmanifest/1", "protocol: other/9"),
      ),
    );
  });

  it("非法 YAML → INVALID_MANIFEST", () => {
    expectInvalid(() => parseAppManifest("protocol: [unclosed"));
  });

  it("source.type 非法 → INVALID_MANIFEST", () => {
    expectInvalid(() =>
      validateAppManifest({
        protocol: APP_MANIFEST_PROTOCOL,
        id: "ok",
        name: "n",
        version: "1.0.0",
        source: { type: "ftp", path: "x" },
      }),
    );
  });

  it("source.type=path 缺 path → INVALID_MANIFEST", () => {
    expectInvalid(() =>
      validateAppManifest({
        protocol: APP_MANIFEST_PROTOCOL,
        id: "ok",
        name: "n",
        version: "1.0.0",
        source: { type: "path" },
      }),
    );
  });

  it("非法 env 键名 → INVALID_MANIFEST", () => {
    expectInvalid(() =>
      validateAppManifest({
        protocol: APP_MANIFEST_PROTOCOL,
        id: "ok",
        name: "n",
        version: "1.0.0",
        source: { type: "path", path: "/tmp" },
        profile: { env: { lowercase_key: "v" } },
      }),
    );
  });

  it("tryParseAppManifest 非法返回 null", () => {
    expect(tryParseAppManifest("not: valid: yaml: [")).toBeNull();
  });
});

describe("builtin catalog (market/apps)", () => {
  it("内置至少 ppt-maker 与 outline-declarative", () => {
    const apps = listBuiltinAppManifests();
    const ids = apps.map((app) => app.id);
    expect(ids).toContain("ppt-maker");
    expect(ids).toContain("outline-declarative");
  });

  it("findBuiltinAppManifest 按 id 查找", () => {
    const ppt = findBuiltinAppManifest("ppt-maker");
    expect(ppt?.ui?.host).toBe("iframe");
    const outline = findBuiltinAppManifest("outline-declarative");
    expect(outline?.ui?.host).toBe("declarative");
    expect(findBuiltinAppManifest("missing")).toBeNull();
  });
});
