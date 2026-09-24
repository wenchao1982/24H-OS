import { useEffect, useMemo, useState } from "react";
import type { Agent, HermesStatus, SkillUiInfo } from "@shared/types";
import { fetchAgents, fetchSkillUis } from "./api";
import SkillHost from "./components/SkillHost";
import AgentDetail from "./pages/AgentDetail";

/**
 * 主布局：
 *   顶部 —— Hermes 状态条（已安装/未安装 + mock 提示）
 *   左侧 —— Tab：Agents 列表 / Skill 市场
 *   右侧 —— Agent 详情 或 正在打开的 Skill UI
 */
type Tab = "agents" | "market";

export default function App() {
  const [status, setStatus] = useState<HermesStatus | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [skillUis, setSkillUis] = useState<SkillUiInfo[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeUi, setActiveUi] = useState<SkillUiInfo | null>(null);
  const [tab, setTab] = useState<Tab>("agents");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const [agentData, uis] = await Promise.all([
          fetchAgents(),
          fetchSkillUis().catch(() => [] as SkillUiInfo[]),
        ]);
        if (cancelled) return;
        setStatus(agentData.status);
        setAgents(agentData.agents);
        setSkillUis(uis);
        setSelectedId(agentData.agents[0]?.id ?? null);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === selectedId) ?? null,
    [agents, selectedId],
  );

  const openSkillUi = (uiId: string) => {
    const info = skillUis.find((item) => item.id === uiId);
    if (info) setActiveUi(info);
  };

  return (
    <div className="app">
      <StatusBar status={status} error={error} />

      <div className="layout">
        <aside className="sidebar">
          <div className="sidebar-header tabs">
            <button
              type="button"
              className={tab === "agents" ? "tab active" : "tab"}
              onClick={() => setTab("agents")}
            >
              Agents <span className="count">{agents.length}</span>
            </button>
            <button
              type="button"
              className={tab === "market" ? "tab active" : "tab"}
              onClick={() => setTab("market")}
            >
              Skill 市场 <span className="count">{skillUis.length}</span>
            </button>
          </div>

          {loading && <div className="hint">加载中…</div>}

          {tab === "agents" && (
            <ul className="agent-list">
              {agents.map((agent) => (
                <li key={agent.id}>
                  <button
                    type="button"
                    className={agent.id === selectedId ? "agent-item active" : "agent-item"}
                    onClick={() => setSelectedId(agent.id)}
                  >
                    <span className="agent-item-name">{agent.name}</span>
                    <span className="agent-item-model">{agent.model}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {tab === "market" && (
            <ul className="agent-list">
              {skillUis.map((ui) => (
                <li key={ui.id} className="market-item">
                  <div className="market-head">
                    <span className="agent-item-name">{ui.title}</span>
                    <span className="market-id">{ui.id}</span>
                  </div>
                  <p className="market-desc">
                    {ui.manifest.capabilities.join(" · ")}
                  </p>
                  <button
                    type="button"
                    className="btn-skill-ui"
                    onClick={() => setActiveUi(ui)}
                  >
                    打开 Skill UI
                  </button>
                </li>
              ))}
              {!loading && skillUis.length === 0 && (
                <div className="hint">未发现自带 UI 的 skill。</div>
              )}
            </ul>
          )}

          {!loading && tab === "agents" && agents.length === 0 && (
            <div className="hint">还没有 agent。</div>
          )}
        </aside>

        <main className="content">
          {selectedAgent ? (
            <AgentDetail agent={selectedAgent} onOpenSkillUi={openSkillUi} />
          ) : (
            <div className="empty">请选择左侧的一个 agent。</div>
          )}
        </main>
      </div>

      {activeUi && (
        <div className="skill-host-panel">
          <SkillHost skill={activeUi} onClose={() => setActiveUi(null)} />
        </div>
      )}
    </div>
  );
}

/** 顶部 Hermes 状态条。 */
function StatusBar({
  status,
  error,
}: {
  status: HermesStatus | null;
  error: string | null;
}) {
  if (error) {
    return (
      <header className="status-bar offline">
        <span className="dot" />
        <span className="status-text">无法连接后端：{error}</span>
        <span className="status-hint">请确认已运行 npm run dev:server</span>
      </header>
    );
  }

  if (!status) {
    return (
      <header className="status-bar">
        <span className="dot pending" />
        <span className="status-text">正在探测 Hermes…</span>
      </header>
    );
  }

  const isMock = status.mode === "mock";

  return (
    <header className={isMock ? "status-bar mock" : "status-bar live"}>
      <span className="dot" />
      <span className="status-text">
        Hermes {status.available ? "已连接" : "未连接"}
        {status.version ? ` · ${status.version}` : ""}
      </span>
      <span className={isMock ? "badge badge-mock" : "badge badge-live"}>
        {isMock ? "MOCK 数据" : "LIVE 数据"}
      </span>
      <span className="status-message">{status.message}</span>
    </header>
  );
}
