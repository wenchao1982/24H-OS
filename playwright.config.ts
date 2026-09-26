import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";
import { BASE_URL, REPO_ROOT } from "./e2e/env";

/**
 * Playwright headless e2e 配置（无显示器环境用真实 Chromium 跑关键链路）。
 *
 * 隔离要点：
 *   - `webServer` 走 `npm run e2e:server`（`e2e/start-server.ts`）——
 *     它自建临时 HOME/HERMES_HOME + 假 CLI，真实 `~/.hermes` 全程不被触碰；
 *   - 只监听 127.0.0.1:4599；
 *   - 前端在本套 e2e 构建时注入 `VITE_API_BASE_URL=http://127.0.0.1:4599`
 *     （见 package.json#build:web:e2e），与静态托管同源；
 *   - SSE 在**浏览器层** mock（`e2e/sse-mock.ts` 的 addInitScript），
 *     不连任何真实模型；其余 `/api/*` 打真实后端。
 *
 * 浏览器解析：优先使用当前 Playwright 版本的托管 Chromium；若未安装
 * （离线 NAS，只能复用旧 revision 1228），回退到 `~/.cache/ms-playwright`
 * 下任意 chromium / 系统 chromium，并把绝对路径交给 `use.executablePath`
 * （跨 revision 已验证可启动）。可用 `OS_E2E_CHROMIUM` 显式覆盖。
 */

const require = createRequire(import.meta.url);

function cwdChromium(): string | undefined {
  const override = process.env.OS_E2E_CHROMIUM?.trim();
  if (override && existsSync(override)) return override;

  const cacheRoot = path.join(os.homedir(), ".cache", "ms-playwright");
  const candidates: string[] = [];

  // 当前 Playwright 版本的托管 revision（CI 正常安装时命中）→ 走默认解析。
  try {
    const pwDir = path.dirname(require.resolve("playwright-core/package.json"));
    const parsed = JSON.parse(readFileSync(path.join(pwDir, "browsers.json"), "utf8")) as {
      browsers?: Array<{ name: string; revision: string }>;
    };
    const list = parsed.browsers ?? [];
    for (const name of ["chromium", "chromium-headless-shell"]) {
      const rev = list.find((item) => item.name === name)?.revision;
      if (!rev) continue;
      const dir =
        name === "chromium"
          ? path.join(cacheRoot, `chromium-${rev}`, "chrome-linux64", "chrome")
          : path.join(
              cacheRoot,
              `chromium_headless_shell-${rev}`,
              "chrome-headless-shell-linux64",
              "chrome-headless-shell",
            );
      if (existsSync(dir)) return undefined; // 托管版本可用 → 不覆盖。
      candidates.push(dir);
    }
  } catch {
    // 读不到 browsers.json：忽略，继续回退。
  }

  // 回退：缓存里任意 revision（离线复用的兜底）。
  try {
    for (const entry of readdirSync(cacheRoot)) {
      if (entry.startsWith("chromium_headless_shell-")) {
        candidates.push(
          path.join(cacheRoot, entry, "chrome-headless-shell-linux64", "chrome-headless-shell"),
        );
      } else if (entry.startsWith("chromium-")) {
        candidates.push(path.join(cacheRoot, entry, "chrome-linux64", "chrome"));
      }
    }
  } catch {
    // 无缓存目录：忽略。
  }

  return candidates.find(existsSync);
}

const executablePath = cwdChromium();

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  outputDir: "e2e/.artifacts",
  use: {
    baseURL: BASE_URL,
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  webServer: {
    command: "npm run e2e:server",
    cwd: REPO_ROOT,
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
