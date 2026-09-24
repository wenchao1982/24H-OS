import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  extractDescription,
  extractMcpServers,
  extractModel,
  parseAgentDir,
  parseConfigObject,
} from "./profiles";

/** 在临时目录里写入若干文件，返回目录路径。 */
function makeProfileDir(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "24os-profile-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), content, "utf8");
  }
  return dir;
}

const tempDirs: string[] = [];

function makeTrackedProfileDir(files: Record<string, string>): string {
  const dir = makeProfileDir(files);
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("parseAgentDir / config.yaml 解析", () => {
  it("解析嵌套 model.default、顶层 mcp_servers，忽略无关的 default，并容忍 tab 缩进", () => {
    const yaml = [
      "model:",
      "\tprovider: deepseek",
      "\tdefault: tab-model",
      "providers:",
      "\tother:",
      "\t\tdefault: not-a-model",
      "display:",
      "\tdefault: nope",
      "mcp_servers:",
      "\tserver-a:",
      "\t\tcommand: node",
      "\t\targs:",
      "\t\t\t- a.js",
      "\t\tenabled: true",
      '\t"quoted-server":',
      "\t\tcommand: npx",
      "misc:",
      "\tdefault: still-not-a-model",
    ].join("\n");

    const dir = makeTrackedProfileDir({ "config.yaml": yaml });
    const agent = parseAgentDir("tabbed", dir);

    // 模型只认 model.default，不能被顶层任意 default 误匹配。
    expect(agent.model).toBe("tab-model");
    expect(agent.model).not.toContain("not-a-model");
    expect(agent.model).not.toBe("nope");

    // MCP 只认顶层 mcp_servers 的键（含带引号的 key）。
    expect(agent.mcpServers.map((server) => server.id)).toEqual([
      "server-a",
      "quoted-server",
    ]);

    const serverA = agent.mcpServers.find((server) => server.id === "server-a");
    expect(serverA?.command).toBe("node");
    expect(serverA?.args).toEqual(["a.js"]);
    expect(serverA?.enabled).toBe(true);
  });

  it("model 为字符串、mcp_servers 为空对象、4 空格缩进均可解析", () => {
    const yaml = [
      'model: "string-model"',
      "mcp_servers: {}",
      "display:",
      "    show_cost: true",
    ].join("\n");

    const dir = makeTrackedProfileDir({ "config.yaml": yaml });
    const agent = parseAgentDir("stringy", dir);

    expect(agent.model).toBe("string-model");
    expect(agent.mcpServers).toEqual([]);
  });

  it("config.yaml 损坏时回退为 unknown，不抛异常", () => {
    const dir = makeTrackedProfileDir({ "config.yaml": "model: [unclosed" });
    const agent = parseAgentDir("broken", dir);
    expect(agent.model).toBe("unknown");
  });
});

describe("extractModel / extractMcpServers", () => {
  it("支持字符串 model", () => {
    expect(extractModel({ model: "m1" })).toBe("m1");
  });

  it("支持嵌套 model.default", () => {
    expect(extractModel({ model: { default: "m2", provider: "p" } })).toBe("m2");
  });

  it("顶层无关 default 不影响模型提取", () => {
    expect(extractModel({ display: { default: "nope" } })).toBeNull();
  });

  it("mcp_servers 为 {} 时返回空数组", () => {
    expect(extractMcpServers({ mcp_servers: {} })).toEqual([]);
  });

  it("容忍 tab 缩进的 YAML", () => {
    const config = parseConfigObject("model:\n\tdefault: t\n");
    expect(extractModel(config)).toBe("t");
  });
});

describe("extractDescription", () => {
  it("跳过标题，取第一个非空正文段落", () => {
    const md = [
      "# Hermes Agent",
      "",
      "## 概述",
      "",
      "这是第一段正文，",
      "换行后继续。",
      "",
      "第二段不应被取到。",
    ].join("\n");

    expect(extractDescription(md)).toBe("这是第一段正文， 换行后继续。");
  });

  it("只有标题时返回空字符串", () => {
    expect(extractDescription("# 标题\n## 子标题")).toBe("");
  });

  it("跳过标题后允许紧跟正文（无空行分隔）", () => {
    expect(extractDescription("# 标题\n真正的描述")).toBe("真正的描述");
  });
});
