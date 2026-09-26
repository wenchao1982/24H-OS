/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SkillHost from "./SkillHost";
import { API_BASE } from "../api";
import {
  jsonResponse,
  makeAgent,
  makeIframeSkill,
  makeStatus,
  sseFromEvents,
} from "../test-utils";

let fetchMock: Mock;

function baseRoute(url: string): Response | undefined {
  if (url.endsWith("/api/agents")) {
    return jsonResponse({ agents: [makeAgent({ model: "m1" })], status: makeStatus() });
  }
  return undefined;
}

beforeEach(() => {
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    return baseRoute(url) ?? jsonResponse({});
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function getFrame(): HTMLIFrameElement {
  return screen.getByTitle(/^skill-ui-/) as HTMLIFrameElement;
}

async function sendFromFrame(win: Window, data: unknown): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new MessageEvent("message", { data, source: win }));
  });
}

function posted(
  spy: { mock: { calls: unknown[][] } },
  predicate: (msg: Record<string, unknown>) => boolean,
): Record<string, unknown>[] {
  return spy.mock.calls
    .map((call) => call[0] as Record<string, unknown>)
    .filter((msg) => msg && typeof msg === "object" && predicate(msg));
}

const skill = makeIframeSkill();

describe("SkillHost · iframe 挂载与握手", () => {
  it("iframe 指向 skill-ui 入口，onLoad 发送 host.init 握手", async () => {
    render(<SkillHost skill={skill} />);
    const frame = getFrame();
    expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    expect(frame.getAttribute("src")).toBe(`${API_BASE}/skill-ui/ppt/index.html`);
    const spy = vi.spyOn(frame.contentWindow!, "postMessage");
    fireEvent.load(frame);
    const inits = posted(spy, (m) => m.type === "host.init");
    expect(inits).toHaveLength(1);
    expect(inits[0]).toMatchObject({
      __24os: true,
      type: "host.init",
      payload: {
        protocol: "24os-skill-ui/1",
        capabilities: ["readFile", "writeFile", "chatStream"],
        permissions: ["workspace:read"],
      },
    });
  });

  it("收到 ui.ready 后重发握手", async () => {
    render(<SkillHost skill={skill} />);
    const win = getFrame().contentWindow!;
    const spy = vi.spyOn(win, "postMessage");
    await sendFromFrame(win, { __24os: true, type: "ui.ready" });
    expect(posted(spy, (m) => m.type === "host.init")).toHaveLength(1);
    expect(screen.getByText("UI 就绪")).toBeInTheDocument();
  });

  it("忽略非本 iframe 来源 / 非 24os 消息", async () => {
    render(<SkillHost skill={skill} />);
    const win = getFrame().contentWindow!;
    const spy = vi.spyOn(win, "postMessage");
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", { data: { __24os: true, type: "ui.ready" }, source: window }),
      );
    });
    expect(posted(spy, (m) => m.type === "host.init")).toHaveLength(0);
  });
});

