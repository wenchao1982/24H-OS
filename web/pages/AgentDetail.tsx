import { useState } from "react";
import type { Agent, HermesStatus, LifecycleResult } from "@shared/types";
import { ApiRequestError, backupAgent, deleteAgent, updateAgent } from "../api";
import AgentConfigEditor from "../components/AgentConfigEditor";
import CommandResult from "../components/CommandResult";
import Modal from "../components/Modal";

/**
 * Agent 详情页。
 * M1：只读展示 描述 / 模型 / skills / MCP servers。
 * M2-core：新增「更新」「备份」「卸载」——先 dryRun 预览命令，再确认执行。
 */

type LifecycleKind = "update" | "backup" | "delete";

/** 把任意异常转成可展示文案（含后端错误码）。 */
function errorText(error: unknown): string {
  if (error instanceof ApiRequestError) return `[${error.code}] ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

const RISK_TEXT: Record<LifecycleKind, string> = {
  update: "将执行 hermes profile update，可能覆盖该 profile 的本地修改。",
  backup: "将把该 profile 导出为 tar.gz 备份文件（只读操作）。",
  delete: "此操作会卸载该 profile（默认先导出备份）。删除不可撤销，请谨慎确认。",
};

export default function AgentDetail({
  agent,
  status,
  onOpenSkillUi,
  onRefresh,
}: {
  agent: Agent;
  status?: HermesStatus | null;
  onOpenSkillUi?: (uiId: string) => void;
  onRefresh?: () => void;
}) {
  const [pending, setPending] = useState<{
    kind: LifecycleKind;
    preview: LifecycleResult;
  } | null>(null);
  const [result, setResult] = useState<LifecycleResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const cliAvailable = status?.cliPath != null;
  const cliReason = "未检测到 hermes CLI，生命周期操作不可用（仍可预览 dryRun）。";

  const startLifecycle = async (kind: LifecycleKind) => {
    setError(null);
    setResult(null);
    setBusy(true);
    try {
      const preview =
        kind === "update"
          ? await updateAgent(agent.id, { dryRun: true })
          : kind === "backup"
            ? await backupAgent(agent.id, { dryRun: true })
            : await deleteAgent(agent.id, { dryRun: true });
      setPending({ kind, preview });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const confirmPending = async () => {
    if (!pending) return;
    setError(null);
    setBusy(true);
    try {
      const res =
        pending.kind === "update"
          ? await updateAgent(agent.id, { confirm: true })
          : pending.kind === "backup"
            ? await backupAgent(agent.id)
            : await deleteAgent(agent.id, { confirm: true, backup: true });
      setResult(res);
      setPending(null);
      onRefresh?.();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="detail">
      <header className="detail-header">
        <div>
          <h1>{agent.name}</h1>
          <p className="detail-path" title={agent.path}>
            {agent.path}
          </p>
        </div>
        <div className="detail-actions">
          <span className={agent.source === "mock" ? "badge badge-mock" : "badge badge-live"}>
            {agent.source === "mock" ? "mock" : "profile"}
          </span>
          <button
            type="button"
            className="btn-secondary"
            disabled={busy || !cliAvailable}
            title={!cliAvailable ? cliReason : undefined}
            onClick={() => startLifecycle("update")}
          >
            更新
          </button>
          <button
            type="button"
            className="btn-secondary"
            disabled={busy || !cliAvailable}
            title={!cliAvailable ? cliReason : undefined}
            onClick={() => startLifecycle("backup")}
          >
            备份
          </button>
          <button
            type="button"
            className="btn-danger"
            disabled={busy || !cliAvailable}
            title={!cliAvailable ? cliReason : undefined}
            onClick={() => startLifecycle("delete")}
          >
            卸载
          </button>
        </div>
      </header>

      {!cliAvailable && <div className="notice">{cliReason}</div>}
      {error && <div className="notice notice-error">{error}</div>}

      {result && <CommandResult result={result} title="执行结果" />}

      <section className="detail-section">
        <h2>功能描述</h2>
        <p className="description">{agent.description}</p>
      </section>

      <section className="detail-section">
        <h2>模型</h2>
        <div className="field">
          <span className="field-label">model</span>
          <span className="field-value">{agent.model}</span>
        </div>
      </section>

      <section className="detail-section">
        <h2>
          Skills <span className="section-count">{agent.skills.length}</span>
        </h2>
        {agent.skills.length > 0 ? (
          <ul className="struct-list">
            {agent.skills.map((skill) => {
              const disabled = skill.enabled === false;
              return (
                <li key={skill.id} className="struct-item">
                  <span className="struct-name">{skill.name}</span>
                  {skill.description && (
                    <span className="struct-desc">{skill.description}</span>
                  )}
                  {skill.path && <code className="struct-meta">{skill.path}</code>}
                  {disabled && <span className="struct-off">已禁用</span>}
                  {skill.hasUi && skill.uiId && !disabled && (
                    <button
                      type="button"
                      className="btn-skill-ui"
                      onClick={() => onOpenSkillUi?.(skill.uiId as string)}
                    >
                      打开 Skill UI
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="hint">未配置 skill。</p>
        )}
        <p className="todo-note">
          M4：带 UI 的 skill 可在此一键在沙箱 iframe 中打开（24os-skill-ui/1）。
        </p>
      </section>

      <section className="detail-section">
        <h2>
          MCP Servers <span className="section-count">{agent.mcpServers.length}</span>
        </h2>
        {agent.mcpServers.length > 0 ? (
          <ul className="struct-list">
            {agent.mcpServers.map((server) => (
              <li key={server.id} className="struct-item">
                <span className="struct-name chip-mcp-name">{server.name}</span>
                {server.command && (
                  <code className="struct-meta">
                    {[server.command, ...(server.args ?? [])].join(" ")}
                  </code>
                )}
                {server.enabled === false && (
                  <span className="struct-off">disabled</span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="hint">未配置 MCP server。</p>
        )}
        <p className="todo-note">TODO: 此处将来接入 MCP 网关。</p>
      </section>

      <AgentConfigEditor agent={agent} onRefresh={onRefresh} />

      {pending && (
        <Modal
          title={
            pending.kind === "delete"
              ? "确认卸载 Agent"
              : pending.kind === "update"
                ? "确认更新 Agent"
                : "确认备份 Agent"
          }
          onClose={() => setPending(null)}
          footer={
            <div className="modal-actions">
              <button
                type="button"
                className="btn-ghost"
                onClick={() => setPending(null)}
              >
                取消
              </button>
              <button
                type="button"
                className={pending.kind === "delete" ? "btn-danger" : "btn-primary"}
                disabled={busy || !cliAvailable}
                title={!cliAvailable ? cliReason : undefined}
                onClick={confirmPending}
              >
                {pending.kind === "delete" ? "确认卸载" : "确认执行"}
              </button>
            </div>
          }
        >
          <div className={pending.kind === "delete" ? "notice notice-error" : "notice"}>
            {RISK_TEXT[pending.kind]}
          </div>
          <CommandResult result={pending.preview} title="将执行（尚未执行）" />
        </Modal>
      )}
    </article>
  );
}
