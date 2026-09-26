/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AgentDetail from "./AgentDetail";
import {
  ApiRequestError,
  backupAgent,
  deleteAgent,
  fetchAgentAvatar,
  fetchAgentConfig,
  updateAgent,
  uploadAgentAvatar,
} from "../api";
import { makeAgent, makeAgentConfig, makeLifecycleResult, makeStatus } from "../test-utils";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    updateAgent: vi.fn(),
    backupAgent: vi.fn(),
    deleteAgent: vi.fn(),
    fetchAgentConfig: vi.fn(),
    fetchAgentAvatar: vi.fn(),
    uploadAgentAvatar: vi.fn(),
  };
});

const updateMock = updateAgent as unknown as Mock;
const backupMock = backupAgent as unknown as Mock;
const deleteMock = deleteAgent as unknown as Mock;
const configMock = fetchAgentConfig as unknown as Mock;
const avatarMock = fetchAgentAvatar as unknown as Mock;
const uploadAvatarMock = uploadAgentAvatar as unknown as Mock;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  updateMock.mockResolvedValue(makeLifecycleResult({ action: "update" }));
  backupMock.mockResolvedValue(makeLifecycleResult({ action: "backup" }));
  deleteMock.mockResolvedValue(makeLifecycleResult({ action: "delete" }));
  configMock.mockResolvedValue(makeAgentConfig());
  avatarMock.mockResolvedValue({ found: false, mime: null, size: null, data: null });
});

const agent = makeAgent({
  skills: [
    { id: "ppt", name: "PPT", hasUi: true, uiId: "ppt", enabled: true },
    { id: "outline", name: "大纲", hasUi: true, uiId: "outline", enabled: false },
    { id: "plain", name: "无 UI" },
  ],
  mcpServers: [{ id: "files", name: "files", command: "npx", args: ["-y", "server"] }],
});

describe("AgentDetail · 只读展示", () => {
  it("渲染描述 / 模型 / skills / MCP servers", async () => {
    render(<AgentDetail agent={agent} status={makeStatus()} />);
    expect(screen.getByRole("heading", { name: "Alpha" })).toBeInTheDocument();
    expect(screen.getByText("示例 agent")).toBeInTheDocument();
    expect(screen.getByText("deepseek/deepseek-flash")).toBeInTheDocument();
    expect(screen.getByText("PPT")).toBeInTheDocument();
    expect(screen.getByText("npx -y server")).toBeInTheDocument();
    // 等内嵌配置编辑器异步加载结束，避免 act 警告。
    expect(await screen.findByDisplayValue("deepseek/deepseek-flash")).toBeInTheDocument();
  });

  it("被禁用的 skill 不渲染打开入口；可用 UI 按钮回调 uiId", async () => {
    const user = userEvent.setup();
    const onOpenSkillUi = vi.fn();
    render(
      <AgentDetail agent={agent} status={makeStatus()} onOpenSkillUi={onOpenSkillUi} />,
    );
    const buttons = screen.getAllByRole("button", { name: "打开 Skill UI" });
    expect(buttons).toHaveLength(1);
    await user.click(buttons[0]);
    expect(onOpenSkillUi).toHaveBeenCalledWith("ppt");
    expect(screen.getByText("已禁用")).toBeInTheDocument();
  });
});

describe("AgentDetail · 头像（M9）", () => {
  it("找到头像 → 渲染 <img>；未设置 → 首字母回退", async () => {
    avatarMock.mockResolvedValueOnce({
      found: true,
      mime: "image/png",
      size: 68,
      data: "data:image/png;base64,AAAA",
    });
    render(<AgentDetail agent={agent} status={makeStatus()} />);
    const img = await screen.findByAltText("Alpha 头像");
    expect(img).toHaveAttribute("src", "data:image/png;base64,AAAA");
  });

  it("未设置头像 → 首字母回退", async () => {
    render(<AgentDetail agent={agent} status={makeStatus()} />);
    expect(await screen.findByTestId("agent-avatar")).toHaveTextContent("A");
  });

  it("上传头像 → 调用 uploadAgentAvatar", async () => {
    const user = userEvent.setup();
    uploadAvatarMock.mockResolvedValue({ ok: true, size: 68, message: "头像已更新" });
    const { container } = render(<AgentDetail agent={agent} status={makeStatus()} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["pngbytes"], "a.png", { type: "image/png" });
    await user.upload(input, file);
    await waitFor(() => expect(uploadAvatarMock).toHaveBeenCalled());
    expect(uploadAvatarMock.mock.calls[0][0]).toBe("alpha");
  });
});

describe("AgentDetail · 生命周期两段式", () => {
  it("更新：先 dryRun 预览，确认后带 confirm:true 执行并刷新", async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn();
    render(<AgentDetail agent={agent} status={makeStatus()} onRefresh={onRefresh} />);
    await user.click(screen.getByRole("button", { name: "更新" }));
    await waitFor(() => expect(updateMock).toHaveBeenCalledWith("alpha", { dryRun: true }));
    expect(await screen.findByRole("dialog", { name: "确认更新 Agent" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "确认执行" }));
    await waitFor(() => expect(updateMock).toHaveBeenLastCalledWith("alpha", { confirm: true }));
    expect(onRefresh).toHaveBeenCalled();
  });

  it("卸载：弹窗展示风险文案，确认后调用 deleteAgent(confirm+backup)", async () => {
    const user = userEvent.setup();
    render(<AgentDetail agent={agent} status={makeStatus()} />);
    await user.click(screen.getByRole("button", { name: "卸载" }));
    expect(await screen.findByText(/删除不可撤销/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "确认卸载" }));
    await waitFor(() =>
      expect(deleteMock).toHaveBeenCalledWith("alpha", { confirm: true, backup: true }),
    );
  });

  it("CLI 不可用：生命周期按钮禁用并提示", () => {
    render(<AgentDetail agent={agent} status={makeStatus({ cliPath: null })} />);
    expect(screen.getByText(/未检测到 hermes CLI/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "更新" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "卸载" })).toBeDisabled();
  });

  it("生命周期失败时展示错误码", async () => {
    const user = userEvent.setup();
    updateMock.mockRejectedValueOnce(
      new ApiRequestError(400, "INVALID_NAME", "名字非法"),
    );
    render(<AgentDetail agent={agent} status={makeStatus()} />);
    await user.click(screen.getByRole("button", { name: "更新" }));
    expect(await screen.findByText("[INVALID_NAME] 名字非法")).toBeInTheDocument();
  });
});
