/**
 * IPC 通道注册：所有 ipcMain.handle() 集中在此，main.js 只负责窗口与生命周期。
 *
 * 设计原则：
 *   - 每个通道名 → 一个纯函数或 async 函数，副作用通过注入的 context 获取
 *   - context 提供 { runtime, gateway, supervisor, prefs, send, pushLog, ... }
 *   - 渲染层调用约定：所有通道返回 { ok: true, data } | { ok: false, error }
 */
import { app, clipboard, dialog, ipcMain, Menu, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { callWithSessionRemap } from './session-remap.mjs'
import { fetchDistManifest, installRuntimeAsset, listInstalledRuntimes } from './runtime-download.mjs'
import { Runtime } from './runtime.js'

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

/**
 * 注册所有 IPC 通道。
 * @param {{
 *   win: () => import('electron').BrowserWindow | null,
 *   runtime: () => import('./runtime.js').Runtime | null,
 *   gateway: () => import('./gateway.js').Gateway | null,
 *   supervisor: () => import('./core-supervisor.mjs').CoreSupervisor | null,
 *   prefs: () => import('./prefs-store.mjs').PrefsStore,
 *   readPrefs: () => any,
 *   send: (channel: string, payload: any) => void,
 *   pushLog: (line: string, stream?: string) => void,
 *   lastState: { phase: string, [k: string]: any },
 *   logBuffer: any[],
 *   rememberSession: (method: string, payload: any, result: any) => string | null,
 *   restoreLastSession: (sessionId?: string) => Promise<any>,
 *   bootProgress: (stage: string, message: string) => void,
 *   eventQueue: import('./event-pipeline.mjs').EventQueue,
 *   notifications: import('./event-pipeline.mjs').NotificationAggregator,
 *   enqueueGatewayEvent: (evt: any) => any,
 *   wizardConnectionVerified: { value: boolean },
 *   wizardSelfCheckRan: { value: boolean },
 *   closeGuard: import('./close-guard.mjs').CloseGuard,
 *   pendingCloseAsk: { value: any },
 *   answerCloseRequest: (payload: any) => any,
 *   runtimesRoot: () => string,
 *   distUrl: () => string,
 *   selfCheck: (opts: any) => any,
 *   runConnectionTestWithPrefs: (opts: any) => Promise<any>,
 *   sanitizePrefsPatch: (patch: any) => any,
 *   assertWizardCompleteAllowed: (opts: any) => void,
 *   decideFlowGate: (opts: any) => any,
 * }} ctx
 */
export function registerIpcHandlers(ctx) {
  const {
    win,
    runtime: getRuntime,
    gateway: getGateway,
    supervisor: getSupervisor,
    prefs: getPrefs,
    readPrefs,
    send,
    pushLog,
    lastState,
    logBuffer,
    rememberSession,
    restoreLastSession,
    bootProgress,
    enqueueGatewayEvent,
    wizardConnectionVerified,
    wizardSelfCheckRan,
    closeGuard,
    pendingCloseAsk,
    answerCloseRequest,
    runtimesRoot,
    distUrl,
    selfCheck,
    runConnectionTestWithPrefs,
    sanitizePrefsPatch,
    assertWizardCompleteAllowed,
    decideFlowGate
  } = ctx

  // ── 需要 gateway 就绪的调用 ────────────────────────────────────────────────
  const gwCall = (method) => async (payload = {}) => {
    const gw = getGateway()
    if (!gw) throw new Error('核心尚未就绪')
    const result = await callWithSessionRemap((m, params) => gw.call(m, params), method, payload ?? {}, {
      onRemap: (from, to) => send('session:remapped', { from, to })
    })
    rememberSession(method, payload, result)
    return result
  }

  // ── 会话互斥（import 由 main.js 负责，这里只用） ──
  // 注意：sessionMux 和 serialized 需要从外部注入（因为 main.js 持有实例）
  // 这里用简单版本，实际由 main.js 的 serialized 包装

  // ── 运行时状态 ──────────────────────────────────────────────────────────────
  handle('runtime:state', () => ({ ...lastState, logs: logBuffer.slice(-300) }))

  handle('runtime:restart', async () => {
    lastState.phase = 'restarting'
    send('runtime:state', lastState)
    try {
      await getSupervisor().restart()
    } catch (err) {
      lastState.phase = 'failed'
      lastState.message = err.message
      send('runtime:error', { message: err.message })
    }
    return lastState
  })

  handle('runtime:health', () => getRuntime()?.health())
  handle('runtime:status', () => getRuntime()?.api('/api/status'))

  // ── 会话 / 对话 / 模型 / 配置（WS JSON-RPC）────────────────────────────
  handle('sessions:list', gwCall('session.list'))

  handle('sessions:create', async (payload = {}) => {
    decideFlowGate({ data: readPrefs(), kind: 'session.create', payload, inProgress: wizardSelfCheckRan.value })
    const { onboarding, ...params } = payload ?? {}
    return gwCall('session.create')(params)
  })

  handle('session:activate', async (payload = {}) => {
    const gw = getGateway()
    if (!gw) throw new Error('核心尚未就绪')
    const task = () => gwCall('session.activate')(payload)
    return task()
  })

  handle('session:resume', async (payload = {}) => {
    const gw = getGateway()
    if (!gw) throw new Error('核心尚未就绪')
    const task = () => gwCall('session.resume')(payload)
    return task()
  })

  handle('session:history', gwCall('session.history'))
  handle('session:interrupt', gwCall('session.interrupt'))
  handle('session:cwdSet', gwCall('session.cwd.set'))
  handle('session:status', gwCall('session.status'))
  handle('session:title', gwCall('session.title'))

  handle('chat:send', async (payload = {}) => {
    const gw = getGateway()
    if (!gw) throw new Error('核心尚未就绪')
    const task = () => gwCall('prompt.submit')(payload)
    return task()
  })

  // ── 模型与服务商 ────────────────────────────────────────────────────────────
  handle('models:list', () => getRuntime()?.request('GET', '/api/model/options?include_unconfigured=1'))
  handle('model:set', (payload) => getRuntime()?.request('POST', '/api/model/set', payload ?? {}))
  handle('model:saveKey', gwCall('model.save_key'))

  handle('providers:customEndpoints', () => getRuntime()?.request('GET', '/api/providers/custom-endpoints'))
  handle('providers:customEndpointUpsert', (payload) =>
    getRuntime()?.request('POST', '/api/providers/custom-endpoints', payload ?? {})
  )

  // ── 配置（REST）───────────────────────────────────────────────────────────
  handle('config:get', () => getRuntime()?.request('GET', '/api/config'))
  handle('config:set', (payload) => getRuntime()?.request('PUT', '/api/config', payload?.config ?? payload))

  // ── Gateway 能力与用量 ─────────────────────────────────────────────────────
  handle('gateway:capabilities', gwCall('gateway.capabilities'))
  handle('session:usage', gwCall('session.usage'))
  handle('session:undo', gwCall('session.undo'))
  handle('session:branch', gwCall('session.branch'))
  handle('session:delete', async (payload = {}) => gwCall('session.delete')(payload))
  handle('session:close', async (payload = {}) => gwCall('session.close')(payload))

  // ── 文件面板与会话搜索（REST）────────────────────────────────────────────
  handle('fs:list', (payload) => getRuntime()?.request('GET', `/api/fs/list?path=${encodeURIComponent(payload?.path ?? '')}`))
  handle('fs:read', (payload) => getRuntime()?.request('GET', `/api/files/read?path=${encodeURIComponent(payload?.path ?? '')}`))
  handle('sessions:search', (payload) =>
    getRuntime()?.request('GET', `/api/sessions/search?q=${encodeURIComponent(payload?.q ?? '')}`)
  )

  // ── 壳 UI 偏好 ──────────────────────────────────────────────────────────────
  handle('ui:prefs:get', () => readPrefs())
  handle('ui:prefs:set', (patch) => getPrefs().patch(sanitizePrefsPatch(patch)))

  // ── 技能 / 定时任务 / 用量 ─────────────────────────────────────────────────
  handle('skills:list', gwCall('skills.manage'))
  handle('cron:list', gwCall('cron.manage'))
  handle('insights:get', gwCall('insights.get'))
  handle('usage:bars', gwCall('usage.bars'))
  handle('setup:runtimeCheck', gwCall('setup.runtime_check'))

  handle('open:external', (url) => shell.openExternal(String(url)))

  // ── 壳信息（诊断页/数据目录页）──────────────────────────────────────────
  handle('ui:info', () => ({
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    chromeVersion: process.versions.chrome,
    platform: `${process.platform}-${process.arch}`,
    packaged: app.isPackaged,
    paths: {
      userData: app.getPath('userData'),
      hermesHome: process.env.HERMES_HOME || path.join(app.getPath('userData'), 'hermes'),
      runtime: getRuntime()?.describe?.() ?? null,
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
    const w = win()
    const def = payload?.defaultName || 'export.md'
    const res = await dialog.showSaveDialog(w, { defaultPath: path.join(app.getPath('documents'), def) })
    if (res.canceled || !res.filePath) return { canceled: true }
    fs.writeFileSync(res.filePath, String(payload?.content ?? ''), 'utf8')
    return { canceled: false, path: res.filePath }
  })

  handle('ui:contextMenu', (items) => {
    const w = win()
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
        window: w ?? undefined,
        callback: () => resolve({ id: picked })
      })
    })
  })

  // ── 运行时管理 ──────────────────────────────────────────────────────────────
  handle('runtime:list', () => {
    const rt = getRuntime()
    const active = rt?.pinnedRoot ?? rt?._resolved?.root ?? null
    const candidates = Runtime.listCandidates({
      appRoot: app.getAppPath(),
      resourcesPath: process.resourcesPath
    })
    for (const item of listInstalledRuntimes(runtimesRoot())) {
      candidates.push({ ...item, usable: true })
    }
    return { active, pinned: readPrefs().runtimeDir ?? null, distUrl: distUrl(), candidates }
  })

  handle('runtime:dist', (payload) => {
    if (payload && typeof payload === 'object' && 'url' in payload) {
      const next = getPrefs().patch({ runtimeDistUrl: String(payload.url || '').trim() })
      getPrefs().flush()
      return { url: next.runtimeDistUrl }
    }
    return { url: distUrl(), installed: listInstalledRuntimes(runtimesRoot()), defaultUrl: process.env.HERMES_DIST_URL || 'http://111.229.225.8:8899' }
  })

  handle('runtime:checkUpdate', async () => {
    const url = distUrl()
    if (!url) return { configured: false, message: '还没配置分发源地址（填一个 http(s) 前缀，例如 http://your-host/24h-dist）' }
    try {
      const manifest = await fetchDistManifest(url)
      const installed = listInstalledRuntimes(runtimesRoot()).map((r) => r.coreVersion)
      let activeVersion = null
      try {
        const rt = getRuntime()
        const manifestPath = path.join(rt?._resolved?.root ?? '', '.24h-os-runtime.json')
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
    getPrefs().patch({ runtimeDir: dir })
    getPrefs().flush()
    lastState.phase = 'restarting'
    send('runtime:state', lastState)
    const rt = getRuntime()
    if (rt) rt.pinnedRoot = dir
    try {
      await getSupervisor().restart()
    } catch (err) {
      lastState.phase = 'failed'
      lastState.message = err.message
      send('runtime:error', { message: err.message })
    }
    return { runtimeDir: dir, state: lastState }
  })

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

  // ── 壳自更新 ────────────────────────────────────────────────────────────────
  handle('ui:updateCheck', async () => {
    if (!app.isPackaged) return { available: false, message: '开发模式不检查更新' }
    const configFile = path.join(process.resourcesPath ?? '', 'app-update.yml')
    if (!fs.existsSync(configFile)) {
      return { available: false, message: '未配置更新源（发版时在 package.json 的 build.publish 里填上，然后重新打包）' }
    }
    let updater
    try {
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

  // ── 原生目录选择 ────────────────────────────────────────────────────────────
  handle('dialog:pickDir', async () => {
    const w = win()
    const res = await dialog.showOpenDialog(w, { properties: ['openDirectory', 'createDirectory'] })
    return res.canceled ? null : res.filePaths[0]
  })

  // ── 首启向导 ────────────────────────────────────────────────────────────────
  handle('wizard:state', () => ({
    gate: getPrefs().wizardGate(),
    wizard: getPrefs().wizard(),
    connectionVerifiedInProcess: wizardConnectionVerified.value
  }))

  handle('wizard:selfcheck', () => {
    wizardSelfCheckRan.value = true
    return selfCheck({
      appRoot: app.getAppPath(),
      resourcesPath: process.resourcesPath,
      pinnedRoot: readPrefs().runtimeDir || null,
      hermesHome: process.env.HERMES_HOME || path.join(app.getPath('userData'), 'hermes'),
      userDataDir: app.getPath('userData')
    })
  })

  handle('wizard:testConnection', async (payload = {}) => {
    const apiKey = payload?.apiKey ? String(payload.apiKey) : null
    const gw = getGateway()
    const rt = getRuntime()
    const result = await runConnectionTestWithPrefs({
      prefs: getPrefs(),
      provider: payload?.provider,
      model: payload?.model ?? null,
      apiKey,
      call: (method, params) => {
        if (!gw) throw new Error('核心尚未就绪')
        return gw.call(method, params ?? {})
      },
      request: (method, pathname, body) => rt.request(method, pathname, body),
      subscribe: (fn) => {
        if (!gw) return () => {}
        gw.on('event', fn)
        return () => gw.off('event', fn)
      }
    })
    if (result.ok) wizardConnectionVerified.value = true
    if (apiKey && result.error) result.error = String(result.error).split(apiKey).join('***')
    return result
  })

  handle('wizard:complete', () => {
    assertWizardCompleteAllowed({ data: readPrefs(), verifiedInProcess: wizardConnectionVerified.value })
    const state = getPrefs().markWizardComplete({ connection: getPrefs().wizard()?.lastConnectionTest ?? null })
    getPrefs().flush()
    return { gate: getPrefs().wizardGate(), wizard: state }
  })

  handle('wizard:reset', () => {
    wizardConnectionVerified.value = false
    getPrefs().resetWizard()
    getPrefs().flush()
    return { gate: getPrefs().wizardGate() }
  })

  // ── 草稿与输入保护 ──────────────────────────────────────────────────────────
  handle('drafts:get', (payload) => {
    const id = payload?.sessionId ? String(payload.sessionId) : null
    return { sessionId: id, draft: id ? getPrefs().getDraft(id) : null, drafts: getPrefs().listDrafts() }
  })

  handle('drafts:set', (payload) => {
    const draft = getPrefs().setDraft(payload?.sessionId, {
      text: payload?.text ?? '',
      model: payload?.model ?? null,
      cwd: payload?.cwd ?? null
    })
    return { draft, drafts: getPrefs().listDrafts() }
  })

  handle('drafts:clear', (payload) => ({ cleared: getPrefs().clearDraft(payload?.sessionId) }))

  handle('drafts:flush', () => {
    getPrefs().flush()
    return { drafts: getPrefs().listDrafts(), file: path.join(app.getPath('userData'), 'ui-prefs.json') }
  })

  // ── 关窗拦截 ────────────────────────────────────────────────────────────────
  handle('app:closeGuardSet', (payload) => ({
    dirty: closeGuard.setDirty(payload?.dirty === true),
    asked: closeGuard.asked,
    timeouts: closeGuard.timeouts
  }))

  handle('app:closeDecision', (payload) => answerCloseRequest(payload))
}
