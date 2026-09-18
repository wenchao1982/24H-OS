/**
 * Electron 主进程：开窗 → 启动核心 → 建立实时通道 → 把能力暴露给渲染进程。
 *
 * 分工：主进程持有 python 子进程与 WebSocket，渲染进程只通过 IPC 调方法、收事件。
 *
 * 模块化（Sprint-01 后半段）：
 *   - lifecycle.mjs：窗口创建 + 关窗拦截 + 退出流程
 *   - ipc-handlers.mjs：所有 IPC 通道注册
 *   - orphan-watchdog.mjs：周期性孤儿核心清理
 *   - provider-config.mjs：可配置的服务商白名单
 */
import { BrowserWindow, Menu, Notification, app, clipboard, dialog, ipcMain, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { callWithSessionRemap } from './session-remap.mjs'
import { fetchDistManifest, installRuntimeAsset, listInstalledRuntimes } from './runtime-download.mjs'
import { sweepOrphanCores } from './orphan-sweep.mjs'
import { CloseGuard } from './close-guard.mjs'
import { CoreSupervisor } from './core-supervisor.mjs'
import { EventQueue, NOTIFY_WINDOW_MS, NotificationAggregator } from './event-pipeline.mjs'
import { Gateway } from './gateway.js'
import { PrefsStore } from './prefs-store.mjs'
import { Runtime } from './runtime.js'
import { KeyedSerializer, SWITCH_MUX_KEY } from './session-mutex.mjs'
import {
  assertWizardCompleteAllowed,
  decideFlowGate,
  runConnectionTestWithPrefs,
  sanitizePrefsPatch,
  selfCheck
} from './wizard.mjs'
import { createOrphanWatchdog } from './orphan-watchdog.mjs'
import { loadProviderConfig, providerMatchesAllowlist, filterKeyProviders } from './provider-config.mjs'

/** @type {BrowserWindow | null} */
let win = null
/** @type {Runtime | null} */
let runtime = null
/** @type {Gateway | null} */
let gateway = null
const logBuffer = []
let lastState = { phase: 'starting' }
let token = null

/** 会话互斥：同一会话上的切换/关闭/发送串行，跨会话互不阻塞（Sprint-01 T5）。 */
const sessionMux = new KeyedSerializer({ log: (m) => pushLog(m, 'shell') })
/** 事件背压：队列满了优先丢 token 增量，状态/错误类事件不丢（Sprint-01 T4）。 */
const eventQueue = new EventQueue()
/** 通知按 type+sessionId 5 秒聚合（Sprint-01 T4）。 */
const notifications = new NotificationAggregator({ windowMs: NOTIFY_WINDOW_MS, flush: flushNotification })
/** 壳侧偏好存储（原子写 + 节流 + 草稿 LRU），首次使用时懒建。 */
let prefsStore = null
/** 本次进程里向导的连通性测试是否真的通过过 —— wizard:complete 的硬门槛。 */
let wizardConnectionVerified = false
/** 本次进程里渲染层是否已经跑过向导的环境自检（首启门禁据此放行向导自己的会话）。 */
let wizardSelfCheckRan = false
/** 孤儿核心看门狗：周期性检查并清理孤儿进程（electron/orphan-watchdog.mjs）。 */
let orphanWatchdog = null
/** 可配置的服务商白名单（从环境变量 / 配置文件加载）。 */
let providerConfig = null

/** 关窗拦截（Sprint-01 T2）：草稿没处理完不静默关窗（electron/close-guard.mjs）。
 *  渲染层是唯一知道"输入框里有没有东西"的一侧，所以由它报 dirty；壳只负责把关窗这件事
 *  变成"可 await 的一问一答"，并在渲染层不答复时兜底放行。 */
let pendingCloseAsk = null
const closeGuard = new CloseGuard({
  log: (m) => pushLog(`[壳] ${m}`, 'shell'),
  ask: () =>
    new Promise((resolve) => {
      if (!win || win.isDestroyed()) {
        resolve({ action: 'keep', reason: 'no-window' })
        return
      }
      const requestId = `close-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
      pendingCloseAsk = { requestId, resolve }
      send('app:close-request', { requestId })
    })
})

/** 渲染层对关窗询问的答复（`app:closeDecision`）。 */
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

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

function pushLog(line, stream = 'stdout') {
  const entry = { line, stream, at: Date.now() }
  logBuffer.push(entry)
  if (logBuffer.length > 800) logBuffer.shift()
  send('runtime:log', entry)
}

// ── 事件管线：核心事件先入队（硬上限），再按帧转发给渲染层 ──────────────────
/** 通知类事件：走 5 秒聚合，不参与背压丢弃。 */
const NOTIFY_EVENT_TYPES = new Set(['notification.show', 'notice'])
/** 事件泵间隔：一帧一次，渲染层卡住时事件只会堆在队列里，不会撑爆内存。 */
const EVENT_PUMP_MS = 16
let eventPumpTimer = null
let lastOverflowReportAt = 0

function startEventPump() {
  if (eventPumpTimer) return
  eventPumpTimer = setInterval(() => {
    for (const evt of eventQueue.drain()) send('gateway:event', evt)
    notifications.sweep()
    reportOverflow()
  }, EVENT_PUMP_MS)
  eventPumpTimer.unref?.()
}

/** 队列丢过东西才报，且最多每秒报一次（丢 token 是常态，别刷屏）。 */
function reportOverflow() {
  const stats = eventQueue.stats
  if (!stats.droppedToken && !stats.droppedCritical) return
  const at = Date.now()
  if (at - lastOverflowReportAt < 1000) return
  lastOverflowReportAt = at
  send('events:overflow', stats)
  if (stats.droppedCritical) pushLog(`[壳] 事件队列丢弃了 ${stats.droppedCritical} 条关键事件（队列全是关键事件且已满）`, 'shell')
}

function enqueueGatewayEvent(evt) {
  if (!evt) return { accepted: false, reason: 'empty' }
  // 核心真的答完一轮（有正文、不是 error 收尾）→ 记下"本次进程确实连通过"，
  // 这样 wizard:complete 的门槛对"前端自己跑对话验证"的路径也成立
  if (evt.type === 'message.complete' && evt.payload?.status !== 'error' && String(evt.payload?.text ?? '').length > 0) {
    wizardConnectionVerified = true
  }
  if (NOTIFY_EVENT_TYPES.has(evt.type)) {
    notifications.push(evt)
    return { accepted: true, aggregated: true }
  }
  return eventQueue.push(evt)
}

/** 聚合窗口到期：转发合并后的一条事件；窗口没在前台时另外弹一条系统通知。 */
function flushNotification(merged) {
  const payload = merged?.payload ?? {}
  const count = payload.aggregated?.count ?? 1
  const message = payload.message || payload.title || payload.text || merged?.type || '通知'
  send('gateway:event', merged)
  if (!win || win.isDestroyed() || win.isFocused()) return // 用户正看着窗口就不弹系统通知
  try {
    if (Notification.isSupported()) {
      new Notification({ title: count > 1 ? `${count} 条通知` : '24H', body: String(message).slice(0, 300) }).show()
    }
  } catch (err) {
    pushLog(`[壳] 系统通知失败：${err.message}`, 'shell')
  }
}

// ── 壳侧偏好（userData/ui-prefs.json）──────────────────────────────────────
const prefsFile = () => path.join(app.getPath('userData'), 'ui-prefs.json')
const prefs = () => (prefsStore ??= new PrefsStore({ file: prefsFile(), logger: (m) => pushLog(m, 'shell') }))
function readPrefs() {
  try {
    return prefs().snapshot()
  } catch (err) {
    pushLog(`[壳] 读偏好失败：${err.message}`, 'shell')
    return {}
  }
}

// ── 会话记忆：核心崩溃重连后要恢复"上次在用的会话" ─────────────────────────
const SESSION_TRACKING_METHODS = new Set(['session.create', 'session.activate', 'session.resume', 'prompt.submit'])

function rememberSession(method, payload, result) {
  if (!SESSION_TRACKING_METHODS.has(method)) return null
  const id = result?.session_id ?? result?.sessionId ?? payload?.session_id ?? null
  if (typeof id !== 'string' || !id) return null
  supervisor.noteActiveSession(id)
  prefs().noteSession(id) // 落盘（节流），下次冷启动也能恢复
  return id
}

/** 核心重连后把上次会话装回运行时；id 变了就广播给渲染层换 id。 */
async function restoreLastSession(sessionId = null) {
  const wanted = sessionId ?? prefs().lastSessionId()
  if (!gateway || !wanted) return null
  try {
    const resumed = await callWithSessionRemap(
      (m, params) => gateway.call(m, params),
      'session.resume',
      { session_id: wanted, cols: 120 },
      { onRemap: (from, to) => send('session:remapped', { from, to }) }
    )
    const restoredAs = resumed?.session_id ?? wanted
    if (restoredAs !== wanted) send('session:remapped', { from: wanted, to: restoredAs })
    supervisor.noteActiveSession(restoredAs)
    prefs().noteSession(restoredAs)
    pushLog(`[壳] 已恢复上次会话 ${wanted}${restoredAs !== wanted ? ` → ${restoredAs}` : ''}`, 'shell')
    return { sessionId: wanted, restoredAs, count: resumed?.count ?? null }
  } catch (err) {
    pushLog(`[壳] 恢复上次会话失败：${err.message}`, 'shell')
    return { sessionId: wanted, restoredAs: null, error: err.message }
  }
}

/** 首启门禁（双层里的后端那层）：向导没走完时不许开正常的会话。 */
function assertFlowAllowed(kind, payload = {}) {
  const decision = decideFlowGate({ data: readPrefs(), kind, payload, inProgress: wizardSelfCheckRan })
  if (decision.allowed) {
    if (decision.reason === 'grandfathered-legacy-install') {
      // 老用户（这个功能之前就正常用过）不强制重走向导，否则升级即"不能用"
      prefs().markWizardComplete({ connection: { provider: null, model: null, source: 'legacy-grandfather' } })
      prefs().flush()
      pushLog('[壳] 检测到历史会话记录：视作已完成首启向导', 'shell')
    }
    return decision
  }
  const err = new Error(`首启向导未完成（${decision.reason}）：不能进入主流程`)
  err.code = 'EWIZARD_INCOMPLETE'
  throw err
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
  // 界面一就绪就把首启状态推过去：前端不用抢时序（后端在 sessions:create 上另有硬拦）
  win.webContents.on('did-finish-load', () => {
    const gate = prefs().wizardGate()
    send('wizard:required', { required: !gate.complete, gate })
  })
  // 关窗拦截（Sprint-01 T2）：草稿没处理完不许关。所有关窗路径（点×/Cmd+W/菜单退出/系统结束）
  // 都汇合到这一个事件上，`preventDefault()` 同步生效，之后 await 渲染层的三选是安全的；
  // 渲染层的 beforeunload 做不到这件事（它的返回值是同步的，await 不了用户的选择）。
  win.on('close', async (event) => {
    if (closeGuard.approved) return
    event.preventDefault()
    const decision = await closeGuard.confirmClose()
    if (!decision.allow) return // 取消关窗：窗口留着，输入框里的东西一个字没动
    if (decision.action === 'clear') {
      const id = decision.sessionId ?? prefs().lastSessionId()
      if (id) prefs().clearDraft(id)
    }
    prefs().flush() // 关窗前必须落盘，不等 500ms 节流
    closeGuard.approve()
    if (win && !win.isDestroyed()) win.close()
  })
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
  // 不直接灌渲染层：先过队列（背压）+ 通知聚合
  gateway.on('event', (evt) => enqueueGatewayEvent(evt))
  gateway.on('close', () => send('gateway:status', { connected: false }))
  gateway.on('open', () => send('gateway:status', { connected: true }))
  await gateway.connect()
  send('gateway:status', { connected: true, authRequired: Boolean(token) })
}

/** 启动阶段进度（渲染层的"启动中"页据此显示步骤） */
function bootProgress(stage, message) {
  send('boot:progress', { stage, message })
}

/** 建（或复用）运行时实例；孤儿核心回收整个进程只做一次。 */
function ensureRuntime() {
  if (runtime) return runtime
  // 先回收上次被强杀（崩溃/任务管理器结束进程）留下的孤儿核心：否则它会占着端口与内存，
  // 用户下次打开可能连到"上一世"的核心上。只清理父进程已死、存活超过 60s 的核心形态进程。
  const swept = sweepOrphanCores({ log: (m) => pushLog(m, 'shell') })
  if (swept.killed.length) pushLog(`[壳] 启动前回收了 ${swept.killed.length} 个孤儿核心`, 'shell')
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
    // 核心意外退出 → 交监管器退避重连；用户主动重启/退出时监管器处于 stopping，不会重连
    const decision = supervisor.handleExit(info)
    if (decision.retrying) {
      pushLog(
        `[壳] 核心退出（code=${info.code} signal=${info.signal}），${Math.round(decision.delayMs / 1000)}s 后自动重连（第 ${decision.attempt} 次）`,
        'shell'
      )
    } else if (decision.reason === 'max-failures') {
      pushLog('[壳] 连续重连失败次数过多，已停止自动重连', 'shell')
    }
  })
  return runtime
}

/** 单次启动：拉起核心 → 建实时通道 → 广播就绪。失败向上抛，退避重试由 CoreSupervisor 负责。 */
async function bootCore() {
  const rt = ensureRuntime()
  bootProgress('spawn', '正在定位运行时并启动核心进程…')
  const port = await rt.start()
  lastState = { phase: 'ready', port, baseUrl: rt.baseUrl }
  bootProgress('ready', `核心就绪（端口 ${port}）`)
  await connectGateway()
  bootProgress('gateway', '实时通道已连接')
  send('runtime:ready', { port, baseUrl: rt.baseUrl })
  bootProgress('data', '正在读取会话与模型…')
  setTimeout(() => bootProgress('done', '就绪'), 800)
  return { port }
}

/** 核心监管：异常退出 → 退避重连 → 恢复上次会话（electron/core-supervisor.mjs）。 */
const supervisor = new CoreSupervisor({
  start: bootCore,
  stop: async () => {
    gateway?.close()
    gateway = null
    await runtime?.stop()
  },
  recover: async ({ lastSessionId }) => restoreLastSession(lastSessionId),
  log: (m) => pushLog(m, 'shell')
})

supervisor.on('reconnect-scheduled', ({ attempt, delayMs }) => {
  lastState = { phase: 'reconnecting', attempt, delayMs }
  send('runtime:state', lastState)
  bootProgress('reconnect', `核心意外退出，${Math.round(delayMs / 1000)}s 后自动重连（第 ${attempt} 次）`)
})

supervisor.on('reconnected', (info) => {
  lastState = { phase: 'ready', reconnected: true, attempts: info.attempts }
  send('core:reconnected', {
    attempts: info.attempts,
    lastSessionId: info.lastSessionId ?? null,
    restored: info.restored ?? null
  })
  bootProgress('gateway', `核心已重连（第 ${info.attempts} 次重试成功）`)
})

supervisor.on('failed', ({ attempts, lastError }) => {
  const message = `连续 ${attempts} 次重连失败，已停止自动重试`
  lastState = { phase: 'failed', message, lastError: lastError ?? null }
  send('runtime:error', { message: `${message}（最后一次：${lastError ?? '未知'}）` })
})

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
  const result = await callWithSessionRemap((m, params) => gateway.call(m, params), method, payload ?? {}, {
    // id 变了对渲染层是重要信息：它得把后续调用切到新 id，否则会一直 4001
    onRemap: (from, to) => send('session:remapped', { from, to })
  })
  rememberSession(method, payload, result)
  return result
}

/** 会话切换/关闭/发送互斥：同一会话串行 + 全局切换 mux（并发切换排队，不并行）。 */
const serialized = (method) => async (payload = {}) => {
  const sid = payload?.session_id ? `session:${payload.session_id}` : null
  const task = () => gwCall(method)(payload)
  return sid ? sessionMux.runAll([SWITCH_MUX_KEY, sid], task) : sessionMux.run(SWITCH_MUX_KEY, task)
}

handle('runtime:state', () => ({ ...lastState, logs: logBuffer.slice(-300) }))
handle('runtime:restart', async () => {
  lastState = { phase: 'restarting' }
  send('runtime:state', lastState)
  try {
    await supervisor.restart()
  } catch (err) {
    lastState = { phase: 'failed', message: err.message }
    send('runtime:error', { message: err.message })
  }
  return lastState
})
handle('runtime:health', () => runtime.health())
handle('runtime:status', () => runtime.api('/api/status'))

// 会话 / 对话 / 模型 / 配置 —— 全部走 WS JSON-RPC
handle('sessions:list', gwCall('session.list'))
// 首启门禁：向导没走完时，只有向导自己的会话（payload.onboarding === true）能建
handle('sessions:create', async (payload = {}) => {
  assertFlowAllowed('session.create', payload)
  // `onboarding` 只是壳内部的标记，核心的严格契约会拒掉额外字段，必须在这里摘掉
  const { onboarding, ...params } = payload ?? {}
  return gwCall('session.create')(params)
})
handle('session:activate', serialized('session.activate'))
handle('session:resume', serialized('session.resume'))
handle('session:history', gwCall('session.history'))
handle('session:interrupt', gwCall('session.interrupt'))
handle('session:cwdSet', gwCall('session.cwd.set'))
handle('session:status', gwCall('session.status'))
handle('session:title', gwCall('session.title'))
handle('chat:send', serialized('prompt.submit'))
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
handle('session:delete', serialized('session.delete'))
handle('session:close', serialized('session.close'))

// 文件面板与会话搜索走 REST（OpenAPI 里的正式接口，实测 0.21.3）
handle('fs:list', (payload) => runtime.request('GET', `/api/fs/list?path=${encodeURIComponent(payload?.path ?? '')}`))
handle('fs:read', (payload) => runtime.request('GET', `/api/files/read?path=${encodeURIComponent(payload?.path ?? '')}`))
handle('sessions:search', (payload) =>
  runtime.request('GET', `/api/sessions/search?q=${encodeURIComponent(payload?.q ?? '')}`)
)

// ── 壳自己的 UI 偏好（主题等）────────────────────────────────────────────
// 刻意不走核心配置：这是"壳长什么样"的偏好，跟 agent 的配置不是一回事（数据分层）。
// 存在 userData/ui-prefs.json，渲染进程读不到磁盘，只通过这两个通道拿。
handle('ui:prefs:get', () => readPrefs())
// 通用补丁不许带 wizard：完成态只能走 wizard:complete（后端另有"必须真连过核心"的校验）
handle('ui:prefs:set', (patch) => prefs().patch(sanitizePrefsPatch(patch)))

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
  return { active, pinned: readPrefs().runtimeDir ?? null, distUrl: distUrl(), candidates }
})
/** 下载版运行时的落点（userData/runtimes）—— 安装包目录是只读的，下载的东西只能放用户数据里 */
const runtimesRoot = () => path.join(app.getPath('userData'), 'runtimes')

/** 出厂默认分发源（可在设置里改；设空字符串即表示"不预置"） */
const DEFAULT_DIST_URL = process.env.HERMES_DIST_URL || 'http://111.229.225.8:8899'

const distUrl = () => {
  const prefs = readPrefs()
  return typeof prefs.runtimeDistUrl === 'string' ? prefs.runtimeDistUrl : DEFAULT_DIST_URL
}

handle('runtime:dist', (payload) => {
  if (payload && typeof payload === 'object' && 'url' in payload) {
    const next = prefs().patch({ runtimeDistUrl: String(payload.url || '').trim() })
    prefs().flush()
    return { url: next.runtimeDistUrl }
  }
  return { url: distUrl(), installed: listInstalledRuntimes(runtimesRoot()), defaultUrl: DEFAULT_DIST_URL }
})

handle('runtime:checkUpdate', async () => {
  const url = distUrl()
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
  const url = distUrl()
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
  prefs().patch({ runtimeDir: dir })
  prefs().flush() // 换运行时这种选择必须立刻落盘：重启失败也得记住
  // 换运行时必须重启核心（进程是拿旧 python 起的）
  lastState = { phase: 'restarting' }
  send('runtime:state', lastState)
  if (runtime) runtime.pinnedRoot = dir // 复用同一个 Runtime 实例，必须显式换解析目标
  try {
    await supervisor.restart()
  } catch (err) {
    lastState = { phase: 'failed', message: err.message }
    send('runtime:error', { message: err.message })
  }
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

// ── 首启向导（Sprint-01 T1）：环境自检 / 连通性测试 / 完成态 ──────────────
handle('wizard:state', () => ({
  gate: prefs().wizardGate(),
  wizard: prefs().wizard(),
  connectionVerifiedInProcess: wizardConnectionVerified
}))

// 真探测：运行时是否在位（含体积/核心版本）、数据目录与偏好目录可写、回环端口可绑
handle('wizard:selfcheck', () => {
  wizardSelfCheckRan = true // 渲染层真的在走向导（门禁放行它的会话创建）
  return selfCheck({
    appRoot: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    pinnedRoot: readPrefs().runtimeDir || null,
    hermesHome: process.env.HERMES_HOME || path.join(app.getPath('userData'), 'hermes'),
    userDataDir: app.getPath('userData')
  })
})

// 真调核心：存 Key → 设模型 → 建临时会话 → 真发一句话 → 等模型回话 → 关会话；失败**不写**完成态
handle('wizard:testConnection', async (payload = {}) => {
  const apiKey = payload?.apiKey ? String(payload.apiKey) : null
  const result = await runConnectionTestWithPrefs({
    prefs: prefs(),
    provider: payload?.provider,
    model: payload?.model ?? null,
    apiKey,
    call: (method, params) => {
      if (!gateway) throw new Error('核心尚未就绪')
      return gateway.call(method, params ?? {})
    },
    request: (method, pathname, body) => runtime.request(method, pathname, body),
    // 等"模型真的回话"要靠事件流：直接订阅 gateway（不进背压队列，避免被丢 token 影响判定）
    subscribe: (fn) => {
      if (!gateway) return () => {}
      gateway.on('event', fn)
      return () => gateway.off('event', fn)
    }
  })
  if (result.ok) wizardConnectionVerified = true
  // Key 不进日志、不进返回值
  if (apiKey && result.error) result.error = String(result.error).split(apiKey).join('***')
  return result
})

handle('wizard:complete', () => {
  assertWizardCompleteAllowed({ data: readPrefs(), verifiedInProcess: wizardConnectionVerified })
  const state = prefs().markWizardComplete({ connection: prefs().wizard()?.lastConnectionTest ?? null })
  prefs().flush()
  return { gate: prefs().wizardGate(), wizard: state }
})

handle('wizard:reset', () => {
  wizardConnectionVerified = false
  prefs().resetWizard()
  prefs().flush()
  return { gate: prefs().wizardGate() }
})

// ── 草稿与输入保护（Sprint-01 T2）：落 userData/ui-prefs.json，不引 SQLite ──
handle('drafts:get', (payload) => {
  const id = payload?.sessionId ? String(payload.sessionId) : null
  return { sessionId: id, draft: id ? prefs().getDraft(id) : null, drafts: prefs().listDrafts() }
})
handle('drafts:set', (payload) => {
  const draft = prefs().setDraft(payload?.sessionId, {
    text: payload?.text ?? '',
    model: payload?.model ?? null,
    cwd: payload?.cwd ?? null
  })
  return { draft, drafts: prefs().listDrafts() }
})
handle('drafts:clear', (payload) => ({ cleared: prefs().clearDraft(payload?.sessionId) }))
// 关窗前/切会话前显式落盘：默认是 500ms 节流，这个通道保证"现在就在磁盘上"
handle('drafts:flush', () => {
  prefs().flush()
  return { drafts: prefs().listDrafts(), file: prefsFile() }
})

// ── 关窗拦截（Sprint-01 T2）：渲染层报 dirty，壳在 win.on('close') 里问三选 ──────────
/** 渲染层声明"输入框里有没保存的东西"；壳不猜，只听。 */
handle('app:closeGuardSet', (payload) => ({
  dirty: closeGuard.setDirty(payload?.dirty === true),
  asked: closeGuard.asked,
  timeouts: closeGuard.timeouts
}))
/** 关窗三选的答复。不匹配当前询问（过期/重放）一律不接受。 */
handle('app:closeDecision', (payload) => answerCloseRequest(payload))

app.whenReady().then(async () => {
  // 加载可配置的服务商白名单
  providerConfig = loadProviderConfig({ userDataDir: app.getPath('userData') })
  pushLog(`[壳] 服务商白名单：${providerConfig.providers.join(', ')}`, 'shell')

  // 启动孤儿核心看门狗
  orphanWatchdog = createOrphanWatchdog({
    log: (m) => pushLog(m, 'shell'),
    onOrphansFound: (killed) => {
      pushLog(`[壳] 看门狗清理了 ${killed.length} 个孤儿核心`, 'shell')
    }
  })
  orphanWatchdog.start()

  createWindow()
  startEventPump()
  await supervisor.boot()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

let quitting = false
app.on('before-quit', async (event) => {
  if (quitting) return
  event.preventDefault()
  quitting = true
  closeGuard.approve() // 退出流程已经明确：不再弹关窗三选（草稿在下面 dispose 时兜底落盘）
  // 停止孤儿看门狗
  orphanWatchdog?.stop()
  try {
    await sessionMux.drain() // 别把正在跑的会话调用半路掐断
  } catch {
    /* 忽略：退出优先 */
  }
  await supervisor.stop() // stopping=true → 核心退出不会触发自动重连
  prefs().dispose() // 草稿/向导完成态落盘
  app.quit()
})

app.on('window-all-closed', () => app.quit())
