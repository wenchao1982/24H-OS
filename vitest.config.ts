import { fileURLToPath } from "node:url";
import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Vitest 配置（独立于 vite.config.ts，避免其 root=web/ 影响测试发现）。
 *
 * 环境隔离策略：**单配置 + 每文件 docblock**。
 * - 默认 `environment: "node"`，既有 `server/**` 用例不受影响；
 * - `web/**` 下的测试文件在顶部写 `/** @vitest-environment jsdom *\/` 显式切到 jsdom，
 *   各自 `import "@testing-library/jest-dom/vitest"`，避免全局 setup 污染 node 用例。
 * 选择它而不是 `test.projects`/workspace 的理由：只需一个配置、无额外 workspace 文件，
 * 且 jsdom 只对显式声明的前端文件生效，语义直观、迁移成本最低（未使用已废弃的
 * `environmentMatchGlobs`）。
 *
 * `esbuild.jsx: "automatic"` 让 `.tsx` 测试在 vitest 内正确走 React 自动 runtime。
 */
const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@shared": path.resolve(rootDir, "shared"),
    },
  },
  esbuild: {
    jsx: "automatic",
  },
  test: {
    environment: "node",
    include: [
      "server/**/*.test.ts",
      "tests/**/*.test.ts",
      "shared/**/*.test.ts",
      "web/**/*.test.{ts,tsx}",
    ],
  },
});
