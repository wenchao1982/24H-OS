/**
 * Electron 主进程：开窗 → 启动核心 → 把状态推给渲染进程。
 * 关窗/退出时优雅关闭核心进程（不留孤儿进程）。
 */
import { BrowserWindow, app, ipcMain, shell } from 'electron'
import path from 'node:path'
import { Runtime } from './runtime.js'

/** @type {BrowserWindow | null} */
let win = null
/** @type {Runtime | null} */
let runtime = null
/** 最近的核心日志（渲染进程晚订阅也能拿到） */
const logBuffer = []
let lastState = { phase: 'starting' }

function send(channel, payload) {
  win?.webContents.send(channel, payload)
}

function pushLog(line, stream) {
  const entry = { line, stream, at: Date.now() }
  logBuffer.push(entry)
  if (logBuffer.length > 500) logBuffer.shift()
  send('runtime:log', entry)
}

function createWindow() {
  win = new BrowserWindow({
    width: 980,
    height: 680,
    title: '24H',
    backgroundColor: '#0b0f14',
    webPreferences: {
      preload: path.join(import.meta.dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  win.loadFile(path.join(import.meta.dirname, '..', 'src', 'index.html'))
  win.on('closed', () => {
    win = null
  })
}

async function startRuntime() {
  runtime = new Runtime({
    appRoot: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    // 用户数据放 userData 下，别污染 $HOME；HERMES_HOME 可覆盖（便于复用已装好的核心）
    hermesHome: process.env.HERMES_HOME || path.join(app.getPath('userData'), 'hermes'),
    onLog: pushLog
  })
  runtime.onExit((info) => {
    lastState = { phase: 'exited', ...info }
    send('runtime:exit', info)
  })

  try {
    const port = await runtime.start()
    lastState = { phase: 'ready', port, baseUrl: runtime.baseUrl }
    send('runtime:ready', { port, baseUrl: runtime.baseUrl })
  } catch (err) {
    lastState = { phase: 'failed', message: err.message }
    send('runtime:error', { message: err.message })
  }
}

ipcMain.handle('runtime:state', () => ({ ...lastState, logs: logBuffer.slice(-200) }))

ipcMain.handle('runtime:info', async () => {
  if (!runtime?.baseUrl) return null
  try {
    return { health: await runtime.health(), status: (await runtime.api('/api/status')).body }
  } catch (err) {
    return { error: err.message }
  }
})

ipcMain.handle('runtime:restart', async () => {
  lastState = { phase: 'restarting' }
  send('runtime:state', lastState)
  await runtime?.stop()
  await startRuntime()
  return lastState
})

ipcMain.handle('open:external', (_event, url) => shell.openExternal(String(url)))

app.whenReady().then(async () => {
  createWindow()
  await startRuntime()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

let quitting = false
app.on('before-quit', async (event) => {
  if (quitting) return
  event.preventDefault()
  quitting = true
  await runtime?.stop()
  app.quit()
})

app.on('window-all-closed', () => {
  app.quit()
})
