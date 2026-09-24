import { useState } from "react";
import type { HermesStatus, LifecycleResult } from "@shared/types";
import { ApiRequestError, installAgent } from "../api";
import CommandResult from "./CommandResult";
import Modal from "./Modal";

/** 把任意异常转成可展示文案（含后端错误码）。 */
function errorText(error: unknown): string {
  if (error instanceof ApiRequestError) return `[${error.code}] ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

/**
 * 「＋ 安装 Agent」对话框。
 * 流程：填写 source(/name/alias) → dryRun 预览命令 → 确认执行 → 展示结果日志。
 * CLI 不可用时仍可 dryRun 预览，但禁用真实安装。
 */
export default function InstallAgentDialog({
  status,
  prefillSource,
  onClose,
  onDone,
}: {
  status: HermesStatus | null;
  prefillSource?: string;
  onClose: () => void;
  onDone?: () => void;
}) {
  const [source, setSource] = useState(prefillSource ?? "");
  const [name, setName] = useState("");
  const [alias, setAlias] = useState(false);
  const [preview, setPreview] = useState<LifecycleResult | null>(null);
  const [result, setResult] = useState<LifecycleResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const cliAvailable = status?.cliPath != null;

  const buildBody = (confirm: boolean, dryRun: boolean) => ({
    source: source.trim(),
    ...(name.trim() ? { name: name.trim() } : {}),
    ...(alias ? { alias: true } : {}),
    confirm,
    dryRun,
  });

  const handlePreview = async () => {
    setError(null);
    setResult(null);
    setBusy(true);
    try {
      setPreview(await installAgent(buildBody(false, true)));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const handleConfirm = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await installAgent(buildBody(true, false));
      setResult(res);
      setPreview(null);
      onDone?.();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="安装 Agent"
      onClose={onClose}
      footer={
        <div className="modal-actions">
          <button type="button" className="btn-ghost" onClick={onClose}>
            关闭
          </button>
          <button
            type="button"
            className="btn-secondary"
            disabled={busy || source.trim().length === 0}
            onClick={handlePreview}
          >
            预览命令 (dryRun)
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={busy || !preview || !cliAvailable}
            title={!cliAvailable ? "未检测到 hermes CLI，无法执行安装" : undefined}
            onClick={handleConfirm}
          >
            确认安装
          </button>
        </div>
      }
    >
      <div className="form">
        <label className="form-row">
          <span className="field-label">source *</span>
          <input
            className="input"
            placeholder="https://github.com/org/agent.git 或 /abs/local/dir"
            value={source}
            onChange={(event) => {
              setSource(event.target.value);
              setPreview(null);
            }}
          />
        </label>
        <label className="form-row">
          <span className="field-label">name</span>
          <input
            className="input"
            placeholder="可选，^[a-z0-9][a-z0-9_-]{0,63}$"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setPreview(null);
            }}
          />
        </label>
        <label className="form-row form-check">
          <input
            type="checkbox"
            checked={alias}
            onChange={(event) => {
              setAlias(event.target.checked);
              setPreview(null);
            }}
          />
          <span>创建别名（--alias）</span>
        </label>
      </div>

      {!cliAvailable && (
        <div className="notice">
          未检测到 hermes CLI：可预览将执行的命令，但无法真正安装。
        </div>
      )}
      {error && <div className="notice notice-error">{error}</div>}

      {preview && (
        <CommandResult result={preview} title="将执行（尚未执行）" />
      )}
      {result && <CommandResult result={result} title="执行结果" />}
    </Modal>
  );
}
