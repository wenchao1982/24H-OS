/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import InstallAgentDialog from "./InstallAgentDialog";
import { ApiRequestError, installAgent } from "../api";
import { makeLifecycleResult, makeStatus } from "../test-utils";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, installAgent: vi.fn() };
});

const installMock = installAgent as unknown as Mock;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  installMock.mockResolvedValue(makeLifecycleResult({ action: "install" }));
});

describe("InstallAgentDialog", () => {
  it("CLI 不可用：显示提示且禁用「确认安装」", () => {
    render(
      <InstallAgentDialog
        status={makeStatus({ cliPath: null })}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText(/未检测到 hermes CLI/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认安装" })).toBeDisabled();
  });

  it("source 为空时禁用「预览命令」", () => {
    render(<InstallAgentDialog status={makeStatus()} onClose={() => {}} />);
    expect(screen.getByRole("button", { name: /预览命令/ })).toBeDisabled();
  });

  it("prefillSource 作为初始值", () => {
    render(
      <InstallAgentDialog
        status={makeStatus()}
        prefillSource="https://github.com/org/app.git"
        onClose={() => {}}
      />,
    );
    expect(screen.getByDisplayValue("https://github.com/org/app.git")).toBeInTheDocument();
  });

  it("预览调用 dryRun:true 并展示 CommandResult", async () => {
    const user = userEvent.setup();
    render(<InstallAgentDialog status={makeStatus()} onClose={() => {}} />);
    await user.type(screen.getByPlaceholderText(/github.com/),
      "https://github.com/org/app.git",
    );
    await user.click(screen.getByRole("button", { name: /预览命令/ }));
    await waitFor(() => expect(installMock).toHaveBeenCalledTimes(1));
    expect(installMock).toHaveBeenCalledWith({
      source: "https://github.com/org/app.git",
      confirm: false,
      dryRun: true,
    });
    expect(await screen.findByText("将执行（尚未执行）")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认安装" })).toBeEnabled();
  });

  it("填写 name / alias 后确认安装，参数正确且回调 onDone", async () => {
    const user = userEvent.setup();
    const onDone = vi.fn();
    render(
      <InstallAgentDialog status={makeStatus()} onClose={() => {}} onDone={onDone} />,
    );
    await user.type(screen.getByPlaceholderText(/github.com/), "https://x/app.git");
    await user.type(screen.getByPlaceholderText(/\^\[a-z0-9\]/), "beta");
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: /预览命令/ }));
    await screen.findByText("将执行（尚未执行）");
    await user.click(screen.getByRole("button", { name: "确认安装" }));
    await waitFor(() =>
      expect(installMock).toHaveBeenLastCalledWith({
        source: "https://x/app.git",
        name: "beta",
        alias: true,
        confirm: true,
        dryRun: false,
      }),
    );
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("执行结果")).toBeInTheDocument();
  });

  it("安装失败时展示后端错误码", async () => {
    const user = userEvent.setup();
    installMock.mockRejectedValueOnce(
      new ApiRequestError(409, "CONFIRM_REQUIRED", "需要确认"),
    );
    render(<InstallAgentDialog status={makeStatus()} onClose={() => {}} />);
    await user.type(screen.getByPlaceholderText(/github.com/), "https://x/app.git");
    await user.click(screen.getByRole("button", { name: /预览命令/ }));
    expect(await screen.findByText("[CONFIRM_REQUIRED] 需要确认")).toBeInTheDocument();
  });
});
