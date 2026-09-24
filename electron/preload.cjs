"use strict";

/**
 * Electron preload（sandbox + contextIsolation 下运行）。
 * 仅暴露最小只读信息，不暴露任何 Node / IPC 能力。
 */

const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("desktop", {
  /** 平台标识（如 linux / darwin / win32）。 */
  platform: process.platform,
});
