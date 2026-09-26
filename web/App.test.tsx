/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import {
  fetchAgentAvatar,
  fetchAgentConfig,
  fetchAgents,
  fetchMarket,
  fetchModelOptions,
  fetchSkillUis,
} from "./api";
import {
  makeAgent,
  makeAgentConfig,
  makeDeclarativeSkill,
  makeIframeSkill,
  makeStatus,
} from "./test-utils";

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return {
    ...actual,
    fetchAgents: vi.fn(),
    fetchMarket: vi.fn(),
    fetchSkillUis: vi.fn(),
    fetchModelOptions: vi.fn(),
    fetchAgentConfig: vi.fn(),
    fetchAgentAvatar: vi.fn(),
  };
});

const agentsMock = fetchAgents as unknown as Mock;
const marketMock = fetchMarket as unknown as Mock;
const skillUisMock = fetchSkillUis as unknown as Mock;
const modelOptionsMock = fetchModelOptions as unknown as Mock;
const agentConfigMock = fetchAgentConfig as unknown as Mock;
const agentAvatarMock = fetchAgentAvatar as unknown as Mock;

class NoopWebSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(_url: string) {}
  close(): void {}
}

const iframeSkill = makeIframeSkill({ id: "ppt", title: "PPT 生成器" });
const declarativeSkill = makeDeclarativeSkill(
  { skill: "outline", title: "大纲生成器" },
  { id: "outline" },
);
const disabledSkill = makeIframeSkill({
  id: "off",
  title: "已禁用技能",
  disabled: true,
});

beforeEach(() => {
  vi.stubGlobal("WebSocket", NoopWebSocket);
  agentsMock.mockResolvedValue({ agents: [makeAgent()], status: makeStatus() });
  modelOptionsMock.mockResolvedValue(["deepseek/deepseek-flash"]);
  agentConfigMock.mockResolvedValue(makeAgentConfig());
  agentAvatarMock.mockResolvedValue({ found: false, mime: null, size: null, data: null });
  skillUisMock.mockResolvedValue([iframeSkill, declarativeSkill, disabledSkill]);
  marketMock.mockResolvedValue({
    entries: [
      {
        id: "m1",
        name: "App One",
        description: "内置 App",
        source: "https://github.com/org/app.git",
        version: "1.0.0",
        tags: ["utility"],
      },
    ],
    message: "",
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("App · 布局与状态", () => {
  it("渲染状态条与三个 Tab 的计数", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Alpha" })).toBeInTheDocument();
    expect(screen.getByText(/Hermes 已连接/)).toBeInTheDocument();
    expect(screen.getByText("LIVE 数据")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Agents/ })).toHaveTextContent(/Agents\s*1/);
    expect(screen.getByRole("button", { name: /Skill/ })).toHaveTextContent(/Skill\s*3/);
    expect(screen.getByRole("button", { name: /Agent 市场/ })).toHaveTextContent(
      /Agent 市场\s*1/,
    );
  });

  it("mock 模式显示 MOCK 徽标", async () => {
    agentsMock.mockResolvedValue({
      agents: [makeAgent({ source: "mock" })],
      status: makeStatus({ mode: "mock", available: false }),
    });
    render(<App />);
    expect(await screen.findByText("MOCK 数据")).toBeInTheDocument();
  });

  it("后端不可用时展示连接错误", async () => {
    agentsMock.mockRejectedValue(new Error("ECONNREFUSED"));
    render(<App />);
    expect(await screen.findByText(/无法连接后端/)).toBeInTheDocument();
  });

  it("点击「＋ 安装 Agent」打开安装对话框", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("heading", { name: "Alpha" });
    await user.click(screen.getByRole("button", { name: /安装 Agent/ }));
    expect(await screen.findByRole("dialog", { name: "安装 Agent" })).toBeInTheDocument();
  });
});

describe("App · Skill Tab 与 uiHost 分流", () => {
  async function openSkillTab() {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("heading", { name: "Alpha" });
    await user.click(screen.getByRole("button", { name: /Skill/ }));
    return user;
  }

  it("列出自带 UI 的 skill，禁用的不提供打开入口", async () => {
    await openSkillTab();
    expect(screen.getByText("PPT 生成器")).toBeInTheDocument();
    expect(screen.getByText("大纲生成器")).toBeInTheDocument();
    expect(screen.getByText("已禁用技能")).toBeInTheDocument();
    expect(screen.getByText("已禁用")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "打开 Skill UI" })).toHaveLength(2);
  });

  it("iframe 形态 → 打开 SkillHost", async () => {
    const user = await openSkillTab();
    const li = screen.getByText("PPT 生成器").closest("li") as HTMLElement;
    await user.click(within(li).getByRole("button", { name: "打开 Skill UI" }));
    expect(await screen.findByTitle("skill-ui-ppt")).toBeInTheDocument();
  });

  it("declarative 形态 → 打开 DeclarativePanel", async () => {
    const user = await openSkillTab();
    const li = screen.getByText("大纲生成器").closest("li") as HTMLElement;
    await user.click(within(li).getByRole("button", { name: "打开 Skill UI" }));
    expect(await screen.findByText("声明式面板")).toBeInTheDocument();
  });

  it("Agent 市场 Tab 展示条目并可打开安装对话框（预填 source）", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("heading", { name: "Alpha" });
    await user.click(screen.getByRole("button", { name: /Agent 市场/ }));
    expect(screen.getByText("App One")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "安装" }));
    expect(await screen.findByRole("dialog", { name: "安装 Agent" })).toBeInTheDocument();
    expect(
      screen.getByDisplayValue("https://github.com/org/app.git"),
    ).toBeInTheDocument();
  });
});
