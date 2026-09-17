/**
 * Electron 主进程：开窗 → 启动核心 → 建立实时通道 → 把能力暴露给渲染进程。
 *
 * 分工：主进程持有 python 子进程与 WebSocket，渲染进程只通过 IPC 调方法、收事件。
 */
import { BrowserWindow, Menu, app, clipboard, dialog, ipcMain, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { callWithSessionRemap } from './session-remap.mjs'
import { fetchDistManifest, installRuntimeAsset, listInstalledRuntimes } from './runtime-download.mjs'
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

/** 启动阶段进度（渲染层的"启动中"页据此显示步骤） */
function bootProgress(stage, message) {
  send('boot:progress', { stage, message })
}

async function startRuntime() {
  runtime = new Runtime({
    appRoot: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    // 设置页可以手动指定运行时目录（多份运行时并存时切换用）；默认自动解析
    pinnedRoot: readPrefs().runtimeDir || null,
    hermesHome: process.env.HERMES_HOME || path.join(app.getPath('userData'), 'hermes'),
    onLog: (line, stream) => pushLog(line, stream)
  })
  runtime.onExit((info) => {
    lastState = { phase: 'exited', ...info }
    send('runtime:exit', info)
  })

  try {
    bootProgress('spawn', '正在定位运行时并启动核心进程…')
    const port = await runtime.start()
    lastState = { phase: 'ready', port, baseUrl: runtime.baseUrl }
    bootProgress('ready', `核心就绪（端口 ${port}）`)
    await connectGateway()
    bootProgress('gateway', '实时通道已连接')
    send('runtime:ready', { port, baseUrl: runtime.baseUrl })
    bootProgress('data', '正在读取会话与模型…')
    setTimeout(() => bootProgress('done', '就绪'), 800)
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
  return callWithSessionRemap((m, params) => gateway.call(m, params), method, payload ?? {}, {
    // id 变了对渲染层是重要信息：它得把后续调用切到新 id，否则会一直 4001
    onRemap: (from, to) => send('session:remapped', { from, to })
  })
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
// 模型与服务商目录：必须带 include_unconfigured=1 ——
// 默认的 model.options 只返回"已认证/可用"的（全新安装时只有 moa、opencode-free 这种虚拟/内置项），
// 于是设置页会列出 moa（虚拟聚合器），用户一填 key 就报 4002 unknown provider: moa。
// include_unconfigured=1 才给出完整目录（实测 54 个，含 deepseek：auth_type=api_key）。
handle('models:list', () => runtime.request('GET', '/api/model/options?include_unconfigured=1'))
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
handle('session:usage', gwCall('session.usage'))
handle('session:undo', gwCall('session.undo'))
handle('session:branch', gwCall('session.branch'))
handle('session:delete', gwCall('session.delete'))
handle('session:close', gwCall('session.close'))

// 文件面板与会话搜索走 REST（OpenAPI 里的正式接口，实测 0.21.3）
handle('fs:list', (payload) => runtime.request('GET', `/api/fs/list?path=${encodeURIComponent(payload?.path ?? '')}`))
handle('fs:read', (payload) => runtime.request('GET', `/api/files/read?path=${encodeURIComponent(payload?.path ?? '')}`))
handle('sessions:search', (payload) =>
  runtime.request('GET', `/api/sessions/search?q=${encodeURIComponent(payload?.q ?? '')}`)
)

// ── 壳自己的 UI 偏好（主题等）────────────────────────────────────────────
// 刻意不走核心配置：这是"壳长什么样"的偏好，跟 agent 的配置不是一回事（数据分层）。
// 存在 userData/ui-prefs.json，渲染进程读不到磁盘，只通过这两个通道拿。
const prefsFile = () => path.join(app.getPath('userData'), 'ui-prefs.json')
function readPrefs() {
  try {
    return JSON.parse(fs.readFileSync(prefsFile(), 'utf8'))
  } catch {
    return {}
  }
}
handle('ui:prefs:get', () => readPrefs())
handle('ui:prefs:set', (patch) => {
  const next = { ...readPrefs(), ...(patch && typeof patch === 'object' ? patch : {}) }
  try {
    fs.mkdirSync(path.dirname(prefsFile()), { recursive: true })
    fs.writeFileSync(prefsFile(), JSON.stringify(next, null, 2) + '\n', 'utf8')
  } catch (err) {
    throw new Error(`写偏好失败：${err.message}`)
  }
  return next
})

// 技能 / 定时任务 / 用量（一级导航的三个页面）
handle('skills:list', gwCall('skills.manage'))
handle('cron:list', gwCall('cron.manage'))
handle('insights:get', gwCall('insights.get'))
handle('usage:bars', gwCall('usage.bars'))
handle('setup:runtimeCheck', gwCall('setup.runtime_check'))

handle('open:external', (url) => shell.openExternal(String(url)))

// ── 壳信息（诊断页/数据目录页用）──────────────────────────────────────────
handle('ui:info', () => ({
  appVersion: app.getVersion(),
  electronVersion: process.versions.electron,
  chromeVersion: process.versions.chrome,
  platform: `${process.platform}-${process.arch}`,
  packaged: app.isPackaged,
  paths: {
    userData: app.getPath('userData'),
    hermesHome: process.env.HERMES_HOME || path.join(app.getPath('userData'), 'hermes'),
    runtime: runtime?.describe?.() ?? null,
    logs: path.join(app.getPath('userData'), 'logs')
  }
}))
handle('ui:openPath', async (target) => {
  const dir = String(target || '')
  if (!dir) throw new Error('没有可打开的路径')
  const stat = fs.existsSync(dir) ? fs.statSync(dir) : null
  const res = await shell.openPath(stat && stat.isFile() ? path.dirname(dir) : dir)
  if (res) throw new Error(res)
  return { opened: dir }
})
handle('ui:copyText', (text) => {
  clipboard.writeText(String(text ?? ''))
  return { copied: true, length: String(text ?? '').length }
})
handle('ui:saveText', async (payload) => {
  const def = payload?.defaultName || 'export.md'
  const res = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('documents'), def) })
  if (res.canceled || !res.filePath) return { canceled: true }
  fs.writeFileSync(res.filePath, String(payload?.content ?? ''), 'utf8')
  return { canceled: false, path: res.filePath }
})