describe("SkillHost · RPC broker", () => {
  it("已声明能力 → POST /api/skill-host/invoke 并按 id 回传结果", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/skill-host/invoke")) {
        return jsonResponse({ ok: true, result: { path: "a.txt", content: "hi" } });
      }
      return baseRoute(url) ?? jsonResponse({});
    });
    render(<SkillHost skill={skill} />);
    const win = getFrame().contentWindow!;
    const spy = vi.spyOn(win, "postMessage");
    await sendFromFrame(win, {
      __24os: true,
      id: "r1",
      method: "readFile",
      params: { path: "a.txt" },
    });
    await waitFor(() => {
      const invoke = fetchMock.mock.calls.find((c) =>
        String(c[0]).endsWith("/api/skill-host/invoke"),
      );
      expect(invoke).toBeDefined();
      expect(JSON.parse(String((invoke![1] as RequestInit).body))).toEqual({
        skillId: "ppt",
        method: "readFile",
        params: { path: "a.txt" },
      });
    });
    await waitFor(() => {
      const responses = posted(spy, (m) => m.id === "r1");
      expect(responses).toHaveLength(1);
      expect(responses[0]).toMatchObject({
        __24os: true,
        id: "r1",
        ok: true,
        result: { path: "a.txt", content: "hi" },
      });
    });
  });

  it("未声明能力 → 拒绝且不调用 broker", async () => {
    render(<SkillHost skill={skill} />);
    const win = getFrame().contentWindow!;
    const spy = vi.spyOn(win, "postMessage");
    await sendFromFrame(win, { __24os: true, id: "r2", method: "callModel", params: {} });
    await waitFor(() => {
      const responses = posted(spy, (m) => m.id === "r2");
      expect(responses[0]).toMatchObject({
        ok: false,
        error: { code: "FORBIDDEN" },
      });
    });
    expect(
      fetchMock.mock.calls.some((c) => String(c[0]).endsWith("/api/skill-host/invoke")),
    ).toBe(false);
  });

  it("敏感能力 writeFile 首次使用显示权限提示", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/skill-host/invoke")) return jsonResponse({ ok: true, result: {} });
      return baseRoute(url) ?? jsonResponse({});
    });
    render(<SkillHost skill={skill} />);
    const win = getFrame().contentWindow!;
    vi.spyOn(win, "postMessage");
    await sendFromFrame(win, {
      __24os: true,
      id: "r3",
      method: "writeFile",
      params: { path: "out.txt", content: "x" },
    });
    expect(await screen.findByText(/使用了敏感能力/)).toBeInTheDocument();
  });

  it("SKILL_DISABLED：broker 拒绝时回传错误码并记入日志", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/skill-host/invoke")) {
        return jsonResponse(
          { ok: false, error: { code: "SKILL_DISABLED", message: "skill 已被禁用" } },
          403,
        );
      }
      return baseRoute(url) ?? jsonResponse({});
    });
    render(<SkillHost skill={skill} />);
    const win = getFrame().contentWindow!;
    const spy = vi.spyOn(win, "postMessage");
    await sendFromFrame(win, { __24os: true, id: "r4", method: "readFile", params: {} });
    expect(await screen.findByText(/skill 已被禁用/)).toBeInTheDocument();
    await waitFor(() => {
      expect(posted(spy, (m) => m.id === "r4")[0]).toMatchObject({
        ok: false,
        error: { code: "SKILL_DISABLED" },
      });
    });
  });
});

