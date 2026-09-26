/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AgentConfigEditor from "./AgentConfigEditor";
import {
  addMcpServer,
  fetchAgentConfig,
  removeEnvVar,
  removeMcpServer,
  setEnvVar,
  updateAgentConfig,
  updateMcpServer,
} from "../api";
import { makeAgent, makeAgentConfig } from "../test-utils";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    fetchAgentConfig: vi.fn(),
    updateAgentConfig: vi.fn(),
    addMcpServer: vi.fn(),
    updateMcpServer: vi.fn(),
    removeMcpServer: vi.fn(),
    setEnvVar: vi.fn(),
    removeEnvVar: vi.fn(),
  };
});

const fetchConfigMock = fetchAgentConfig as unknown as Mock;
const updateConfigMock = updateAgentConfig as unknown as Mock;
const addMcpMock = addMcpServer as unknown as Mock;
const updateMcpMock = updateMcpServer as unknown as Mock;
const removeMcpMock = removeMcpServer as unknown as Mock;
const setEnvMock = setEnvVar as unknown as Mock;
const removeEnvMock = removeEnvVar as unknown as Mock;

const okResult = { ok: true, action: "update-config", via: "file", files: [], backups: [], message: "已写入" };

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  fetchConfigMock.mockResolvedValue(makeAgentConfig());
  updateConfigMock.mockResolvedValue({ ...okResult, action: "update-config" });
  addMcpMock.mockResolvedValue(okResult);
  updateMcpMock.mockResolvedValue(okResult);
  removeMcpMock.mockResolvedValue(okResult);
  setEnvMock.mockResolvedValue(okResult);
  removeEnvMock.mockResolvedValue(okResult);
});

const mcpConfig = makeAgentConfig({
  mcpServers: [
    { id: "files", name: "files", command: "npx", args: ["-y", "server"], transport: "stdio" },
  ],
});

describe("AgentConfigEditor · 加载与展示", () => {
  it("加载后回填模型 / 描述 / 标签，并列出 MCP", async () => {
    fetchConfigMock.mockResolvedValue(mcpConfig);
    render(<AgentConfigEditor agent={makeAgent()} />);
    expect(await screen.findByDisplayValue("deepseek/deepseek-flash")).toBeInTheDocument();
    expect(screen.getByDisplayValue("示例 agent")).toBeInTheDocument();
    expect(screen.getByDisplayValue("review, ci")).toBeInTheDocument();
    expect(screen.getByText("npx -y server")).toBeInTheDocument();
  });

  it("env 只展示键名与掩码，不出现明文", async () => {
    fetchConfigMock.mockResolvedValue(makeAgentConfig({ envKeys: ["API_KEY"] }));
    render(<AgentConfigEditor agent={makeAgent()} />);
    expect(await screen.findByText("API_KEY")).toBeInTheDocument();
    expect(screen.getByText("••••••")).toBeInTheDocument();
  });

  it("加载失败展示错误码", async () => {
    const { ApiRequestError } = await import("../api");
    fetchConfigMock.mockRejectedValueOnce(new ApiRequestError(404, "AGENT_NOT_FOUND", "不存在"));
    render(<AgentConfigEditor agent={makeAgent()} />);
    expect(await screen.findByText("[AGENT_NOT_FOUND] 不存在")).toBeInTheDocument();
  });
});

describe("AgentConfigEditor · 保存配置（confirm 门禁）", () => {
  it("保存弹窗展示摘要，确认后带 confirm:true 提交并提示成功", async () => {
    const user = userEvent.setup();
    render(<AgentConfigEditor agent={makeAgent()} />);
    await screen.findByDisplayValue("示例 agent");
    const tagsInput = screen.getByDisplayValue("review, ci");
    await user.clear(tagsInput);
    await user.type(tagsInput, "alpha, beta");
    await user.click(screen.getByRole("button", { name: "保存配置" }));
    expect(await screen.findByRole("dialog", { name: "确认保存配置" })).toBeInTheDocument();
    expect(screen.getByText(/alpha, beta/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "确认写入" }));
    await waitFor(() =>
      expect(updateConfigMock).toHaveBeenCalledWith("alpha", {
        model: "deepseek/deepseek-flash",
        description: "示例 agent",
        tags: ["alpha", "beta"],
        confirm: true,
      }),
    );
    expect(await screen.findByText(/已写入/)).toBeInTheDocument();
  });

  it("人设（SOUL）：填写后随保存提交 soul 字段", async () => {
    const user = userEvent.setup();
    render(<AgentConfigEditor agent={makeAgent()} />);
    await screen.findByDisplayValue("示例 agent");
    await user.type(
      screen.getByPlaceholderText(/persona 正文/),
      "You are careful.",
    );
    await user.click(screen.getByRole("button", { name: "保存配置" }));
    await screen.findByRole("dialog", { name: "确认保存配置" });
    await user.click(screen.getByRole("button", { name: "确认写入" }));
    await waitFor(() =>
      expect(updateConfigMock).toHaveBeenCalledWith(
        "alpha",
        expect.objectContaining({ soul: "You are careful." }),
      ),
    );
  });
});

