/**
 * 应用生命周期：窗口创建、关窗拦截、退出流程。
 *
 * 与 main.js 的分工：
 *   - lifecycle.js 管窗口和退出
 *   - main.js 管核心启动和 IPC 注册
 */
import { BrowserWindow, app } from 'electron'
import path from 'node:path'
import { CloseGuard } from './close-guard.mjs'

/**
 * 创建主窗口。
 * @param {{ onLog: (m: string) => void, onDidFinishLoad: () => void }} ctx
 * @returns {{ win: BrowserWindow, closeGuard: CloseGuard, answerCloseRequest: (payload: any) => any }}
 */
export function createMainWindow({ onLog, onDidFinishLoad } = {}) {
  let win = null
  let pendingCloseAsk = null

  const closeGuard = new CloseGuard({
    log: (m) => onLog?.(`[壳] ${m}`),
    ask: () =>
      new Promise((resolve) => {
        if (!win || win.isDestroyed()) {
          resolve({ action: 'keep', reason: 'no-window' })
          return
        }
        const requestId = `close-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
        pendingCloseAsk = { requestId, resolve }
        win.webContents.send('app:close-request', { requestId })
      })
  })

  function answerCloseRequest(payload = {}) {
    const ask = pendingCloseAsk
    if (!ask) return { accepted: false, reason: 'no-pending-request' }
    if (payload.requestId && payload.requestId !== ask.requestId) {
      return { accepted: false, reason: 'stale-request' }
    }
    pendingCloseAsk = null
    ask.resolve({ action: payload?.action, sessionId: payload?.sessionId ?? null })
    return { accepted: true, action: payload?.action ?? null }
  }

  function createWindow() {
    win = new BrowserWindow({
      width: 1180,
      height: 780,
      minWidth: 900,
      minHeight: 600,
      title: '24H',
      backgroundColor: '#0b0f14',
      webPreferences: {
        preload: path.join(import.meta.dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })
    win.loadFile(path.join(import.meta.dirname, '..', 'src', 'index.html'))
    win.webContents.on('did-finish-load', () => onDidFinishLoad?.())
    win.on('close', async (event) => {
      if (closeGuard.approved) return
      event.preventDefault()
      const decision = await closeGuard.confirmClose()
      if (!decision.allow) return
      if (decision.action === 'clear') {
        // 草稿清理由 main.js 的 prefsStore 处理
      }
      closeGuard.approve()
      if (win && !win.isDestroyed()) win.close()
    })
    win.on('closed', () => { win = null })
    return win
  }

  createWindow()

  return {
    get win() { return win },
    closeGuard,
    answerCloseRequest,
    createWindow
  }
}

/**
 * 配置退出流程。
 * @param {{ closeGuard: CloseGuard, sessionMux: any, supervisor: any, prefs: any, onQuit: () => void }} ctx
 */
export function setupQuitHandler({ closeGuard, sessionMux, supervisor, prefs, onQuit }) {
  let quitting = false

  app.on('before-quit', async (event) => {
    if (quitting) return
    event.preventDefault()
    quitting = true
    closeGuard.approve()
    try {
      await sessionMux.drain()
    } catch {
      /* 忽略：退出优先 */
    }
    await supervisor.stop()
    prefs().dispose()
    onQuit?.()
    app.quit()
  })

  app.on('window-all-closed', () => app.quit())
}