describe("SkillHost · chatStream", () => {
  it("转发 SSE 事件并回汇总响应", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/hermes/chat/stream")) {
        return sseFromEvents([
          { type: "delta", text: "你" },
          { type: "done", status: "complete" },
        ]);
      }
      return baseRoute(url) ?? jsonResponse({});
    });
    render(<SkillHost skill={skill} />);
    const win = getFrame().contentWindow!;
    const spy = vi.spyOn(win, "postMessage");
    await sendFromFrame(win, {
      __24os: true,
      id: "s1",
      method: "chatStream",
      params: { prompt: "hello" },
    });
    await waitFor(() => {
      expect(posted(spy, (m) => m.type === "event" && m.event === "chat.delta")).toHaveLength(1);
    });
    expect(posted(spy, (m) => m.event === "chat.done")).toHaveLength(1);
    await waitFor(() => {
      expect(posted(spy, (m) => m.id === "s1")[0]).toMatchObject({
        ok: true,
        result: { status: "done" },
      });
    });
    const streamCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).endsWith("/api/hermes/chat/stream"),
    );
    const body = JSON.parse(String((streamCall![1] as RequestInit).body)) as Record<string, unknown>;
    expect(body.prompt).toBe("hello");
    expect(typeof body.chatId).toBe("string");
  });

  it("空 prompt 直接拒绝且不发请求", async () => {
    render(<SkillHost skill={skill} />);
    const win = getFrame().contentWindow!;
    const spy = vi.spyOn(win, "postMessage");
    await sendFromFrame(win, {
      __24os: true,
      id: "s2",
      method: "chatStream",
      params: { prompt: "   " },
    });
    await waitFor(() => {
      expect(posted(spy, (m) => m.id === "s2")[0]).toMatchObject({
        ok: false,
        error: { code: "INVALID_VALUE" },
      });
    });
    expect(
      fetchMock.mock.calls.some((c) => String(c[0]).endsWith("/api/hermes/chat/stream")),
    ).toBe(false);
  });

  it("审批事件渲染宿主卡片，选择 session → POST decide", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/hermes/chat/stream")) {
        return sseFromEvents([
          { type: "approval", chatId: "c7", description: "删除文件" },
        ]);
      }
      return baseRoute(url) ?? jsonResponse({});
    });
    const user = userEvent.setup();
    render(<SkillHost skill={skill} />);
    const win = getFrame().contentWindow!;
    vi.spyOn(win, "postMessage");
    await sendFromFrame(win, {
      __24os: true,
      id: "s3",
      method: "chatStream",
      params: { prompt: "go" },
    });
    expect((await screen.findAllByText(/删除文件/)).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "session" }));
    await waitFor(() => {
      const decide = fetchMock.mock.calls.find((c) =>
        String(c[0]).endsWith("/api/hermes/chat/decide"),
      );
      expect(JSON.parse(String((decide![1] as RequestInit).body))).toEqual({
        chatId: "c7",
        type: "approval",
        choice: "session",
      });
    });
  });

  it("昂贵模型确认弹窗：取消 → MODEL_CONFIRM_CANCELLED", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/hermes/chat/stream")) {
        return sseFromEvents([
          {
            type: "session",
            event: "model.confirm_required",
            payload: { confirmMessage: "该模型很贵" },
          },
        ]);
      }
      return baseRoute(url) ?? jsonResponse({});
    });
    const user = userEvent.setup();
    render(<SkillHost skill={skill} />);
    const win = getFrame().contentWindow!;
    const spy = vi.spyOn(win, "postMessage");
    await sendFromFrame(win, {
      __24os: true,
      id: "s4",
      method: "chatStream",
      params: { prompt: "go" },
    });
    expect(await screen.findByRole("dialog", { name: "昂贵模型确认" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => {
      expect(posted(spy, (m) => m.id === "s4")[0]).toMatchObject({
        ok: false,
        error: { code: "MODEL_CONFIRM_CANCELLED" },
      });
    });
  });

  it("昂贵模型确认弹窗：确认 → 带 force:true 重试", async () => {
    let streamCount = 0;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/hermes/chat/stream")) {
        streamCount += 1;
        if (streamCount === 1) {
          return sseFromEvents([
            { type: "session", event: "model.confirm_required", payload: { confirmMessage: "贵" } },
          ]);
        }
        return sseFromEvents([{ type: "done", status: "complete" }]);
      }
      return baseRoute(url) ?? jsonResponse({});
    });
    const user = userEvent.setup();
    render(<SkillHost skill={skill} />);
    const win = getFrame().contentWindow!;
    const spy = vi.spyOn(win, "postMessage");
    await sendFromFrame(win, {
      __24os: true,
      id: "s5",
      method: "chatStream",
      params: { prompt: "go" },
    });
    await screen.findByRole("dialog", { name: "昂贵模型确认" });
    await user.click(screen.getByRole("button", { name: "确认切换" }));
    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter((c) =>
        String(c[0]).endsWith("/api/hermes/chat/stream"),
      );
      expect(calls).toHaveLength(2);
      expect(JSON.parse(String((calls[1][1] as RequestInit).body))).toMatchObject({
        prompt: "go",
        force: true,
      });
    });
    await waitFor(() => {
      expect(posted(spy, (m) => m.id === "s5")[0]).toMatchObject({
        ok: true,
      });
    });
  });
});

describe("SkillHost · 调试面板与关闭", () => {
  it("清空 / 重新加载重置日志，并触发 onClose", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<SkillHost skill={skill} onClose={onClose} />);
    const frame = getFrame();
    fireEvent.load(frame);
    expect(await screen.findByText(/握手 nonce=/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "清空" }));
    expect(screen.getByText("暂无 RPC。等待 UI 握手…")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "关闭" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
