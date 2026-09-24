"use strict";

/**
 * 24H-OS Electron 主进程（M2 外壳）。
 *
 * 策略：
 *   1. 探测 http://127.0.0.1:<PORT>/api/health —— 复用已运行的 server；
 *   2. 不可用则 spawn server 子进程（shell:false、参数数组、强制 HOST=127.0.0.1）；
 *   3. 窗口加载 http://127.0.0.1:<PORT>（server 已静态托管 web 构建产物）；
 *   4. 仅当本进程拉起了 server 才在退出时 kill（不误杀用户自己的 dev server）；
 *   5. headless（无显示器）时 BrowserWindow 创建失败 → 清晰日志 + 以 0 退出。
 *
 * 安全默认：contextIsolation=true、nodeIntegration=false、sandbox=true。
 * 打包：存在 `dist/server.cjs`（npm run build:server）时优先用系统 node 启动该
 * 单文件产物；打包态该产物经 electron-builder `asarUnpack` 解包到
 * `resources/app.asar.unpacked/`，本文件用 `app.getAppPath()` 判定并映射路径
 * （系统 node 无法读取 asar 虚拟路径）。否则回退 tsx 源码启动（dev 形态不变）。
 */

// ---------------------------------------------------------------------------
// Headless 自举（必须在 require("electron") 之前）：
// 无 DISPLAY 的 Linux 上，Chromium platform 初始化会在 JS 捕获之前直接 SIGTRAP。
// 检测到 headless 时用 spawnSync 以 --ozone-platform=headless 重入一次
// （shell:false），子进程走正常主流程：起 server → 打印 headless 日志 → exit 0。
// ---------------------------------------------------------------------------
const { spawnSync } = require("node:child_process");

const HEADLESS_LINUX =
  process.platform === "linux" &&
  !process.env.DISPLAY &&
  !process.env.WAYLAND_DISPLAY;

if (HEADLESS_LINUX && !process.env.OS_ELECTRON_HEADLESS_CHILD) {
  const rerun = spawnSync(
    process.execPath,
    ["--ozone-platform=headless", ...process.argv.slice(1)],
    {
      env: { ...process.env, OS_ELECTRON_HEADLESS_CHILD: "1" },
      stdio: "inherit",
      shell: false,
    },
  );
  process.exit(rerun.status ?? (rerun.signal ? 1 : 0));
}

const { app, BrowserWindow } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

/** 项目根（electron/ 的上级）。dev 为仓库根；打包后为 `resources/app.asar`。 */
const PROJECT_ROOT = path.resolve(__dirname, "..");

/**
 * 把可能位于 `app.asar` 内的路径映射到 `app.asar.unpacked`。
 *
 * electron-builder 的 `asarUnpack` 会把匹配文件解包为真实文件；系统 node
 * 无法读取 asar 虚拟路径，因此 spawn 的入口脚本、工作目录与静态资源目录都必须
 * 走解包路径。非打包（dev，无 `app.asar` 段）时原样返回。
 * @param {string} target
 * @returns {string}
 */
function toUnpackedPath(target) {
  const marker = `${path.sep}app.asar`;
  const idx = target.indexOf(marker);
  if (idx === -1) return target;
  const rest = target.slice(idx + marker.length);
  // 必须正好是 app.asar 目录边界（结尾或紧跟分隔符），避免误伤 app.asar.unpacked。
  if (rest !== "" && !rest.startsWith(path.sep)) return target;
  return `${target.slice(0, idx)}${marker}.unpacked${rest}`;
}

/**
 * 运行时根目录：打包态用 `app.getAppPath()` 判定是否在 asar 内并映射到
 * `app.asar.unpacked`；dev 原样返回仓库根（不硬编码 resources/ 层级）。
 * @returns {string}
 */
function resolveRuntimeRoot() {
  let appPath = PROJECT_ROOT;
  try {
    const fromElectron = app.getAppPath();
    if (typeof fromElectron === "string" && fromElectron !== "") {
      appPath = fromElectron;
    }
  } catch {
    // getAppPath 不可用时回退 PROJECT_ROOT。
  }
  return toUnpackedPath(appPath);
}

/** 桌面壳强制回环监听。 */
const HOST = "127.0.0.1";

/** 端口：PORT 环境变量或 4319。 */
function resolvePort() {
  const raw = process.env.PORT;
  if (raw === undefined || raw.trim() === "") return 4319;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 4319;
}

const PORT = resolvePort();
const BASE_URL = `http://${HOST}:${PORT}`;

/** 等待 server 就绪的超时（毫秒）。 */
const SERVER_START_TIMEOUT_MS = 30_000;

/** @type {import("node:child_process").ChildProcess | null} */
let serverChild = null;
/** 仅当由本进程 spawn 时才在退出时 kill。 */
let spawnedByUs = false;
let cleanedUp = false;
/** @type {BrowserWindow | null} */
let mainWindow = null;

