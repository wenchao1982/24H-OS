/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CronJobsResponse } from "@shared/types";

const mocks = vi.hoisted(() => ({
  fetchCronJobs: vi.fn(),
  addCronJob: vi.fn(),
  pauseCronJob: vi.fn(),
  resumeCronJob: vi.fn(),
  removeCronJob: vi.fn(),
  runCronJob: vi.fn(),
}));

vi.mock("../api", () => mocks);

import CronPanel from "./CronPanel";

function makeResponse(
  overrides: Partial<CronJobsResponse> = {},
): CronJobsResponse {
  return {
    jobs: [
      {
        job_id: "j1",
        name: "daily-report",
        schedule: "30m",
        prompt_preview: "生成简报",
        next_run_at: "2026-09-25T10:00:00+08:00",
        last_status: "ok",
        enabled: true,
      },
    ],
    count: 1,
    includeDisabled: true,
    scoped: null,
    ticker: { enabled: true, gatewayRunning: true, gatewayConnected: true },
    warning: null,
    message: "官方 Cron 共 1 个定时任务。",
    ...overrides,
  };
}

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.fetchCronJobs.mockResolvedValue(makeResponse());
  mocks.pauseCronJob.mockResolvedValue({ ok: true, action: "pause", name: "daily-report" });
  mocks.resumeCronJob.mockResolvedValue({ ok: true, action: "resume", name: "daily-report" });
  mocks.removeCronJob.mockResolvedValue({ ok: true, action: "remove", name: "daily-report" });
  mocks.runCronJob.mockResolvedValue({ ok: true, action: "run", name: "daily-report" });
  mocks.addCronJob.mockResolvedValue({ ok: true, action: "add", name: "new-job" });
});

afterEach(() => {
  cleanup();
});

describe("CronPanel", () => {
  it("加载并展示官方 cron 任务与触发器状态", async () => {
    render(<CronPanel />);
    expect(await screen.findByText("daily-report")).toBeInTheDocument();
    expect(screen.getByText("30m")).toBeInTheDocument();
    expect(screen.getByText(/官方 ticker 已启用/)).toBeInTheDocument();
    expect(screen.getByText(/gateway 运行中/)).toBeInTheDocument();
    expect(mocks.fetchCronJobs).toHaveBeenCalledWith({ includeDisabled: true });
  });

  it("点击暂停 → 调 pauseCronJob 并刷新", async () => {
    render(<CronPanel />);
    await screen.findByText("daily-report");
    fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    await waitFor(() => expect(mocks.pauseCronJob).toHaveBeenCalledWith("daily-report"));
    expect(mocks.fetchCronJobs).toHaveBeenCalledTimes(2);
  });

  it("已暂停任务显示「恢复」并可恢复", async () => {
    mocks.fetchCronJobs.mockResolvedValue(
      makeResponse({
        jobs: [
          {
            job_id: "j2",
            name: "off",
            schedule: "1h",
            prompt_preview: "",
            enabled: false,
          },
        ],
      }),
    );
    render(<CronPanel />);
    await screen.findByText("off");
    fireEvent.click(screen.getByRole("button", { name: "恢复" }));
    await waitFor(() => expect(mocks.resumeCronJob).toHaveBeenCalledWith("off"));
  });

  it("切换「显示已暂停」重新拉取（includeDisabled=false）", async () => {
    render(<CronPanel />);
    await screen.findByText("daily-report");
    fireEvent.click(screen.getByRole("checkbox"));
    await waitFor(() =>
      expect(mocks.fetchCronJobs).toHaveBeenLastCalledWith({ includeDisabled: false }),
    );
  });

  it("填写表单后创建任务", async () => {
    render(<CronPanel />);
    await screen.findByText("daily-report");
    fireEvent.change(screen.getByPlaceholderText(/名称/), { target: { value: "new-job" } });
    fireEvent.change(screen.getByPlaceholderText(/计划/), { target: { value: "every 2h" } });
    fireEvent.change(screen.getByPlaceholderText(/提示词/), { target: { value: "do it" } });
    fireEvent.click(screen.getByRole("button", { name: "创建定时任务" }));
    await waitFor(() =>
      expect(mocks.addCronJob).toHaveBeenCalledWith({
        name: "new-job",
        schedule: "every 2h",
        prompt: "do it",
      }),
    );
  });

  it("加载失败显示错误", async () => {
    mocks.fetchCronJobs.mockRejectedValue(new Error("boom"));
    render(<CronPanel />);
    expect(await screen.findByText(/boom/)).toBeInTheDocument();
  });
});
