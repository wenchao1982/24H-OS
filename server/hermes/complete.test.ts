import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { completePrompt, runOneshotViaCli } from "./complete";
import { makeFakeHermesCli, type FakeHermesCli } from "../testUtils/fakeHermesCli";

let fake: FakeHermesCli;
const savedFail = process.env.FAKE_HERMES_FAIL;

beforeEach(() => {
  fake = makeFakeHermesCli();
  delete process.env.FAKE_HERMES_FAIL;
});

afterEach(() => {
  if (savedFail === undefined) delete process.env.FAKE_HERMES_FAIL;
  else process.env.FAKE_HERMES_FAIL = savedFail;
  rmSync(fake.dir, { recursive: true, force: true });
});

describe("completePrompt —— 降级链", () => {
  it("gateway 成功 → via=gateway", async () => {
    const result = await completePrompt("hi", {
      resolveCliPath: async () => "/fake/hermes",
      gatewayComplete: async () => ({ text: "from-gateway" }),
    });
    expect(result.via).toBe("gateway");
    expect(result.text).toBe("from-gateway");
  });

  it("gateway 失败 → 走 oneshot（真实 spawn 假 CLI）", async () => {
    const result = await completePrompt("hello", {
      resolveCliPath: async () => fake.cliPath,
      gatewayComplete: async () => {
        throw new Error("no gateway");
      },
    });
    expect(result.via).toBe("oneshot");
    expect(result.text).toContain("hello");
    expect(fake.calls()).toContainEqual(["-z", "hello"]);
  });

  it("oneshot 透传 profile：-p <profile> -z <prompt>", async () => {
    const result = await completePrompt("任务", {
      profile: "writer",
      resolveCliPath: async () => fake.cliPath,
      gatewayComplete: async () => {
        throw new Error("no gateway");
      },
    });
    expect(result.via).toBe("oneshot");
    expect(fake.calls()[0]).toEqual(["-p", "writer", "-z", "任务"]);
  });

  it("oneshot 透传 model：-m <model> -z <prompt>（hermes -z 顶层 --model）", async () => {
    const result = await completePrompt("hi", {
      model: "anthropic/claude-x",
      resolveCliPath: async () => fake.cliPath,
      gatewayComplete: async () => {
        throw new Error("no gateway");
      },
    });
    expect(result.via).toBe("oneshot");
    expect(fake.calls()[0]).toEqual(["-m", "anthropic/claude-x", "-z", "hi"]);
  });

  it("oneshot 同时透传 profile + model", async () => {
    const result = await completePrompt("hi", {
      profile: "writer",
      model: "m1",
      resolveCliPath: async () => fake.cliPath,
      gatewayComplete: async () => {
        throw new Error("no gateway");
      },
    });
    expect(result.via).toBe("oneshot");
    expect(fake.calls()[0]).toEqual(["-p", "writer", "-m", "m1", "-z", "hi"]);
  });

  it("无 CLI → stub", async () => {
    const result = await completePrompt("nothing", {
      resolveCliPath: async () => null,
    });
    expect(result.via).toBe("stub");
    expect(result.stub).toBe(true);
    expect(result.text).toContain("[stub]");
    expect(result.text).toContain("nothing");
  });

  it("gateway + oneshot 都失败 → stub", async () => {
    process.env.FAKE_HERMES_FAIL = "1";
    const result = await completePrompt("boom", {
      resolveCliPath: async () => fake.cliPath,
      gatewayComplete: async () => {
        throw new Error("no gateway");
      },
    });
    expect(result.via).toBe("stub");
    expect(result.error).toContain("gateway");
    expect(result.error).toContain("oneshot");
  });
});

describe("runOneshotViaCli", () => {
  it("返回 stdout 文本", async () => {
    const text = await runOneshotViaCli(fake.cliPath, "你好");
    expect(text).toBe("ok -z 你好");
  });

  it("非 0 退出抛错", async () => {
    process.env.FAKE_HERMES_FAIL = "1";
    await expect(runOneshotViaCli(fake.cliPath, "x")).rejects.toBeInstanceOf(Error);
  });
});
