import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * e2e 隔离环境常量（供 playwright.config.ts、start-server.ts 与测试共用）。
 *
 * **绝不触碰真实 `~/.hermes` / `~/hermes-desktop` / `~/.24os`**：
 *   - `HOME` → `TMP_HOME`（临时目录，影响 os.homedir() 的所有回退）；
 *   - `HERMES_HOME` → `TMP_HERMES_HOME`（预置 `profiles/main/config.yaml`）；
 *   - `OS_HERMES_CLI` → `STUB_CLI`（只回显固定文本、记录参数，绝不调模型）；
 *   - 备份 / 元数据 / 工作区 / App 安装记录全部指向临时目录。
 *
 * 本模块只**计算路径**，不创建/清理目录——真正的建目录与清理在
 * `start-server.ts`（webServer 启动时执行一次），避免测试进程 import 时误清。
 */

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 固定端口（与 API_BASE 构建时注入保持一致）。 */
export const E2E_PORT = 4599;
export const BASE_URL = `http://127.0.0.1:${E2E_PORT}`;

/** 临时根（NAS/CI 的 /tmp 下；固定名便于再次运行覆盖）。 */
export const E2E_TMP_ROOT = path.join(os.tmpdir(), `24os-e2e-${E2E_PORT}`);

export const TMP_HOME = path.join(E2E_TMP_ROOT, "home");
export const TMP_HERMES_HOME = path.join(E2E_TMP_ROOT, "hermes");
export const TMP_BACKUP_DIR = path.join(E2E_TMP_ROOT, "backups");
export const TMP_META_DIR = path.join(E2E_TMP_ROOT, "agents");
export const TMP_WORKSPACE_ROOT = path.join(E2E_TMP_ROOT, "workspace");
export const TMP_APPS_DIR = path.join(E2E_TMP_ROOT, "apps");

/** 假 hermes CLI（可执行 CJS 脚本）与其调用日志。 */
export const STUB_CLI = path.join(E2E_TMP_ROOT, "hermes-stub.cjs");
export const STUB_LOG = path.join(E2E_TMP_ROOT, "stub-calls.log");

/** 仓库内真实市场 / 示例 skill 根（e2e 只读，不写入）。 */
export const MARKET_FILE = path.join(REPO_ROOT, "market", "index.json");
export const MARKET_APPS_DIR = path.join(REPO_ROOT, "market", "apps");
export const SKILL_ROOTS = path.join(REPO_ROOT, "examples", "skills");
export const WEB_DIST = path.join(REPO_ROOT, "dist", "web");

/** 预置的禁用 skill（供「禁用 skill」用例断言 UI）。 */
export const DISABLED_SKILL = "ppt";