// 原生右键/更多菜单：渲染层给动作，壳负责弹出（不用在渲染层算坐标、不写内联样式）
handle('ui:contextMenu', (items) => {
  const list = Array.isArray(items) ? items : []
  if (!list.length) return { id: null }
  return new Promise((resolve) => {
    let picked = null
    const menu = Menu.buildFromTemplate(
      list.map((i) => ({
        label: String(i.label ?? ''),
        enabled: i.enabled !== false,
        click: () => {
          picked = String(i.id)
        }
      }))
    )
    menu.popup({
      window: win ?? undefined,
      callback: () => resolve({ id: picked })
    })
  })
})

// 运行时：列出可用目录 + 切换（切换后重启核心）
handle('runtime:list', () => {
  const active = runtime?.pinnedRoot ?? runtime?._resolved?.root ?? null
  const candidates = Runtime.listCandidates({
    appRoot: app.getAppPath(),
    resourcesPath: process.resourcesPath
  })
  // 下载版运行时（userData/runtimes/runtime.<版本>）也列出来，标记为 downloaded
  for (const item of listInstalledRuntimes(runtimesRoot())) {
    candidates.push({ ...item, usable: true })
  }
  return { active, pinned: readPrefs().runtimeDir ?? null, distUrl: readPrefs().runtimeDistUrl ?? '', candidates }
})
/** 下载版运行时的落点（userData/runtimes）—— 安装包目录是只读的，下载的东西只能放用户数据里 */
const runtimesRoot = () => path.join(app.getPath('userData'), 'runtimes')

handle('runtime:dist', (payload) => {
  const prefs = readPrefs()
  if (payload && typeof payload === 'object' && 'url' in payload) {
    const next = { ...prefs, runtimeDistUrl: String(payload.url || '').trim() }
    fs.mkdirSync(path.dirname(prefsFile()), { recursive: true })
    fs.writeFileSync(prefsFile(), JSON.stringify(next, null, 2) + '\n', 'utf8')
    return { url: next.runtimeDistUrl }
  }
  return { url: prefs.runtimeDistUrl ?? '', installed: listInstalledRuntimes(runtimesRoot()) }
})

