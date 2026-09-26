import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  E2E_PORT,
  E2E_TMP_ROOT,
  MARKET_APPS_DIR,
  MARKET_FILE,
  REPO_ROOT,
  SKILL_ROOTS,
  STUB_CLI,
  STUB_LOG,
  TMP_APPS_DIR,
  TMP_BACKUP_DIR,
  TMP_HERMES_HOME,
  TMP_HOME,
  TMP_META_DIR,
  TMP_WORKSPACE_ROOT,
  WEB_DIST,
  DISABLED_SKILL,
} from "./env";

/**
 * e2e webServer 启动包装（`npm run e2e:server` → `tsx e2e/start-server.ts`）。
 *
 * 职责：
 *   1. 清理并重建**临时** e2e 根目录（HOME/HERMES_HOME/备份/元数据/工作区全在 /tmp）；
 *   2. 写入假 hermes CLI（记录参数 + 固定文本，绝不调模型）；
 *   3. 预置 profile `main` 的 `config.yaml`（`skills.disabled: [ppt]`，供禁用 UI 用例）；
 *   4. 用隔离 env spawn `tsx server/index.ts`，并把信号转发给子进程。
 *
 * 真实 `~/.hermes` / `~/hermes-desktop` / `~/.24os` 全程不被读写。
 */

/** 假 CLI：把参数以 JSON Lines 追加到 STUB_LOG；`--version` 输出固定版本。 */
const STUB_SOURCE = `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(STUB_LOG)}, JSON.stringify(args) + "\\n");
if (args.includes("--version")) {
  process.stdout.write("hermes-stub 0.0.0-e2e\\n");
  process.exit(0);
}
process.stdout.write("stub ok " + args.join(" ") + "\\n");
process.exit(0);
`;

function seedIsolatedHome(): void {
  rmSync(E2E_TMP_ROOT, { recursive: true, force: true });
  for (const dir of [
    TMP_HOME,
    path.join(TMP_HERMES_HOME, "profiles", "main"),
    TMP_BACKUP_DIR,
    TMP_META_DIR,
    TMP_WORKSPACE_ROOT,
    TMP_APPS_DIR,
  ]) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(STUB_CLI, STUB_SOURCE, "utf8");
  chmodSync(STUB_CLI, 0o755);

  // 预置 profile `main`：一个可解析的 agent + 官方 `skills.disabled`。
  writeFileSync(
    path.join(TMP_HERMES_HOME, "profiles", "main", "config.yaml"),
    [
      "model: e2e-stub-model",
      "skills:",
      "  disabled:",
      `    - ${DISABLED_SKILL}`,
      "",
    ].join("\n"),
    "utf8",
  );
}

function main(): void {
  seedIsolatedHome();

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "test",
    PORT: String(E2E_PORT),
    HOST: "127.0.0.1",
    HOME: TMP_HOME,
    HERMES_HOME: TMP_HERMES_HOME,
    OS_HERMES_HOME: TMP_HERMES_HOME,
    OS_HERMES_CLI: STUB_CLI,
    OS_BACKUP_DIR: TMP_BACKUP_DIR,
    OS_CONFIG_BACKUP_DIR: TMP_BACKUP_DIR,
    OS_META_DIR: TMP_META_DIR,
    OS_WORKSPACE_ROOT: TMP_WORKSPACE_ROOT,
    OS_APPS_DIR: TMP_APPS_DIR,
    OS_MARKET_FILE: MARKET_FILE,
    OS_MARKET_APPS_DIR: MARKET_APPS_DIR,
    OS_SKILL_ROOTS: SKILL_ROOTS,
    OS_WEB_DIST: WEB_DIST,
    OS_CACHE_TTL_MS: "0",
    OS_CRON_TICKER: "0",
    // 显式清掉可能从外部继承的 token，避免回环监听下引入鉴权噪音。
    OS_TOKEN: "",
  };

  const tsxCli = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const child = spawn(process.execPath, [tsxCli, "server/index.ts"], {
    cwd: REPO_ROOT,
    env: childEnv,
    stdio: "inherit",
    shell: false,
  });

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    child.kill(signal);
    // 子进程自行优雅退出；给 5s 兜底强杀，避免 Playwright 卡住。
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    child.on("exit", () => {
      clearTimeout(timer);
      process.exit(0);
    });
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    process.exit(code ?? (signal ? 1 : 0));
  });
}

main();
