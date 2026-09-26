/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import DeclarativePanel from "./DeclarativePanel";
import { API_BASE } from "../api";
import {
  jsonResponse,
  makeAgent,
  makeDeclarativeSkill,
  makeStatus,
  sseFromEvents,
} from "../test-utils";
import type { SkillUiInfo } from "@shared/types";

let fetchMock: Mock;

function agentsResponse(): Response {
  return jsonResponse({ agents: [makeAgent({ model: "m1" })], status: makeStatus() });
}

function route(url: string): Response | undefined {
  if (url.endsWith("/api/agents")) return agentsResponse();
  if (url.endsWith("/api/hermes/chat/decide")) return jsonResponse({ ok: true });
  if (url.endsWith("/options.json")) {
    return jsonResponse([{ value: "t1", label: "模板一" }, "plain"]);
  }
  if (url.endsWith("/templates/index.json")) {
    return jsonResponse([{ id: "t1", name: "模板一", description: "模板描述" }]);
  }
  return undefined;
}

function stream(events: unknown[]): void {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/hermes/chat/stream")) return sseFromEvents(events);
    return route(url) ?? jsonResponse({});
  });
}

beforeEach(() => {
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    return route(url) ?? jsonResponse({});
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const skill: SkillUiInfo = makeDeclarativeSkill({
  skill: "outline",
  title: "大纲生成器",
  fields: [
    { key: "topic", label: "主题", type: "text", required: true, placeholder: "输入主题" },
    { key: "pages", label: "页数", type: "slider", min: 1, max: 20, default: 8 },
    { key: "style", label: "风格", type: "select", options: [{ value: "a", label: "风格A" }] },
    { key: "notes", label: "备注", type: "textarea", placeholder: "备注" },
    { key: "file", label: "附件", type: "file" },
  ],
  actions: [
    { id: "run", label: "生成", kind: "prompt", prompt: "主题：{{topic}}，页数：{{pages}}" },
  ],
});

function streamCall(): [string, RequestInit] | undefined {
  return fetchMock.mock.calls.find((call) =>
    String(call[0]).includes("/api/hermes/chat/stream"),
  ) as unknown as [string, RequestInit] | undefined;
}

describe("DeclarativePanel · 字段渲染与校验", () => {
  it("渲染 text / slider / select / textarea / file 各字段类型", () => {
    const { container } = render(<DeclarativePanel skill={skill} />);
    expect(screen.getByPlaceholderText("输入主题")).toBeInTheDocument();
    expect(screen.getByRole("slider")).toHaveValue("8");
    expect(screen.getByRole("combobox", { name: "风格" })).toHaveValue("");
    expect(screen.getByPlaceholderText("备注")).toBeInTheDocument();
    expect(container.querySelector('input[type="file"]')).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "生成" })).toBeInTheDocument();
  });

  it("未提供 panel 时渲染空态", () => {
    render(<DeclarativePanel skill={{ ...skill, panel: undefined }} />);
    expect(screen.getByText("该 skill 未提供 panel.yaml。")).toBeInTheDocument();
  });

  it("必填为空时阻止提交并给出字段名", async () => {
    const user = userEvent.setup();
    render(<DeclarativePanel skill={skill} />);
    await user.click(screen.getByRole("button", { name: "生成" }));
    expect(screen.getByText(/请填写必填字段：主题/)).toBeInTheDocument();
    expect(streamCall()).toBeUndefined();
  });
});

