import { useCallback, useEffect, useState, type ReactNode } from "react";
import type {
  Agent,
  AgentConfig,
  ConfigEditResult,
  McpServer,
  McpServerSpec,
} from "@shared/types";
import {
  ApiRequestError,
  addMcpServer,
  fetchAgentConfig,
  removeEnvVar,
  removeMcpServer,
  setEnvVar,
  updateAgentConfig,
  updateMcpServer,
} from "../api";
import Modal from "./Modal";

/**
 * Agent「配置」编辑区（M3）。
 *
 * 流程统一为：编辑表单 → 点保存 → 弹 Modal 展示将写入的文件与内容摘要 →
 * 用户确认（confirm:true）→ 调用 API → 显示结果 / 错误码 → 刷新详情。
 *
 * 安全提示：环境变量值只以 `type=password` 输入，提交后 UI 不回显明文；
 * 展示的 `.env` 键名后缀一律用 `••••` 掩码。
 */

type McpTransport = "stdio" | "http";

interface McpForm {
  mode: "add" | "edit";
  name: string;
  transport: McpTransport;
  command: string;
  args: string;
  url: string;
  headers: string;
}

interface Pending {
  title: string;
  summary: ReactNode;
  run: () => Promise<ConfigEditResult>;
}

/** 把任意异常转成可展示文案（含后端错误码）。 */
function errorText(error: unknown): string {
  if (error instanceof ApiRequestError) return `[${error.code}] ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

/** 逗号分隔 → 去空标签数组。 */
function parseTags(raw: string): string[] {
  return raw
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

/** 每行 `Key: Value` → headers 对象。 */
function parseHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(":");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (key) headers[key] = value;
  }
  return headers;
}

/** 表单 → McpServerSpec。 */
function specFromForm(form: McpForm): McpServerSpec {
  if (form.transport === "http") {
    const headers = parseHeaders(form.headers);
    return {
      url: form.url.trim(),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    };
  }
  const args = form.args.trim() ? form.args.trim().split(/\s+/) : undefined;
  return { command: form.command.trim(), ...(args ? { args } : {}) };
}

/** 已有 server → 表单。 */
function formFromServer(server: McpServer): McpForm {
  return {
    mode: "edit",
    name: server.name,
    transport: server.url ? "http" : "stdio",
    command: server.command ?? "",
    args: (server.args ?? []).join(" "),
    url: server.url ?? "",
    headers: server.headers
      ? Object.entries(server.headers)
          .map(([key, value]) => `${key}: ${value}`)
          .join("\n")
      : "",
  };
}

export default function AgentConfigEditor({
  agent,
  onRefresh,
}: {
  agent: Agent;
  onRefresh?: () => void;
}) {
  const [config, setConfig] = useState<AgentConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [model, setModel] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");

  const [mcpForm, setMcpForm] = useState<McpForm | null>(null);
  const [envKey, setEnvKey] = useState("");
  const [envValue, setEnvValue] = useState("");

  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchAgentConfig(agent.id);
      setConfig(data);
      setModel(data.model ?? "");
      setDescription(data.description);
      setTags(data.tags.join(", "));
    } catch (err) {
      setError(errorText(err));
      setConfig(null);
    } finally {
      setLoading(false);
    }
  }, [agent.id]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 执行待确认动作：成功 → 提示 + 重新加载；失败 → 展示错误码。 */
  const runPending = async () => {
    if (!pending) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await pending.run();
      const backupNote =
        result.backups.length > 0 ? `（已生成备份 ${result.backups.length} 份）` : "";
      setNotice(`${result.message}${backupNote}`);
      setPending(null);
      setMcpForm(null);
      setEnvValue("");
      await load();
      onRefresh?.();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const askSaveConfig = () => {
    if (!config) return;
    const patch: {
      model?: string;
      description: string;
      tags: string[];
      confirm: true;
    } = { description, tags: parseTags(tags), confirm: true };
    if (model.trim()) patch.model = model.trim();
    setPending({
      title: "确认保存配置",
      summary: (
        <ul className="confirm-list">
          <li>
            模型：<code>{patch.model ?? "（不修改）"}</code>
          </li>
          <li>描述：{description || "（空）"}</li>
          <li>标签：{parseTags(tags).join(", ") || "（无）"}</li>
          <li>
            config.yaml：<code>{config.configPath ?? "（将新建）"}</code>
          </li>
          <li>
            meta.json：<code>{config.metaPath}</code>
          </li>
        </ul>
      ),
      run: () => updateAgentConfig(agent.id, patch),
    });
  };

  const submitMcp = () => {
    if (!mcpForm) return;
    const spec = specFromForm(mcpForm);
    const isAdd = mcpForm.mode === "add";
    const name = mcpForm.name.trim();
    if (!name) {
      setError("[INVALID_MCP_SERVER] 请填写 MCP server 名。");
      return;
    }
    setPending({
      title: isAdd ? "确认新增 MCP server" : "确认更新 MCP server",
      summary: (
        <ul className="confirm-list">
          <li>
            name：<code>{name}</code>
          </li>
          <li>
            transport：<code>{mcpForm.transport}</code>
          </li>
          <li>
            spec：
            <code>
              {mcpForm.transport === "http"
                ? mcpForm.url
                : `${mcpForm.command} ${mcpForm.args}`.trim()}
            </code>
          </li>
          <li>
            写入：<code>{config?.configPath ?? "config.yaml"}</code>
          </li>
        </ul>
      ),
      run: () =>
        isAdd
          ? addMcpServer(agent.id, { name, spec, confirm: true })
          : updateMcpServer(agent.id, name, { spec, confirm: true }),
    });
  };

  const askRemoveMcp = (server: McpServer) => {
    setPending({
      title: "确认删除 MCP server",
      summary: (
        <ul className="confirm-list">
          <li>
            将删除：<code>{server.name}</code>
          </li>
          <li>
            文件：<code>{config?.configPath ?? "config.yaml"}</code>
          </li>
        </ul>
      ),
      run: () => removeMcpServer(agent.id, server.name, { confirm: true }),
    });
  };

  const askSetEnv = () => {
    const key = envKey.trim().toUpperCase();
    if (!key) {
      setError("[INVALID_KEY] 请填写环境变量名。");
      return;
    }
    setPending({
      title: "确认设置环境变量",
      summary: (
        <ul className="confirm-list">
          <li>
            key：<code>{key}</code>
          </li>
          <li>value：••••••（值不会回显）</li>
          <li>
            文件：<code>{config?.envPath ?? ".env"}</code>
          </li>
        </ul>
      ),
      run: () => setEnvVar(agent.id, { key, value: envValue, confirm: true }),
    });
  };

  const askRemoveEnv = (key: string) => {
    setPending({
      title: "确认删除环境变量",
      summary: (
        <ul className="confirm-list">
          <li>
            将删除：<code>{key}</code>
          </li>
          <li>
            文件：<code>{config?.envPath ?? ".env"}</code>
          </li>
        </ul>
      ),
      run: () => removeEnvVar(agent.id, key, { confirm: true }),
    });
  };

  return (
    <section className="detail-section config-editor">
      <h2>
        配置
        <button
          type="button"
          className="btn-ghost btn-sm"
          disabled={loading}
          onClick={() => void load()}
        >
          重新加载
        </button>
      </h2>

      {loading && <p className="hint">加载配置…</p>}
      {error && <div className="notice notice-error">{error}</div>}
      {notice && <div className="notice notice-ok">{notice}</div>}

      {config && (
        <>
          <div className="config-grid">
            <label className="form-row">
              <span className="field-label">模型</span>
              <input
                className="input"
                placeholder="deepseek/deepseek-flash"
                value={model}
                onChange={(event) => setModel(event.target.value)}
              />
            </label>
            <label className="form-row">
              <span className="field-label">标签</span>
              <input
                className="input"
                placeholder="以逗号分隔，例如：review, ci"
                value={tags}
                onChange={(event) => setTags(event.target.value)}
              />
            </label>
          </div>
          <label className="form-row config-textarea">
            <span className="field-label">功能描述</span>
            <textarea
              className="input"
              rows={3}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          <div className="config-actions">
            <button type="button" className="btn-primary" onClick={askSaveConfig}>
              保存配置
            </button>
            <span className="hint">
              config：<code>{config.configPath ?? "（将新建 config.yaml）"}</code>
            </span>
          </div>

          <div className="config-sub">
            <h3>
              MCP Servers <span className="section-count">{config.mcpServers.length}</span>
              <button
                type="button"
                className="btn-secondary btn-sm"
                onClick={() =>
                  setMcpForm({
                    mode: "add",
                    name: "",
                    transport: "stdio",
                    command: "",
                    args: "",
                    url: "",
                    headers: "",
                  })
                }
              >
                ＋ 新增
              </button>
            </h3>

            {config.mcpServers.length > 0 ? (
              <ul className="struct-list">
                {config.mcpServers.map((server) => (
                  <li key={server.id} className="struct-item">
                    <span className="struct-name chip-mcp-name">{server.name}</span>
                    <span className="chip">{server.transport ?? "stdio"}</span>
                    <code className="struct-meta">
                      {server.url
                        ? server.url
                        : [server.command, ...(server.args ?? [])].join(" ")}
                    </code>
                    <button
                      type="button"
                      className="btn-secondary btn-sm"
                      onClick={() => setMcpForm(formFromServer(server))}
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      className="btn-danger btn-sm"
                      onClick={() => askRemoveMcp(server)}
                    >
                      删除
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="hint">未配置 MCP server。</p>
            )}

            {mcpForm && (
              <div className="config-form">
                <div className="form-row">
                  <span className="field-label">name</span>
                  <input
                    className="input"
                    placeholder="^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$"
                    value={mcpForm.name}
                    disabled={mcpForm.mode === "edit"}
                    onChange={(event) =>
                      setMcpForm({ ...mcpForm, name: event.target.value })
                    }
                  />
                  <select
                    className="input"
                    value={mcpForm.transport}
                    onChange={(event) =>
                      setMcpForm({
                        ...mcpForm,
                        transport: event.target.value as McpTransport,
                      })
                    }
                  >
                    <option value="stdio">stdio</option>
                    <option value="http">http</option>
                  </select>
                </div>

                {mcpForm.transport === "stdio" ? (
                  <>
                    <div className="form-row">
                      <span className="field-label">command</span>
                      <input
                        className="input"
                        placeholder="npx"
                        value={mcpForm.command}
                        onChange={(event) =>
                          setMcpForm({ ...mcpForm, command: event.target.value })
                        }
                      />
                    </div>
                    <div className="form-row">
                      <span className="field-label">args</span>
                      <input
                        className="input"
                        placeholder="以空格分隔，例如：-y @modelcontextprotocol/server-filesystem"
                        value={mcpForm.args}
                        onChange={(event) =>
                          setMcpForm({ ...mcpForm, args: event.target.value })
                        }
                      />
                    </div>
                  </>
                ) : (
                  <>
                    <div className="form-row">
                      <span className="field-label">url</span>
                      <input
                        className="input"
                        placeholder="https://example.com/mcp"
                        value={mcpForm.url}
                        onChange={(event) =>
                          setMcpForm({ ...mcpForm, url: event.target.value })
                        }
                      />
                    </div>
                    <label className="form-row config-textarea">
                      <span className="field-label">headers</span>
                      <textarea
                        className="input"
                        rows={2}
                        placeholder="每行一个，Key: Value"
                        value={mcpForm.headers}
                        onChange={(event) =>
                          setMcpForm({ ...mcpForm, headers: event.target.value })
                        }
                      />
                    </label>
                  </>
                )}

                <div className="modal-actions">
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => setMcpForm(null)}
                  >
                    取消
                  </button>
                  <button type="button" className="btn-primary" onClick={submitMcp}>
                    {mcpForm.mode === "add" ? "添加" : "保存"}
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="config-sub">
            <h3>
              环境变量 <span className="section-count">{config.envKeys.length}</span>
            </h3>
            {config.envKeys.length > 0 ? (
              <ul className="struct-list">
                {config.envKeys.map((key) => (
                  <li key={key} className="struct-item">
                    <span className="struct-name">{key}</span>
                    <span className="struct-meta">••••••</span>
                    <button
                      type="button"
                      className="btn-danger btn-sm"
                      onClick={() => askRemoveEnv(key)}
                    >
                      删除
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="hint">未配置环境变量。</p>
            )}

            <div className="config-form">
              <div className="form-row">
                <span className="field-label">key</span>
                <input
                  className="input"
                  placeholder="^[A-Z][A-Z0-9_]*$"
                  value={envKey}
                  onChange={(event) => setEnvKey(event.target.value)}
                />
              </div>
              <div className="form-row">
                <span className="field-label">value</span>
                <input
                  className="input"
                  type="password"
                  autoComplete="off"
                  placeholder="值不会被回显"
                  value={envValue}
                  onChange={(event) => setEnvValue(event.target.value)}
                />
                <button
                  type="button"
                  className="btn-primary"
                  disabled={envValue.length === 0}
                  onClick={askSetEnv}
                >
                  设置
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {pending && (
        <Modal
          title={pending.title}
          onClose={() => setPending(null)}
          footer={
            <div className="modal-actions">
              <button
                type="button"
                className="btn-ghost"
                disabled={busy}
                onClick={() => setPending(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={busy}
                onClick={() => void runPending()}
              >
                {busy ? "执行中…" : "确认写入"}
              </button>
            </div>
          }
        >
          <div className="notice">
            写操作会先备份目标文件，再原子写入；失败可用返回的备份路径回滚。
          </div>
          {pending.summary}
        </Modal>
      )}
    </section>
  );
}
