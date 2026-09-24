import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 应用根目录（仓库根）解析。
 *
 * 两种运行形态下本模块都被内联/解释为同一个语义：
 *   - 源码（tsx）：本文件位于 `server/paths.ts` → 上一级即仓库根；
 *   - 打包（esbuild → `dist/server.cjs`）：`import.meta.url` 指向 `dist/server.cjs`
 *     （build-server.mjs 注入 shim），上一级同样是应用根。
 *
 * 因此各模块统一用 `APP_ROOT`，不再各自推算相对层级，避免打包后层级错位。
 */
export const APP_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
