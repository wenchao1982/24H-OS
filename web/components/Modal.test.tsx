/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Modal from "./Modal";

afterEach(cleanup);

describe("Modal", () => {
  it("渲染标题、正文与 footer", () => {
    render(
      <Modal title="确认操作" onClose={() => {}} footer={<button type="button">确定</button>}>
        <p>正文内容</p>
      </Modal>,
    );
    expect(screen.getByRole("dialog", { name: "确认操作" })).toBeInTheDocument();
    expect(screen.getByText("正文内容")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确定" })).toBeInTheDocument();
  });

  it("点击遮罩层触发 onClose", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <Modal title="t" onClose={onClose}>
        <p>x</p>
      </Modal>,
    );
    await user.click(screen.getByRole("presentation"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("点击弹窗内部不触发 onClose（stopPropagation）", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <Modal title="t" onClose={onClose}>
        <p>内部文本</p>
      </Modal>,
    );
    await user.click(screen.getByText("内部文本"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("关闭按钮触发 onClose", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <Modal title="t" onClose={onClose}>
        <p>x</p>
      </Modal>,
    );
    await user.click(screen.getByRole("button", { name: "关闭" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
