/**
 * 传输适配层：检测环境，自动选择 IPC（Electron）或 HTTP/WS（Web）。
 *
 * 渲染层只需：
 *   import { getTransport } from './transport-adaptor.js'
 *   const hermes = getTransport()
 *   await hermes.sessionsList({})
 *
 * 环境检测：
 *   - Electron：window.hermes 存在（preload 注入）
 *   - Web：window.hermes 不存在，需要用户提供核心地址
 */
import { WebTransport } from './web-transport.mjs'

/** 缓存的 transport 实例 */
let cachedTransport = null

/** Web 模式下的占位实现（Electron-only 功能降级） */
const webFallbacks = {
  openExternal: async (url) => { window.open(url, '_blank'); return { ok: true } },
  pickDirectory: async () => null,
  showContextMenu: async (items) => {
    // 简单的 HTML 上下文菜单
    return new Promise((resolve) => {
      const menu = document.createElement('div')
      menu.className = 'web-context-menu'
      menu.style.cssText = 'position:fixed;z-index:99999;background:#1a1a1a;border:1px solid #333;border-radius:6px;padding:4px 0;box-shadow:0 4px 12px rgba(0,0,0,.5);min-width:160px'
      for (const item of items) {
        const row = document.createElement('div')
        row.textContent = item.label
        row.style.cssText = `padding:6px 12px;cursor:pointer;color:${item.danger ? '#f44' : '#eee'}`
        row.onmouseenter = () => row.style.background = '#333'
        row.onmouseleave = () => row.style.background = ''
        row.onclick = () => { menu.remove(); resolve({ ok: true, data: { id: item.id } }) }
        menu.appendChild(row)
      }
      document.body.appendChild(menu)
      const close = (e) => { if (!menu.contains(e.target)) { menu.remove(); resolve({ ok: true, data: { id: null } }) } }
      setTimeout(() => document.addEventListener('click', close, { once: true }), 0)
    })
  },
  openPath: async (path) => { window.open(`file://${path}`, '_blank'); return { ok: true } },
  copyText: async (text) => { await navigator.clipboard.writeText(String(text ?? '')); return { ok: true, data: { copied: true } } },
  saveTextFile: async (payload) => {
    const blob = new Blob([String(payload?.content ?? '')], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = payload?.defaultName || 'export.md'
    a.click()
    URL.revokeObjectURL(url)
    return { ok: true, data: { canceled: false } }
  },
  updateCheck: async () => ({ ok: true, data: { available: false, message: 'Web 模式不支持检查更新' } }),
  uiInfo: async () => ({
    ok: true,
    data: {
      appVersion: 'web',
      electronVersion: '-',
      chromeVersion: navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] ?? '-',
      platform: `web-${navigator.platform}`,
      packaged: false,
      paths: { userData: '-', hermesHome: '-', runtime: '-', logs: '-' }
    }
  }),
  runtimeInfo: async () => ({ ok: true, data: { manifest: null } }),
  runtimeList: async () => ({ ok: true, data: { active: null, pinned: null, candidates: [] } }),
  runtimeActivate: async () => ({ ok: true, data: {} }),
  runtimeDist: async () => ({ ok: true, data: { url: '', installed: [] } }),
  runtimeCheckUpdate: async () => ({ ok: true, data: { configured: false, message: 'Web 模式' } }),
  runtimeInstall: async () => { throw new Error('Web 模式不支持安装运行时') },
  wizardState: async () => ({ ok: true, data: { gate: { complete: true }, wizard: {} } }),
  wizardSelfCheck: async () => ({ ok: true, data: { ok: true } }),
  wizardTestConnection: async () => ({ ok: true, data: { ok: true } }),
  wizardComplete: async () => ({ ok: true, data: {} }),
  wizardReset: async () => ({ ok: true, data: {} }),
  draftsGet: async () => ({ ok: true, data: { drafts: {} } }),
  draftsSet: async () => ({ ok: true, data: {} }),
  draftsClear: async () => ({ ok: true, data: {} }),
  draftsFlush: async () => ({ ok: true, data: {} }),
  closeGuardSet: async () => ({ ok: true, data: {} }),
  closeDecision: async () => ({ ok: true, data: {} })
}

/**
 * 获取 transport 实例。
 *
 * @param {{ forceWeb?: boolean, coreUrl?: string, token?: string }} [opts]
 * @returns {Promise<object>}
 */
