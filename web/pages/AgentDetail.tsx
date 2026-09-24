import { useState } from "react";
import type { Agent } from "@shared/types";

/**
 * Agent 详情页。
 * M1：只读展示 描述 / 模型 / skills / MCP servers。
 * 预留「编辑」按钮（当前禁用，不落盘）。
 *
 * TODO(M2+): 「编辑」将对接 hermes profile update；
 *            下方 skills 区域将来是 Skill UI 的宿主；
 *            MCP servers 区域将来是 MCP 网关的入口。
 */
export default function AgentDetail({
  agent,
  onOpenSkillUi,
}: {
  agent: Agent;
  onOpenSkillUi?: (uiId: string) => void;
}) {
  const [editingHint, setEditingHint] = useState<string | null>(null);

  const handleEdit = () => {
    // M1 不落盘，仅提示。
    setEditingHint("编辑功能将在 M2 接入 hermes profile update，暂未启用。");
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
          <button type="button" className="btn-edit" onClick={handleEdit}>
            编辑
          </button>
        </div>
      </header>

      {editingHint && <div className="notice">{editingHint}</div>}

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
            {agent.skills.map((skill) => (
              <li key={skill.id} className="struct-item">
                <span className="struct-name">{skill.name}</span>
                {skill.description && (
                  <span className="struct-desc">{skill.description}</span>
                )}
                {skill.path && <code className="struct-meta">{skill.path}</code>}
                {skill.enabled === false && (
                  <span className="struct-off">disabled</span>
                )}
                {skill.hasUi && skill.uiId && (
                  <button
                    type="button"
                    className="btn-skill-ui"
                    onClick={() => onOpenSkillUi?.(skill.uiId as string)}
                  >
                    打开 Skill UI
                  </button>
                )}
              </li>
            ))}
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
    </article>
  );
}
