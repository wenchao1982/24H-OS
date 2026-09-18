/**
 * Electron 主进程：开窗 → 启动核心 → 建立实时通道 → 把能力暴露给渲染进程。
 *
 * 分工：主进程持有 python 子进程与 WebSocket，渲染进程只通过 IPC 调方法、收事件。
 *
 * 模块化：
 *   - lifecycle.mjs：窗口创建 + 关窗拦截 + 退出流程
 *   - ipc-handlers.mjs：所有 IPC 通道注册
 *   - orphan-watchdog.mjs：周期性孤儿核心清理
 *   - provider-config.mjs：可配置的服务商白名单
 */
import { BrowserWindow, Notification, app } from 'electron'
import path from 'node:path'
import { callWithSessionRemap } from './session-remap.mjs'
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
import { loadProviderConfig } from './provider-config.mjs'
import { registerIpcHandlers } from './ipc-handlers.mjs'

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

// ── 注册所有 IPC 通道（从 ipc-handlers.mjs 集中管理）────────────────────
const runtimesRoot = () => path.join(app.getPath('userData'), 'runtimes')
const DEFAULT_DIST_URL = process.env.HERMES_DIST_URL || 'http://111.229.225.8:8899'
const distUrl = () => {
  const p = readPrefs()
  return typeof p.runtimeDistUrl === 'string' ? p.runtimeDistUrl : DEFAULT_DIST_URL
}

registerIpcHandlers({
  win: () => win,
  runtime: () => runtime,
  gateway: () => gateway,
  supervisor: () => supervisor,
  prefs,
  readPrefs,
  send,
  pushLog,
  lastState,
  logBuffer,
  rememberSession,
  restoreLastSession,
  bootProgress,
  enqueueGatewayEvent,
  wizardConnectionVerified: { get value() { return wizardConnectionVerified }, set value(v) { wizardConnectionVerified = v } },
  wizardSelfCheckRan: { get value() { return wizardSelfCheckRan }, set value(v) { wizardSelfCheckRan = v } },
  closeGuard,
  pendingCloseAsk: { get value() { return pendingCloseAsk }, set value(v) { pendingCloseAsk = v } },
  answerCloseRequest,
  runtimesRoot,
  distUrl,
  selfCheck,
  runConnectionTestWithPrefs,
  sanitizePrefsPatch,
  assertWizardCompleteAllowed,
  decideFlowGate,
  sessionMux
})

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