describe("DeclarativePanel · action 组装 prompt 与 SSE 流", () => {
  it("按 {{key}} 插值并 POST 到 chat/stream（关键字段 chatId/prompt）", async () => {
    const user = userEvent.setup();
    stream([{ type: "delta", text: "流式" }, { type: "done", status: "complete" }]);
    render(<DeclarativePanel skill={skill} />);
    await user.type(screen.getByPlaceholderText("输入主题"), "AI");
    await user.click(screen.getByRole("button", { name: "生成" }));
    await waitFor(() => expect(streamCall()).toBeDefined());
    const call = streamCall()!;
    expect(call[0]).toBe(`${API_BASE}/api/hermes/chat/stream`);
    const body = JSON.parse(String(call[1].body)) as Record<string, unknown>;
    expect(body.prompt).toBe("主题：AI，页数：8");
    expect(typeof body.chatId).toBe("string");
    expect(await screen.findByText("流式")).toBeInTheDocument();
    expect(screen.getByText(/完成（complete）/)).toBeInTheDocument();
  });

  it("delta 累积 + error 事件展示错误", async () => {
    const user = userEvent.setup();
    stream([
      { type: "delta", text: "A" },
      { type: "delta", text: "B" },
      { type: "error", message: "boom" },
    ]);
    render(<DeclarativePanel skill={skill} />);
    await user.type(screen.getByPlaceholderText("输入主题"), "x");
    await user.click(screen.getByRole("button", { name: "生成" }));
    expect(await screen.findByText("AB")).toBeInTheDocument();
    expect(screen.getByText(/✖ boom/)).toBeInTheDocument();
  });

  it("清空输出按钮移除流式文本", async () => {
    const user = userEvent.setup();
    stream([{ type: "delta", text: "待清空" }]);
    render(<DeclarativePanel skill={skill} />);
    await user.type(screen.getByPlaceholderText("输入主题"), "x");
    await user.click(screen.getByRole("button", { name: "生成" }));
    await screen.findByText("待清空");
    await user.click(screen.getByRole("button", { name: "清空输出" }));
    expect(screen.queryByText("待清空")).not.toBeInTheDocument();
  });
});

describe("DeclarativePanel · 审批 / 澄清决策", () => {
  it("approval 事件渲染决策卡片，选择 once → POST chat/decide", async () => {
    const user = userEvent.setup();
    stream([{ type: "approval", chatId: "c1", description: "执行 rm -rf build" }]);
    render(<DeclarativePanel skill={skill} />);
    await user.type(screen.getByPlaceholderText("输入主题"), "x");
    await user.click(screen.getByRole("button", { name: "生成" }));
    expect((await screen.findAllByText(/审批：执行 rm -rf build/)).length).toBeGreaterThan(0);
    for (const choice of ["once", "session", "always", "deny"]) {
      expect(screen.getByRole("button", { name: choice })).toBeInTheDocument();
    }
    await user.click(screen.getByRole("button", { name: "once" }));
    await waitFor(() => {
      const decide = fetchMock.mock.calls.find((call) =>
        String(call[0]).includes("/api/hermes/chat/decide"),
      );
      expect(decide).toBeDefined();
      expect(JSON.parse(String((decide![1] as RequestInit).body))).toEqual({
        chatId: "c1",
        type: "approval",
        choice: "once",
      });
    });
  });

  it("clarify 事件支持输入答案并发送", async () => {
    const user = userEvent.setup();
    stream([{ type: "clarify", chatId: "c2", question: "选哪个？" }]);
    render(<DeclarativePanel skill={skill} />);
    await user.type(screen.getByPlaceholderText("输入主题"), "x");
    await user.click(screen.getByRole("button", { name: "生成" }));
    expect((await screen.findAllByText(/选哪个？/)).length).toBeGreaterThan(0);
    await user.type(screen.getByPlaceholderText("输入答案（留空 = 跳过）"), "选 A");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => {
      const decide = fetchMock.mock.calls.find((call) =>
        String(call[0]).includes("/api/hermes/chat/decide"),
      );
      expect(JSON.parse(String((decide![1] as RequestInit).body))).toEqual({
        chatId: "c2",
        type: "clarify",
        answer: "选 A",
      });
    });
  });

  it("decision.fallback 兜底事件清除挂起卡片", async () => {
    const user = userEvent.setup();
    stream([
      { type: "approval", chatId: "c1", description: "危险操作" },
      {
        type: "session",
        chatId: "c1",
        event: "decision.fallback",
        payload: { type: "approval", reason: "timeout" },
      },
    ]);
    render(<DeclarativePanel skill={skill} />);
    await user.type(screen.getByPlaceholderText("输入主题"), "x");
    await user.click(screen.getByRole("button", { name: "生成" }));
    expect(await screen.findByText(/安全默认兜底/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "once" })).not.toBeInTheDocument();
  });
});

describe("DeclarativePanel · 动态 options_from 与模板", () => {
  it("拉取 options_from JSON 渲染选项，模板点击回填 select", async () => {
    const user = userEvent.setup();
    const dynamicSkill = makeDeclarativeSkill({
      skill: "outline",
      fields: [
        { key: "template", label: "模板", type: "select", options_from: "options.json" },
      ],
      templates: { index: "templates/index.json" },
      actions: [],
    });
    render(<DeclarativePanel skill={dynamicSkill} />);
    expect(await screen.findByRole("option", { name: "模板一" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "plain" })).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: /模板一/ }));
    expect(screen.getByRole("combobox", { name: "模板" })).toHaveValue("t1");
  });
});