describe("AgentConfigEditor · 环境变量", () => {
  it("设置 env：按钮受 value 控制，确认后提交 key 大写 + value + confirm", async () => {
    const user = userEvent.setup();
    render(<AgentConfigEditor agent={makeAgent()} />);
    await screen.findByDisplayValue("示例 agent");
    const setButton = screen.getByRole("button", { name: "设置" });
    expect(setButton).toBeDisabled();
    await user.type(screen.getByPlaceholderText(/\^\[A-Z\]/), "api_key");
    await user.type(screen.getByPlaceholderText("值不会被回显"), "sk-secret");
    expect(setButton).toBeEnabled();
    await user.click(setButton);
    expect(await screen.findByText(/值不会回显/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "确认写入" }));
    await waitFor(() =>
      expect(setEnvMock).toHaveBeenCalledWith("alpha", {
        key: "API_KEY",
        value: "sk-secret",
        confirm: true,
      }),
    );
  });

  it("删除 env 走 confirm 弹窗", async () => {
    const user = userEvent.setup();
    fetchConfigMock.mockResolvedValue(makeAgentConfig({ envKeys: ["API_KEY"] }));
    render(<AgentConfigEditor agent={makeAgent()} />);
    await screen.findByText("API_KEY");
    await user.click(screen.getByRole("button", { name: "删除" }));
    await user.click(await screen.findByRole("button", { name: "确认写入" }));
    await waitFor(() =>
      expect(removeEnvMock).toHaveBeenCalledWith("alpha", "API_KEY", { confirm: true }),
    );
  });
});

describe("AgentConfigEditor · MCP servers", () => {
  it("新增 MCP：名称为空时报 INVALID_MCP_SERVER；填好后确认提交 spec", async () => {
    const user = userEvent.setup();
    render(<AgentConfigEditor agent={makeAgent()} />);
    await screen.findByDisplayValue("示例 agent");
    await user.click(screen.getByRole("button", { name: /新增/ }));
    await user.click(screen.getByRole("button", { name: "添加" }));
    expect(screen.getByText(/INVALID_MCP_SERVER/)).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText(/\^\[a-zA-Z0-9\]/), "files");
    await user.type(screen.getByPlaceholderText("npx"), "npx");
    await user.type(screen.getByPlaceholderText(/以空格分隔/), "-y server");
    await user.click(screen.getByRole("button", { name: "添加" }));
    await user.click(await screen.findByRole("button", { name: "确认写入" }));
    await waitFor(() =>
      expect(addMcpMock).toHaveBeenCalledWith("alpha", {
        name: "files",
        spec: { command: "npx", args: ["-y", "server"] },
        confirm: true,
      }),
    );
  });

  it("编辑 MCP：name 不可改，确认后 updateMcpServer", async () => {
    const user = userEvent.setup();
    fetchConfigMock.mockResolvedValue(mcpConfig);
    render(<AgentConfigEditor agent={makeAgent()} />);
    await screen.findByText("npx -y server");
    await user.click(screen.getByRole("button", { name: "编辑" }));
    const nameInput = screen.getByDisplayValue("files");
    expect(nameInput).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "保存" }));
    await user.click(await screen.findByRole("button", { name: "确认写入" }));
    await waitFor(() =>
      expect(updateMcpMock).toHaveBeenCalledWith("alpha", "files", {
        spec: { command: "npx", args: ["-y", "server"] },
        confirm: true,
      }),
    );
  });

  it("删除 MCP：确认后 removeMcpServer", async () => {
    const user = userEvent.setup();
    fetchConfigMock.mockResolvedValue(mcpConfig);
    render(<AgentConfigEditor agent={makeAgent()} />);
    await screen.findByText("npx -y server");
    await user.click(screen.getByRole("button", { name: "删除" }));
    await user.click(await screen.findByRole("button", { name: "确认写入" }));
    await waitFor(() =>
      expect(removeMcpMock).toHaveBeenCalledWith("alpha", "files", { confirm: true }),
    );
  });
});
