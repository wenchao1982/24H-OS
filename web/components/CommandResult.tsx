import type { LifecycleResult } from "@shared/types";

/**
 * 展示 lifecycle 执行结果：命令、退出码、stdout/stderr、备份路径。
 * 用于 dryRun 预览与真实执行结果的统一呈现。
 */
export default function CommandResult({
  result,
  title,
}: {
  result: LifecycleResult;
  title?: string;
}) {
  return (
    <div className="cmd-result">
      {title && <div className="cmd-title">{title}</div>}
      <div className="cmd-row">
        <span className="field-label">命令</span>
        <code className="cmd-command">{result.command}</code>
      </div>
      {result.backupPath && (
        <div className="cmd-row">
          <span className="field-label">备份</span>
          <code className="struct-meta">{result.backupPath}</code>
        </div>
      )}
      <div className="cmd-row">
        <span className="field-label">exit</span>
        <span className={result.code === 0 ? "cmd-ok" : "cmd-fail"}>
          {result.code ?? (result.dryRun ? "dry-run（未执行）" : "-")}
        </span>
      </div>
      {result.stdout && <pre className="cmd-output">{result.stdout}</pre>}
      {result.stderr && <pre className="cmd-output cmd-stderr">{result.stderr}</pre>}
    </div>
  );
}