handle('runtime:checkUpdate', async () => {
  const { url } = { url: readPrefs().runtimeDistUrl ?? '' }
  if (!url) return { configured: false, message: '还没配置分发源地址（填一个 http(s) 前缀，例如 http://your-host/24h-dist）' }
  try {
    const manifest = await fetchDistManifest(url)
    const installed = listInstalledRuntimes(runtimesRoot()).map((r) => r.coreVersion)
    // 当前正在跑的运行时版本（随包那份），用来把话说清楚：是"有新版本"还是"同版本可修复"
    let activeVersion = null
    try {
      const manifestPath = path.join(runtime?._resolved?.root ?? '', '.24h-os-runtime.json')
      activeVersion = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).coreVersion ?? null
    } catch {
      activeVersion = null
    }
    const sizeMb = (Number(manifest.size || 0) / 1024 / 1024).toFixed(0)
    let message
    if (installed.includes(manifest.coreVersion)) {
      message = `已下载过 ${manifest.coreVersion}（可重新下载用于修复）`
    } else if (activeVersion && activeVersion === manifest.coreVersion) {
      message = `分发源版本 ${manifest.coreVersion} 与当前运行的一致（可下载一份独立副本，或用于修复）`
    } else {
      message = `可安装 ${manifest.coreVersion}（${sizeMb} MB）${activeVersion ? `，当前是 ${activeVersion}` : ''}`
    }
    return { configured: true, available: !installed.includes(manifest.coreVersion), manifest, installed, activeVersion, message }
  } catch (err) {
    return { configured: true, error: err.message }
  }
})

handle('runtime:install', async () => {
  const url = readPrefs().runtimeDistUrl ?? ''
  if (!url) throw new Error('还没配置分发源地址')
  const result = await installRuntimeAsset({
    baseUrl: url,
    runtimesRoot: runtimesRoot(),
    onProgress: (p) => send('runtime:download', p)
  })
  return { ...result, candidates: Runtime.listCandidates({ appRoot: app.getAppPath(), resourcesPath: process.resourcesPath, runtimesRoot: runtimesRoot() }) }
})

handle('runtime:activate', async (payload) => {
  const dir = payload?.dir ? String(payload.dir) : null
  const next = { ...readPrefs(), runtimeDir: dir }
  fs.writeFileSync(prefsFile(), JSON.stringify(next, null, 2) + '\n', 'utf8')
  // 换运行时必须重启核心（进程是拿旧 python 起的）
  lastState = { phase: 'restarting' }
  send('runtime:state', lastState)
  gateway?.close()
  gateway = null
  await runtime?.stop()
  await startRuntime()
  return { runtimeDir: dir, state: lastState }
})

// 运行时清单（诊断页显示核心版本/构建时间/layout）
handle('runtime:info', () => {
  const candidates = [
    path.join(process.resourcesPath ?? '', 'runtime', '.24h-os-runtime.json'),
    path.join(app.getAppPath(), 'runtime', '.24h-os-runtime.json')
  ]
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) return { manifest: JSON.parse(fs.readFileSync(file, 'utf8')), path: file }
    } catch (err) {
      return { error: `清单读不动：${err.message}`, path: file }
    }
  }
  return { manifest: null }
})

// 壳自更新：没装 electron-updater 或没配更新源时给出人话，而不是让界面报错
handle('ui:updateCheck', async () => {
  if (!app.isPackaged) return { available: false, message: '开发模式不检查更新' }
  const configFile = path.join(process.resourcesPath ?? '', 'app-update.yml')
  if (!fs.existsSync(configFile)) {
    return { available: false, message: '未配置更新源（发版时在 package.json 的 build.publish 里填上，然后重新打包）' }
  }
  let updater
  try {
    // electron-updater 是 CJS，且 autoUpdater 是个惰性 getter（要 Electron 的 app 才能实例化）
    updater = (await import('electron-updater')).autoUpdater
  } catch (err) {
    return { available: false, message: `更新组件不可用：${err.message}（缺依赖就 npm i electron-updater）` }
  }
  try {
    const res = await updater.checkForUpdates()
    const latest = res?.updateInfo?.version
    const available = Boolean(latest) && latest !== app.getVersion()
    return { available, version: latest, message: available ? `发现新版本 ${latest}` : '已是最新版本' }
  } catch (err) {
    return { available: false, message: `检查更新失败：${err.message}` }
  }
})

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
