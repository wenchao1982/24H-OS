import { fileURLToPath } from "node:url";
import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// vite 的 root 指向 web/，别名 @shared 解析到项目根下的 shared/。
const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.resolve(rootDir, "web"),
  plugins: [react()],
  resolve: {
    alias: {
      "@shared": path.resolve(rootDir, "shared"),
    },
  },
  server: {
    port: 5173,
    strictPort: false,
    // 开发时把 /api 透传给本地 Fastify（含 WebSocket 升级，M7 Dashboard WS）。
    proxy: {
      "/api": {
        target: "http://localhost:4319",
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    outDir: path.resolve(rootDir, "dist/web"),
    emptyOutDir: true,
    sourcemap: true,
  },
});
