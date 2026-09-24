#!/usr/bin/env node
/**
 * 构建 server 独立启动产物：dist/server.cjs（M2 打包）。
 *
 * 用 esbuild 把 `server/index.ts` 打成单文件 CJS：
 *   - platform=node / format=cjs / target=node20 / bundle=true（全量内联）；
 *   - `@shared/*` → 仓库 `shared/`（与 tsconfig / vite 别名一致）；
 *   - 注入 `import.meta.url` shim：CJS 下 esbuild 会置空该值，这里用产物自身
 *     路径（`__filename`）还原，使 `server/paths.ts` 的 APP_ROOT 在打包形态下
 *     仍指向应用根（与源码形态一致）。
 *
 * 若全量内联失败（某依赖不兼容打包），回退 `packages:"external"`（运行时需
 * 保留 node_modules），并在日志中注明回退原因。两套路径都保证产物为 CJS。
 */
import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const ENTRY = path.join(ROOT, "server", "index.ts");
const OUTFILE = path.join(ROOT, "dist", "server.cjs");

/**
 * CJS 输出下 esbuild 会把 `import.meta.url` 置空，故用 define 指向 banner 中
 * 由 `__filename` 推导的真实 file URL（即 dist/server.cjs 自身）。
 */
const DEFINE = { "import.meta.url": "__24osImportMetaUrl" };
const BANNER = {
  js: 'const __24osImportMetaUrl = require("url").pathToFileURL(__filename).href;',
};

/** esbuild 基础配置（全量内联与 external 回退共用）。 */
const BASE_OPTIONS = {
  entryPoints: [ENTRY],
  outfile: OUTFILE,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: false,
  legalComments: "none",
  alias: { "@shared": path.join(ROOT, "shared") },
  define: DEFINE,
  banner: BANNER,
  logLevel: "warning",
  metafile: true,
};

/** 打印产物体积（相对仓库根）。 */
function reportOutputs(result) {
  const outputs = result.metafile?.outputs ?? {};
  for (const [file, info] of Object.entries(outputs)) {
    const kib = (info.bytes / 1024).toFixed(1);
    console.log(`[build:server]   ${path.relative(ROOT, file)}  ${kib} KiB`);
  }
}

async function main() {
  let result;
  let mode = "全量内联";
  try {
    result = await esbuild.build({ ...BASE_OPTIONS });
  } catch (error) {
    console.warn(
      `[build:server] 全量内联失败：${error instanceof Error ? error.message : String(error)}`,
    );
    console.warn(
      '[build:server] 回退 packages:"external"（运行时需保留 node_modules，已注明）。',
    );
    mode = "external 回退";
    result = await esbuild.build({ ...BASE_OPTIONS, packages: "external" });
  }

  if (!statSync(OUTFILE).isFile()) {
    throw new Error(`构建产物缺失：${OUTFILE}`);
  }
  reportOutputs(result);
  console.log(
    `[build:server] 完成（${mode}）→ ${path.relative(ROOT, OUTFILE)}`,
  );
}

main().catch((error) => {
  console.error(
    `[build:server] 失败：${error instanceof Error ? error.stack ?? error.message : String(error)}`,
  );
  process.exit(1);
});
