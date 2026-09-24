import { fileURLToPath } from "node:url";
import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Vitest 配置（独立于 vite.config.ts，避免其 root=web/ 影响测试发现）。
 * 测试文件放在 server 下，纯 Node 环境；@shared 别名与运行时保持一致。
 */
const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@shared": path.resolve(rootDir, "shared"),
    },
  },
  test: {
    environment: "node",
    include: ["server/**/*.test.ts", "tests/**/*.test.ts"],
  },
});
