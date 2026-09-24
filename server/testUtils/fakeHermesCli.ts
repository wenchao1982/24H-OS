import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 测试用「假 hermes CLI」。
 *
 * 生成一个可执行脚本（`.cjs`，带 `#!/usr/bin/env node` shebang）：
 *   - 把收到的参数以 JSON Lines 追加写入同目录的 `calls.log`；
 *   - `profile export <id> -o <path>` 会真的创建备份文件（模拟导出）；
 *   - 若环境变量 FAKE_HERMES_FAIL=1，则以非 0 退出，用于测试失败分支。
 *
 * 把它作为 cliPath 注入 runHermes / lifecycle 即可，无需真实 hermes。
 */

const SCRIPT = `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const log = path.join(__dirname, "calls.log");
fs.appendFileSync(log, JSON.stringify(args) + "\\n");
if (process.env.FAKE_HERMES_FAIL === "1") {
  process.stderr.write("fake hermes failure\\n");
  process.exit(3);
}
if (args[0] === "profile" && args[1] === "export") {
  const i = args.indexOf("-o");
  if (i >= 0 && args[i + 1]) {
    fs.mkdirSync(path.dirname(args[i + 1]), { recursive: true });
    fs.writeFileSync(args[i + 1], "tar.gz-placeholder");
  }
  process.stdout.write("exported " + (args[2] || "") + "\\n");
  process.exit(0);
}
process.stdout.write("ok " + args.join(" ") + "\\n");
process.exit(0);
`;

export interface FakeHermesCli {
  dir: string;
  cliPath: string;
  logPath: string;
  /** 已记录的所有调用（参数数组）。 */
  calls(): string[][];
}

/** 创建假 CLI（调用方负责在 afterEach 清理 dir）。 */
export function makeFakeHermesCli(): FakeHermesCli {
  const dir = mkdtempSync(path.join(os.tmpdir(), "24os-fake-hermes-"));
  const cliPath = path.join(dir, "hermes.cjs");
  const logPath = path.join(dir, "calls.log");
  writeFileSync(cliPath, SCRIPT, "utf8");
  chmodSync(cliPath, 0o755);

  return {
    dir,
    cliPath,
    logPath,
    calls() {
      if (!existsSync(logPath)) return [];
      return readFileSync(logPath, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as string[]);
    },
  };
}
