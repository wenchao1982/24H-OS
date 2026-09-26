/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import CommandResult from "./CommandResult";
import { makeLifecycleResult } from "../test-utils";

afterEach(cleanup);

describe("CommandResult", () => {
  it("展示命令、退出码、stdout / stderr 与标题", () => {
    render(
      <CommandResult
        title="执行结果"
        result={makeLifecycleResult({
          command: "hermes profile install x",
          code: 0,
          stdout: "ok out",
          stderr: "warn err",
        })}
      />,
    );
    expect(screen.getByText("执行结果")).toBeInTheDocument();
    expect(screen.getByText("hermes profile install x")).toBeInTheDocument();
    expect(screen.getByText("ok out")).toBeInTheDocument();
    expect(screen.getByText("warn err")).toBeInTheDocument();
    expect(screen.getByText("0")).toHaveClass("cmd-ok");
  });

  it("dryRun 且无退出码时显示「dry-run（未执行）」", () => {
    render(<CommandResult result={makeLifecycleResult({ code: null, dryRun: true })} />);
    expect(screen.getByText("dry-run（未执行）")).toBeInTheDocument();
  });

  it("非零退出码标红并展示备份路径", () => {
    render(
      <CommandResult
        result={makeLifecycleResult({
          code: 2,
          backupPath: "/tmp/backup.tar.gz",
        })}
      />,
    );
    expect(screen.getByText("2")).toHaveClass("cmd-fail");
    expect(screen.getByText("/tmp/backup.tar.gz")).toBeInTheDocument();
  });
});
