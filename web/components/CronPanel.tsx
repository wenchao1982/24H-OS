import { useCallback, useEffect, useState } from "react";
import type { CronJob, CronJobsResponse } from "@shared/types";
import {
  addCronJob,
  fetchCronJobs,
  pauseCronJob,
  removeCronJob,
  resumeCronJob,
  runCronJob,
} from "../api";

/**
 * M8 定时任务面板：直接读写 Hermes **官方 Cron**（`cron.manage` 薄封装）。
 * 工作台不再自带调度器；任务是否自动触发取决于服务器 gateway 是否以
 * `HERMES_DESKTOP=1` 运行（官方内置 ticker），面板顶部展示该状态。
 */

function formatTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function statusLabel(job: CronJob): string {
  if (job.enabled === false) return "已暂停";
  if (job.last_status) return job.last_status;
  return job.state ?? "待运行";
}

export default function CronPanel() {
  const [data, setData] = useState<CronJobsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [includeDisabled, setIncludeDisabled] = useState(true);

  const [name, setName] = useState("");
  const [schedule, setSchedule] = useState("30m");
  const [prompt, setPrompt] = useState("");

  const load = useCallback(async () => {
    try {
      setError(null);
      const result = await fetchCronJobs({ includeDisabled });
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [includeDisabled]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onCreate = async () => {
    await act(() => addCronJob({ name, schedule, prompt }));
    setName("");
    setPrompt("");
  };

  return (
    <div className="cron-panel">
      <div className="cron-head">
        <h2>定时任务（官方 Hermes Cron）</h2>
        <button
          type="button"
          className="btn-skill-ui"
          onClick={() => void load()}
          disabled={busy}
        >
          刷新
        </button>
      </div>

      {data && (
        <p className="hint">
          触发器：{data.ticker.enabled ? "官方 ticker 已启用" : "已关闭（OS_CRON_TICKER=0）"}
          {" · "}
          gateway {data.ticker.gatewayRunning ? "运行中" : "未运行"}
          {data.ticker.gatewayConnected ? "（已连接）" : ""}
          {" · "}
          调度实现=Hermes 官方 cron（工作台仅 UI/封装）
        </p>
      )}
      {data?.warning && <p className="hint cron-warn">⚠ {data.warning}</p>}
      {error && <p className="cron-error">⚠ {error}</p>}

      <label className="cron-toggle">
        <input
          type="checkbox"
          checked={includeDisabled}
          onChange={(event) => setIncludeDisabled(event.target.checked)}
        />
        显示已暂停
      </label>

      <table className="cron-table">
        <thead>
          <tr>
            <th>名称</th>
            <th>计划</th>
            <th>下次运行</th>
            <th>上次状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {(data?.jobs ?? []).map((job) => (
            <tr key={job.job_id || job.name}>
              <td>
                <span className="cron-name">{job.name}</span>
                {job.no_agent && <span className="chip">script</span>}
                <div className="cron-preview">{job.prompt_preview}</div>
              </td>
              <td>{job.schedule}</td>
              <td>{formatTime(job.next_run_at)}</td>
              <td>
                <span className={job.enabled === false ? "cron-off" : ""}>
                  {statusLabel(job)}
                </span>
              </td>
              <td className="cron-actions">
                {job.enabled === false ? (
                  <button type="button" disabled={busy} onClick={() => void act(() => resumeCronJob(job.name))}>
                    恢复
                  </button>
                ) : (
                  <button type="button" disabled={busy} onClick={() => void act(() => pauseCronJob(job.name))}>
                    暂停
                  </button>
                )}
                <button type="button" disabled={busy} onClick={() => void act(() => runCronJob(job.name))}>
                  立即运行
                </button>
                <button
                  type="button"
                  className="danger"
                  disabled={busy}
                  onClick={() => void act(() => removeCronJob(job.name))}
                >
                  删除
                </button>
              </td>
            </tr>
          ))}
          {data && data.jobs.length === 0 && (
            <tr>
              <td colSpan={5} className="hint">
                暂无定时任务。
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <div className="cron-create">
        <h3>新增（写入官方 Cron，需确认）</h3>
        <div className="cron-create-row">
          <input
            placeholder="名称（^[a-z0-9_-]+$）"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <input
            placeholder="计划：30m / every 2h / 0 9 * * *"
            value={schedule}
            onChange={(event) => setSchedule(event.target.value)}
          />
        </div>
        <textarea
          placeholder="提示词（自包含任务）"
          value={prompt}
          rows={3}
          onChange={(event) => setPrompt(event.target.value)}
        />
        <button
          type="button"
          className="btn-primary"
          disabled={busy || !name.trim() || !schedule.trim() || !prompt.trim()}
          onClick={() => void onCreate()}
        >
          创建定时任务
        </button>
      </div>
    </div>
  );
}