export async function getTransport(opts = {}) {
  if (cachedTransport) return cachedTransport

  // Electron 环境：直接用 preload 注入的 window.hermes
  if (!opts.forceWeb && window.hermes) {
    cachedTransport = window.hermes
    return cachedTransport
  }

  // Web 环境：需要核心地址
  const coreUrl = opts.coreUrl || localStorage.getItem('hermes-core-url') || prompt('请输入核心地址（如 http://192.168.1.100:8080）')
  if (!coreUrl) throw new Error('需要核心地址才能连接')

  localStorage.setItem('hermes-core-url', coreUrl)
  const token = opts.token || localStorage.getItem('hermes-core-token') || null

  const web = new WebTransport({
    baseUrl: coreUrl,
    token,
    log: (m) => console.log(m)
  })

  // 建立连接（获取 token + 建 WS）
  await web.connect()

  // 保存 token 供下次使用
  if (web.token) localStorage.setItem('hermes-core-token', web.token)

  // 包装成与 window.hermes 相同的 API 面
  cachedTransport = createWebApi(web)
  return cachedTransport
}

/**
 * 把 WebTransport 包装成与 window.hermes 相同的 API 面。
 */
function createWebApi(web) {
  // 通用代理：REST 调用
  const restProxy = (method, pathname) => async (payload) => {
    try {
      const data = await web.request(method, pathname, payload)
      return { ok: true, data }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  }

  // 通用代理：WS RPC 调用
  const rpcProxy = (method) => async (payload) => {
    try {
      const data = await web.call(method, payload)
      return { ok: true, data }
    } catch (err) {
      return { ok: false, error: err.message, code: err.code }
    }
  }

  // 事件订阅
  const eventOn = (event, cb) => {
    const handler = (evt) => cb(evt)
    web.on('event', (data) => {
      if (data.type === event.replace('gateway:event', '')) handler(data)
    })
    return () => web.off('event', handler)
  }

  const api = {
    // 运行时（Web 模式下部分功能受限）
    state: async () => ({ ok: true, data: { phase: 'ready', port: new URL(web.baseUrl).port } }),
    restart: webFallbacks.updateCheck,
    health: restProxy('GET', '/api/health'),
    status: restProxy('GET', '/api/status'),

    // 会话（走 WS RPC）
    sessionsList: rpcProxy('session.list'),
    sessionsCreate: rpcProxy('session.create'),
    sessionActivate: rpcProxy('session.activate'),
    sessionResume: rpcProxy('session.resume'),
    sessionHistory: rpcProxy('session.history'),
    sessionInterrupt: rpcProxy('session.interrupt'),
    sessionStatus: rpcProxy('session.status'),
    sessionDelete: rpcProxy('session.delete'),
    sessionClose: rpcProxy('session.close'),
    sessionCwdSet: rpcProxy('session.cwd.set'),
    sessionTitle: rpcProxy('session.title'),
    sessionsSearch: restProxy('GET', '/api/sessions/search'),
    send: rpcProxy('prompt.submit'),

    // 文件（走 REST，但 Web 模式下路径受限）
    fsList: async (payload) => {
      try {
        const data = await web.request('GET', `/api/fs/list?path=${encodeURIComponent(payload?.path ?? '')}`)
        return { ok: true, data }
      } catch (err) {
        return { ok: false, error: err.message }
      }
    },
    fsRead: async (payload) => {
      try {
        const data = await web.request('GET', `/api/files/read?path=${encodeURIComponent(payload?.path ?? '')}`)
        return { ok: true, data }
      } catch (err) {
        return { ok: false, error: err.message }
      }
    },

    // 模型与配置
    modelsList: async () => {
      try {
        const data = await web.request('GET', '/api/model/options?include_unconfigured=1')
        return { ok: true, data }
      } catch (err) {
        return { ok: false, error: err.message }
      }
    },
    modelSet: async (payload) => {
      try {
        const data = await web.request('POST', '/api/model/set', payload)
        return { ok: true, data }
      } catch (err) {
        return { ok: false, error: err.message }
      }
    },
    modelSaveKey: rpcProxy('model.save_key'),
    customEndpoints: async () => {
      try {
        const data = await web.request('GET', '/api/providers/custom-endpoints')
        return { ok: true, data }
      } catch (err) {
        return { ok: false, error: err.message }
      }
    },
    customEndpointUpsert: async (payload) => {
      try {
        const data = await web.request('POST', '/api/providers/custom-endpoints', payload)
        return { ok: true, data }
      } catch (err) {
        return { ok: false, error: err.message }
      }
    },
    configGet: async () => {
      try {
        const data = await web.request('GET', '/api/config')
        return { ok: true, data }
      } catch (err) {
        return { ok: false, error: err.message }
      }
    },
    configSet: async (payload) => {
      try {
        const data = await web.request('PUT', '/api/config', payload?.config ?? payload)
        return { ok: true, data }
      } catch (err) {
        return { ok: false, error: err.message }
      }
    },
    capabilities: rpcProxy('gateway.capabilities'),

    // 壳偏好（Web 模式下用 localStorage）
    prefsGet: async () => {
      try {
        const raw = localStorage.getItem('hermes-web-prefs')
        return { ok: true, data: raw ? JSON.parse(raw) : {} }
      } catch {
        return { ok: true, data: {} }
      }
    },
    prefsSet: async (patch) => {
      try {
        const raw = localStorage.getItem('hermes-web-prefs')
        const prefs = raw ? JSON.parse(raw) : {}
        Object.assign(prefs, patch)
        localStorage.setItem('hermes-web-prefs', JSON.stringify(prefs))
        return { ok: true, data: prefs }
      } catch {
        return { ok: true, data: {} }
      }
    },

    // 向导（Web 模式下直接跳过）
    wizardState: webFallbacks.wizardState,
    wizardSelfCheck: webFallbacks.wizardSelfCheck,
    wizardTestConnection: webFallbacks.wizardTestConnection,
    wizardComplete: webFallbacks.wizardComplete,
    wizardReset: webFallbacks.wizardReset,

    // 草稿（Web 模式下用 localStorage）
    draftsGet: async (payload) => {
      const id = payload?.sessionId
      const raw = localStorage.getItem('hermes-web-drafts')
      const drafts = raw ? JSON.parse(raw) : {}
      return { ok: true, data: { sessionId: id, draft: id ? drafts[id] : null, drafts } }
    },
    draftsSet: async (payload) => {
      const raw = localStorage.getItem('hermes-web-drafts')
      const drafts = raw ? JSON.parse(raw) : {}
      if (payload?.sessionId) drafts[payload.sessionId] = { text: payload.text ?? '', at: Date.now() }
      localStorage.setItem('hermes-web-drafts', JSON.stringify(drafts))
      return { ok: true, data: { drafts } }
    },
    draftsClear: async (payload) => {
      const raw = localStorage.getItem('hermes-web-drafts')
      const drafts = raw ? JSON.parse(raw) : {}
      delete drafts[payload?.sessionId]
      localStorage.setItem('hermes-web-drafts', JSON.stringify(drafts))
      return { ok: true, data: { cleared: true } }
    },
    draftsFlush: async () => ({ ok: true, data: {} }),

    // 关窗（Web 模式下不需要）
    closeGuardSet: webFallbacks.closeGuardSet,
    closeDecision: webFallbacks.closeDecision,

    // 技能 / 任务 / 用量
    skillsList: rpcProxy('skills.manage'),
    cronList: rpcProxy('cron.manage'),
    insights: rpcProxy('insights.get'),
    usageBars: rpcProxy('usage.bars'),
    runtimeCheck: rpcProxy('setup.runtime_check'),
    sessionUsage: rpcProxy('session.usage'),
    sessionUndo: rpcProxy('session.undo'),
    sessionBranch: rpcProxy('session.branch'),

    // 原生能力（Web 模式下降级）
    openExternal: webFallbacks.openExternal,
    pickDirectory: webFallbacks.pickDirectory,
    uiInfo: webFallbacks.uiInfo,
    runtimeInfo: webFallbacks.runtimeInfo,
    runtimeList: webFallbacks.runtimeList,
    runtimeActivate: webFallbacks.runtimeActivate,
    runtimeDist: webFallbacks.runtimeDist,
    runtimeCheckUpdate: webFallbacks.runtimeCheckUpdate,
    runtimeInstall: webFallbacks.runtimeInstall,
    openPath: webFallbacks.openPath,
    copyText: webFallbacks.copyText,
    saveTextFile: webFallbacks.saveTextFile,
    showContextMenu: webFallbacks.showContextMenu,
    updateCheck: webFallbacks.updateCheck,

    // 事件流
    onReady: (cb) => eventOn('runtime:ready', cb),
    onRuntimeError: (cb) => eventOn('runtime:error', cb),
    onRuntimeExit: (cb) => eventOn('runtime:exit', cb),
    onLog: (cb) => eventOn('runtime:log', cb),
    onState: (cb) => eventOn('runtime:state', cb),
    onGatewayStatus: (cb) => eventOn('gateway:status', cb),
    onEvent: (cb) => eventOn('gateway:event', cb),
    onBootProgress: (cb) => eventOn('boot:progress', cb),
    onSessionRemapped: (cb) => eventOn('session:remapped', cb),
    onRuntimeDownload: (cb) => eventOn('runtime:download', cb),
    onCoreReconnected: (cb) => eventOn('core:reconnected', cb),
    onWizardRequired: (cb) => eventOn('wizard:required', cb),
    onEventsOverflow: (cb) => eventOn('events:overflow', cb),
    onCloseRequest: (cb) => eventOn('app:close-request', cb)
  }

  return api
}

/** 清除缓存的 transport（用于测试或切换环境） */
export function resetTransport() {
  cachedTransport = null
}

/** 检查是否在 Electron 环境 */
export function isElectron() {
  return Boolean(window.hermes)
}

/** 检查是否在 Web 环境 */
export function isWeb() {
  return !window.hermes
}