/** sleep 工具。 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 探测 /api/health 是否可用。
 * @param {number} port
 * @returns {Promise<boolean>}
 */
function probeHealth(port) {
  return new Promise((resolve) => {
    const req = http.get(
      {
        host: HOST,
        port,
        path: "/api/health",
        timeout: 1000,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

/**
 * 解析真实 Node 可执行文件。
 * Electron 下 process.execPath 是 electron 二进制，不能用来跑 TS 服务；
 * 依次尝试 env.NODE → PATH 上的 node → 退回 "node"（spawn 按 PATH 查找）。
 * @returns {string}
 */
function resolveNodeBin() {
  const fromEnv = process.env.NODE;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const whichCmd = process.platform === "win32" ? "where" : "which";
  const found = spawnSync(whichCmd, ["node"], { encoding: "utf8", shell: false });
  if (found.status === 0) {
    const first = (found.stdout || "").trim().split(/\r?\n/)[0];
    if (first && fs.existsSync(first) && first !== process.execPath) return first;
  }
  return "node";
}

/**
 * 推导 server 启动命令（避免 shell：真实 node + 参数数组）。
 *   1. 打包形态：`dist/server.cjs` 存在 → 系统 node 直接启动单文件产物
 *      （打包态位于 `app.asar.unpacked`，经 `resolveRuntimeRoot` 映射）；
 *   2. dev 形态：从 package.json 的 scripts.start（`tsx server/index.ts`）
 *      → 真实 node + tsx cli + 入口。
 * @returns {{ command: string, args: string[], appRoot: string, webDist: string | null }}
 */
function resolveServerCommand() {
  const appRoot = resolveRuntimeRoot();

  // 打包形态优先：单文件 CJS 产物无需 tsx / node_modules。
  const bundledServer = path.join(appRoot, "dist", "server.cjs");
  if (fs.existsSync(bundledServer)) {
    return {
      command: resolveNodeBin(),
      args: [bundledServer],
      appRoot,
      // 显式指向解包后的静态产物，兜底 server 侧 APP_ROOT 解析。
      webDist: path.join(appRoot, "dist", "web"),
    };
  }

  let startScript = "tsx server/index.ts";
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8"),
    );
    if (pkg && pkg.scripts && typeof pkg.scripts.start === "string") {
      startScript = pkg.scripts.start;
    }
  } catch {
    // 读不到 package.json 时用默认 start 脚本。
  }

  const tsxCli = path.join(PROJECT_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const match = /^tsx\s+(\S+\.ts)\s*$/.exec(startScript);
  if (match && fs.existsSync(tsxCli)) {
    // 不经 shell：node + tsx cli + 入口脚本（参数数组）。
    return {
      command: resolveNodeBin(),
      args: [tsxCli, path.join(PROJECT_ROOT, match[1])],
      appRoot: PROJECT_ROOT,
      webDist: null,
    };
  }

  // 回退：npm run start（POSIX 下 npm 为 node 脚本，shell:false 可直接 spawn）。
  return { command: "npm", args: ["run", "start"], appRoot: PROJECT_ROOT, webDist: null };
}

/**
 * spawn server 子进程（shell:false、强制回环 HOST）。
 * @returns {import("node:child_process").ChildProcess}
 */
function spawnServer() {
  const { command, args, appRoot, webDist } = resolveServerCommand();
  /** @type {NodeJS.ProcessEnv} */
  const env = {
    ...process.env,
    HOST,
    PORT: String(PORT),
  };
  // 打包（unpacked）时显式指定静态产物根；仅在未显式覆盖且产物存在时设置
  // （OS_WEB_DIST 无效会返回 null 且不回退，故先校验 index.html）。
  if (webDist && !env.OS_WEB_DIST && fs.existsSync(path.join(webDist, "index.html"))) {
    env.OS_WEB_DIST = webDist;
  }
  const child = spawn(command, args, {
    cwd: appRoot,
    shell: false,
    stdio: "inherit",
    env,
  });
  child.on("error", (error) => {
    // eslint-disable-next-line no-console
    console.error(`[24H-OS Electron] server 子进程启动失败：${error.message}`);
  });
  return child;
}

/**
 * 轮询等待 health 就绪；若子进程先退出则再探一次
 * （可能与并发启动的 dev server 端口竞争，对方已占用即可复用）。
 * @param {import("node:child_process").ChildProcess | null} child
 * @returns {Promise<boolean>}
 */
async function waitForHealth(child) {
  const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await probeHealth(PORT)) return true;
    if (child && child.exitCode !== null) {
      await sleep(200);
      return probeHealth(PORT);
    }
    await sleep(400);
  }
  return false;
}

/**
 * 确保 server 可用：复用已运行实例，否则 spawn 并等待就绪。
 * @returns {Promise<void>}
 */
async function ensureServer() {
  if (await probeHealth(PORT)) {
    // eslint-disable-next-line no-console
    console.log(`[24H-OS Electron] 复用已运行的 server：${BASE_URL}`);
    return;
  }
  // 短暂等待可能正在并发启动的 server（如 dev:desktop 的 concurrently）。
  for (let i = 0; i < 5; i += 1) {
    await sleep(300);
    if (await probeHealth(PORT)) {
      // eslint-disable-next-line no-console
      console.log(`[24H-OS Electron] 复用已运行的 server：${BASE_URL}`);
      return;
    }
  }

  // eslint-disable-next-line no-console
  console.log(`[24H-OS Electron] 未检测到 server，正在拉起：${BASE_URL}`);
  serverChild = spawnServer();
  spawnedByUs = true;

  const ok = await waitForHealth(serverChild);
  if (!ok) {
    if (serverChild && serverChild.exitCode !== null) {
      // 子进程已退出且 health 不可用（非端口竞争）。
      spawnedByUs = false;
      throw new Error("server 子进程启动后立即退出（检查端口占用或日志）。");
    }
    throw new Error(`等待 server 就绪超时（${SERVER_START_TIMEOUT_MS}ms）。`);
  }
  if (serverChild && serverChild.exitCode !== null) {
    // 子进程退出但 health 可用 → 端口被并发实例占用，对方在服务，勿 kill。
    spawnedByUs = false;
    serverChild = null;
  }
  // eslint-disable-next-line no-console
  console.log(`[24H-OS Electron] server 已就绪：${BASE_URL}`);
}

/** 是否 headless Linux（无任何显示 server）。 */
function isHeadlessLinux() {
  return (
    process.platform === "linux" &&
    !process.env.DISPLAY &&
    !process.env.WAYLAND_DISPLAY
  );
}

/** 清理：仅 kill 本进程拉起的 server；幂等。 */
function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  if (spawnedByUs && serverChild && serverChild.exitCode === null) {
    try {
      serverChild.kill("SIGTERM");
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`[24H-OS Electron] 停止 server 子进程失败：${error.message}`);
    }
    // 短暂等待优雅退出，仍在则 SIGKILL。
    const child = serverChild;
    const killTimer = setTimeout(() => {
      if (child.exitCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
    }, 2000);
    if (typeof killTimer.unref === "function") killTimer.unref();
  }
  serverChild = null;
  spawnedByUs = false;
}

/**
 * headless/失败路径：打印清晰日志并以 0 退出（先清理自启 server）。
 * @param {unknown} [cause]
 */
function exitHeadless(cause) {
  if (cause) {
    // eslint-disable-next-line no-console
    console.error(
      `[24H-OS Electron] 创建窗口失败：${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  // eslint-disable-next-line no-console
  console.log(
    `[24H-OS Electron] headless 环境无法创建窗口，server 已就绪：${BASE_URL}`,
  );
  cleanup();
  app.exit(0);
}

// 降低无 GPU/显示器环境的初始化失败概率。
app.disableHardwareAcceleration();

app
  .whenReady()
  .then(async () => {
    try {
      await ensureServer();
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(
        `[24H-OS Electron] server 未能就绪：${error instanceof Error ? error.message : String(error)}`,
      );
      cleanup();
      app.exit(1);
      return;
    }

    try {
      if (isHeadlessLinux()) {
        // 明确的 headless 路径：不尝试创建窗口（避免 X11 缺失导致原生崩溃）。
        exitHeadless(new Error("未检测到 DISPLAY/WAYLAND_DISPLAY"));
        return;
      }

      mainWindow = new BrowserWindow({
        width: 1280,
        height: 860,
        show: false,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          preload: path.join(__dirname, "preload.cjs"),
        },
      });

      mainWindow.once("ready-to-show", () => {
        if (mainWindow) mainWindow.show();
      });

      await mainWindow.loadURL(BASE_URL);
      mainWindow.on("closed", () => {
        mainWindow = null;
      });
    } catch (error) {
      exitHeadless(error);
    }
  })
  .catch((error) => {
    // app.whenReady 本身失败：能启动 server 则按 headless 语义 0 退出。
    // eslint-disable-next-line no-console
    console.error(
      `[24H-OS Electron] whenReady 失败：${error instanceof Error ? error.message : String(error)}`,
    );
    exitHeadless(error);
  });

app.on("window-all-closed", () => {
  // 桌面壳单窗口：关窗即退出（含 macOS，保持与清理逻辑一致）。
  cleanup();
  app.quit();
});

app.on("before-quit", () => {
  cleanup();
});

/** SIGINT/SIGTERM：清理自启 server 后退出。 */
function handleSignal(signal) {
  // eslint-disable-next-line no-console
  console.log(`[24H-OS Electron] 收到 ${signal}，正在清理…`);
  cleanup();
  app.exit(0);
}
process.on("SIGINT", () => handleSignal("SIGINT"));
process.on("SIGTERM", () => handleSignal("SIGTERM"));
