/**
 * Electron 主进程：开窗 → 启动核心 → 建立实时通道 → 把能力暴露给渲染进程。
 *
 * 分工：主进程持有 python 子进程与 WebSocket，渲染进程只通过 IPC 调方法、收事件。
 */
import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron'
import path from 'node:path'
import { Gateway } from './gateway.js'
import { Runtime } from './runtime.js'

/** @type {BrowserWindow | null} */
let win = null
/** @type {Runtime | null} */
let runtime = null
/** @type {Gateway | null} */
let gateway = null
const logBuffer = []
let lastState = { phase: 'starting' }
let token = null

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

function pushLog(line, stream = 'stdout') {
  const entry = { line, stream, at: Date.now() }
  logBuffer.push(entry)
  if (logBuffer.length > 800) logBuffer.shift()
  send('runtime:log', entry)
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
  win.on('closed', () => {
    win = null
  })
}

/** 核心就绪后：取会话 token → 建立 WS 通道。 */
async function connectGateway() {
  token = await runtime.sessionToken()
  gateway = new Gateway({
    baseUrl: runtime.baseUrl,
    token,
    log: (m) => pushLog(`[gateway] ${m}`, 'gateway')
  })
  gateway.on('event', (evt) => send('gateway:event', evt))
  gateway.on('close', () => send('gateway:status', { connected: false }))
  gateway.on('open', () => send('gateway:status', { connected: true }))
  await gateway.connect()
  send('gateway:status', { connected: true, authRequired: Boolean(token) })
}

async function startRuntime() {
  runtime = new Runtime({
    appRoot: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    hermesHome: process.env.HERMES_HOME || path.join(app.getPath('userData'), 'hermes'),
    onLog: (line, stream) => pushLog(line, stream)
  })
  runtime.onExit((info) => {
    lastState = { phase: 'exited', ...info }
    send('runtime:exit', info)
  })

  try {
    const port = await runtime.start()
    lastState = { phase: 'ready', port, baseUrl: runtime.baseUrl }
    send('runtime:ready', { port, baseUrl: runtime.baseUrl })
    await connectGateway()
  } catch (err) {
    lastState = { phase: 'failed', message: err.message }
    send('runtime:error', { message: err.message })
  }
}

/** 统一包装：IPC 调用里的异常变成 {error} 而不是抛穿进程边界。 */
function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, payload) => {
    try {
      return { ok: true, data: await fn(payload) }
    } catch (err) {
      return { ok: false, error: err.message || String(err) }
    }
  })
}

/** 需要 gateway 就绪的调用。会话类调用若撞上 4001（运行时已不持有该会话），
 *  自动用同一个 id 走 session.resume 后重试一次 —— 这是核心要求客户端做的恢复动作。 */
const gwCall = (method) => async (payload = {}) => {
  if (!gateway) throw new Error('核心尚未就绪')
  try {
    return await gateway.call(method, payload ?? {})
  } catch (err) {
    const sid = payload?.session_id
    if (err.code === 4001 && sid && method !== 'session.resume') {
      await gateway.call('session.resume', { session_id: sid, cols: 100 })
      return gateway.call(method, payload)
    }
    throw err
  }
}

handle('runtime:state', () => ({ ...lastState, logs: logBuffer.slice(-300) }))
handle('runtime:restart', async () => {
  lastState = { phase: 'restarting' }
  send('runtime:state', lastState)
  gateway?.close()
  gateway = null
  await runtime?.stop()
  await startRuntime()
  return lastState
})
handle('runtime:health', () => runtime.health())
handle('runtime:status', () => runtime.api('/api/status'))

// 会话 / 对话 / 模型 / 配置 —— 全部走 WS JSON-RPC
handle('sessions:list', gwCall('session.list'))
handle('sessions:create', gwCall('session.create'))
handle('session:activate', gwCall('session.activate'))
handle('session:resume', gwCall('session.resume'))
handle('session:history', gwCall('session.history'))
handle('session:interrupt', gwCall('session.interrupt'))
handle('session:cwdSet', gwCall('session.cwd.set'))
handle('session:status', gwCall('session.status'))
handle('session:title', gwCall('session.title'))
handle('chat:send', gwCall('prompt.submit'))
handle('models:list', gwCall('model.options'))
// 注意：WS 没有 model.set —— 设置默认模型是 REST POST /api/model/set（体：scope/provider/model）
handle('model:set', (payload) => runtime.request('POST', '/api/model/set', payload ?? {}))
// 保存 API Key 是 WS model.save_key，参数名是 slug（不是 provider）
handle('model:saveKey', gwCall('model.save_key'))
// 自定义 OpenAI 兼容端点（国产服务商常用）
handle('providers:customEndpoints', () => runtime.request('GET', '/api/providers/custom-endpoints'))
handle('providers:customEndpointUpsert', (payload) =>
  runtime.request('POST', '/api/providers/custom-endpoints', payload ?? {})
)
// 配置走 REST（实测 WS 的 config.get 在空配置下返回 {}；/api/config 是 OpenAPI 里的正式接口）
handle('config:get', () => runtime.request('GET', '/api/config'))
handle('config:set', (payload) => runtime.request('PUT', '/api/config', payload?.config ?? payload))
handle('gateway:capabilities', gwCall('gateway.capabilities'))
handle('session:delete', gwCall('session.delete'))
handle('session:close', gwCall('session.close'))

// 文件面板与会话搜索走 REST（OpenAPI 里的正式接口，实测 0.21.3）
handle('fs:list', (payload) => runtime.request('GET', `/api/fs/list?path=${encodeURIComponent(payload?.path ?? '')}`))
handle('fs:read', (payload) => runtime.request('GET', `/api/files/read?path=${encodeURIComponent(payload?.path ?? '')}`))
handle('sessions:search', (payload) =>
  runtime.request('GET', `/api/sessions/search?q=${encodeURIComponent(payload?.q ?? '')}`)
)

handle('open:external', (url) => shell.openExternal(String(url)))

// 原生目录选择（会话的工作目录）
handle('dialog:pickDir', async () => {
  const res = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
  return res.canceled ? null : res.filePaths[0]
})

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
  gateway?.close()
  await runtime?.stop()
  app.quit()
})

app.on('window-all-closed', () => app.quit())
