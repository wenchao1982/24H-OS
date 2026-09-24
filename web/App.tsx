import { useEffect, useMemo, useState } from "react";
import type { Agent, HermesStatus, MarketEntry, SkillUiInfo } from "@shared/types";
import { fetchAgents, fetchMarket, fetchSkillUis } from "./api";
import DeclarativePanel from "./components/DeclarativePanel";
import InstallAgentDialog from "./components/InstallAgentDialog";
import SkillHost from "./components/SkillHost";
import StatusDrawer from "./components/StatusDrawer";
import AgentDetail from "./pages/AgentDetail";

/**
 * 主布局：
 *   顶部 —— Hermes 状态条（已安装/未安装 + mock 提示）
 *   左侧 —— Tab：Agents 列表 / Skill 市场 / Agent 市场（安装）
 *   右侧 —— Agent 详情 或 正在打开的 Skill UI
 */
type Tab = "agents" | "market" | "store";

export default function App() {
  const [status, setStatus] = useState<HermesStatus | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [skillUis, setSkillUis] = useState<SkillUiInfo[]>([]);
  const [market, setMarket] = useState<MarketEntry[]>([]);
  const [marketMessage, setMarketMessage] = useState<string>("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeUi, setActiveUi] = useState<SkillUiInfo | null>(null);
  const [tab, setTab] = useState<Tab>("agents");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [installOpen, setInstallOpen] = useState(false);
  const [installSource, setInstallSource] = useState<string | undefined>(undefined);

  const loadAgents = async () => {
    const data = await fetchAgents();
    setStatus(data.status);
    setAgents(data.agents);
    setSelectedId((prev) =>
      prev && data.agents.some((agent) => agent.id === prev)
        ? prev
        : (data.agents[0]?.id ?? null),
    );
  };

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const [agentData, uis, marketData] = await Promise.all([
          fetchAgents(),
          fetchSkillUis().catch(() => [] as SkillUiInfo[]),
          fetchMarket().catch(() => ({ entries: [] as MarketEntry[], message: "" })),
        ]);
        if (cancelled) return;
        setStatus(agentData.status);
        setAgents(agentData.agents);
        setSkillUis(uis);
        setMarket(marketData.entries);
        setMarketMessage(marketData.message);
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

  const openInstall = (source?: string) => {
    setInstallSource(source);
    setInstallOpen(true);
  };

  const refreshAfterMutation = async () => {
    try {
      await loadAgents();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="app">
      <StatusBar status={status} error={error} />
      <div className="status-drawer-anchor">
        <StatusDrawer />
      </div>

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
              Skill <span className="count">{skillUis.length}</span>
            </button>
            <button
              type="button"
              className={tab === "store" ? "tab active" : "tab"}
              onClick={() => setTab("store")}
            >
              Agent 市场 <span className="count">{market.length}</span>
            </button>
          </div>

          <div className="sidebar-toolbar">
            <button
              type="button"
              className="btn-primary btn-block"
              onClick={() => openInstall()}
            >
              ＋ 安装 Agent
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
                    {ui.disabled && <span className="struct-off">已禁用</span>}
                  </div>
                  <p className="market-desc">
                    {ui.uiHost === "declarative"
                      ? `声明式面板 · ${ui.panel?.fields.length ?? 0} 个字段`
                      : (ui.manifest?.capabilities.join(" · ") ?? "")}
                  </p>
                  {!ui.disabled && (
                    <button
                      type="button"
                      className="btn-skill-ui"
                      onClick={() => setActiveUi(ui)}
                    >
                      打开 Skill UI
                    </button>
                  )}
                </li>
              ))}
              {!loading && skillUis.length === 0 && (
                <div className="hint">未发现自带 UI 的 skill。</div>
              )}
            </ul>
          )}

          {tab === "store" && (
            <ul className="agent-list">
              {market.map((entry) => (
                <li key={entry.id} className="market-item">
                  <div className="market-head">
                    <span className="agent-item-name">{entry.name}</span>
                    {entry.version && <span className="market-id">v{entry.version}</span>}
                  </div>
                  <p className="market-desc">{entry.description}</p>
                  {entry.tags && entry.tags.length > 0 && (
                    <div className="market-tags">
                      {entry.tags.map((tag) => (
                        <span key={tag} className="chip market-tag">
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                  <code className="struct-meta">{entry.source}</code>
                  <button
                    type="button"
                    className="btn-primary btn-skill-ui"
                    onClick={() => openInstall(entry.source)}
                  >
                    安装
                  </button>
                </li>
              ))}
              {!loading && market.length === 0 && (
                <div className="hint">{marketMessage || "市场为空。"}</div>
              )}
            </ul>
          )}

          {!loading && tab === "agents" && agents.length === 0 && (
            <div className="hint">还没有 agent。</div>
          )}
        </aside>

        <main className="content">
          {selectedAgent ? (
            <AgentDetail
              agent={selectedAgent}
              status={status}
              onOpenSkillUi={openSkillUi}
              onRefresh={refreshAfterMutation}
            />
          ) : (
            <div className="empty">请选择左侧的一个 agent。</div>
          )}
        </main>
      </div>

      {activeUi && (
        <div className="skill-host-panel">
          {activeUi.uiHost === "declarative" ? (
            <DeclarativePanel skill={activeUi} onClose={() => setActiveUi(null)} />
          ) : (
            <SkillHost skill={activeUi} onClose={() => setActiveUi(null)} />
          )}
        </div>
      )}

      {installOpen && (
        <InstallAgentDialog
          status={status}
          prefillSource={installSource}
          onClose={() => setInstallOpen(false)}
          onDone={refreshAfterMutation}
        />
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
