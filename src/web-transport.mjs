/**
 * Web 传输层：浏览器直连核心的 HTTP/WS，不经过 Electron 主进程。
 *
 * 使用场景：
 *   - 网页版：用户在浏览器里打开，直连核心的 HTTP/WS 端口
 *   - 远程访问：核心跑在 NAS/服务器上，浏览器从外网连
 *
 * 协议（与核心的契约）：
 *   REST：GET/POST http://<host>:<port>/api/...（带 Authorization: Bearer <token>）
 *   WS：ws://<host>:<port>/api/ws?token=<token>（JSON-RPC 2.0）
 *
 * 与 Electron IPC 的区别：
 *   - Electron：renderer → preload(IPC) → main.js(鉴权+转发) → core
 *   - Web：renderer → core（直连，自带 token）
 *
 * 安全注意：
 *   - token 暴露在浏览器内存里，只在同源页面内有效
 *   - 核心默认只监听 127.0.0.1，远程访问需要用户自己做端口转发/反向代理
 */
export class WebTransport {
  /** @type {'http'} */
  type = 'http'

  /**
   * @param {{
   *   baseUrl: string,           // 核心地址，如 http://192.168.1.100:8080
   *   token?: string|null,       // 会话 token（可选，首次可从 GET / 自动获取）
   *   onEvent?: (evt: any) => void,
   *   log?: (msg: string) => void,
   * }} opts
   */
  constructor({ baseUrl, token = null, onEvent = null, log = () => {} }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.token = token
    this.onEvent = onEvent
    this.log = log
    this._ws = null
    this._pending = new Map()
    this._nextId = 1
    this._closed = false
    this._reconnectTimer = null
    this._eventHandlers = new Map()
  }

  // ── 初始化：获取 token + 建立 WS ──────────────────────────────────────────

  /** 自动获取 token（从核心的 HTML 页面里提取） */
  async fetchToken() {
    if (this.token) return this.token
    try {
      const res = await fetch(`${this.baseUrl}/`)
      const html = await res.text()
      const m = /__HERMES_SESSION_TOKEN__="([^"]+)"/.exec(html)
      if (m) {
        this.token = m[1]
        this.log(`[web] 获取到 token`)
        return this.token
      }
    } catch (err) {
      this.log(`[web] 获取 token 失败：${err.message}`)
    }
    return null
  }

  /** 完整初始化：获取 token → 建 WS 连接 */
  async connect() {
    await this.fetchToken()
    return this._connectWs()
  }

  // ── REST 调用 ──────────────────────────────────────────────────────────────

  /** 带鉴权的 REST 请求 */
  async request(method, pathname, body) {
    const headers = {
      'Content-Type': 'application/json'
    }
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`

    const opts = { method, headers }
    if (body !== undefined) opts.body = JSON.stringify(body)

    const res = await fetch(`${this.baseUrl}${pathname}`, opts)
    const text = await res.text()
    let parsed = null
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      parsed = { _raw: text.slice(0, 500) }
    }
    if (!res.ok) throw new Error(`${method} ${pathname} → HTTP ${res.status} ${text.slice(0, 200)}`)
    return parsed
  }

  // ── WS JSON-RPC ───────────────────────────────────────────────────────────

  get _wsUrl() {
    const proto = this.baseUrl.startsWith('https') ? 'wss:' : 'ws:'
    const host = this.baseUrl.replace(/^https?:\/\//, '')
    const token = this.token ? `?token=${encodeURIComponent(this.token)}` : ''
    return `${proto}//${host}/api/ws${token}`
  }

  _connectWs() {
    if (this._closed) return Promise.reject(new Error('已关闭'))
    if (this._ws?.readyState === 1) return Promise.resolve()

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this._wsUrl)
      this._ws = ws

      const onOpen = () => {
        cleanup()
        this.log('[web] WS 已连接')
        resolve()
      }
      const onError = (err) => {
        cleanup()
        reject(new Error(`WS 连接失败：${err?.message || 'error'}`))
      }
      const cleanup = () => {
        ws.removeEventListener('open', onOpen)
        ws.removeEventListener('error', onError)
      }

      ws.addEventListener('open', onOpen)
      ws.addEventListener('error', onError)
      ws.addEventListener('message', (ev) => this._onFrame(ev.data))
      ws.addEventListener('close', () => {
        this.log('[web] WS 已断开')
        this._emit('close')
        for (const [, p] of this._pending) p.reject(new Error('WS 已断开'))
        this._pending.clear()
        if (!this._closed) {
          this._reconnectTimer = setTimeout(() => {
            this._connectWs().catch((e) => this.log(`[web] WS 重连失败：${e.message}`))
          }, 1000)
        }
      })
    })
  }

  _onFrame(raw) {
    let msg
    try {
      msg = JSON.parse(String(raw))
    } catch {
      return
    }
    // RPC 应答
    if (msg.id != null && this._pending.has(msg.id)) {
      const { resolve, reject, timer } = this._pending.get(msg.id)
      clearTimeout(timer)
      this._pending.delete(msg.id)
      if (msg.error) {
        const err = new Error(msg.error.message || JSON.stringify(msg.error))
        err.code = msg.error.code
        err.data = msg.error.data
        reject(err)
      } else {
        resolve(msg.result)
      }
      return
    }
    // 事件帧
    if (msg.method === 'event' && msg.params) {
      const { type, session_id: sessionId, payload } = msg.params
      this._emit('event', { type, sessionId, payload })
    }
  }

  /** 调用 JSON-RPC 方法 */
  async call(method, params = {}) {
    if (this._closed) throw new Error('已关闭')
    const id = this._nextId++
    const timeout = method === 'model.options' ? 90_000 : 30_000
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id)
        reject(new Error(`调用 ${method} 超时（${timeout / 1000}s）`))
      }, timeout)
      this._pending.set(id, { resolve, reject, timer })
      const send = () => this._ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
      if (this._ws?.readyState === 1) send()
      else this._connectWs().then(send).catch(reject)
    })
  }

  // ── 事件系统（与 EventEmitter 兼容）────────────────────────────────────

  on(event, handler) {
    if (!this._eventHandlers.has(event)) this._eventHandlers.set(event, new Set())
    this._eventHandlers.get(event).add(handler)
    return () => this.off(event, handler)
  }

  off(event, handler) {
    this._eventHandlers.get(event)?.delete(handler)
  }

  _emit(event, ...args) {
    this.onEvent?.({ event, args })
    for (const handler of this._eventHandlers.get(event) ?? []) {
      try { handler(...args) } catch (e) { this.log(`[web] 事件处理错误：${e.message}`) }
    }
    for (const handler of this._eventHandlers.get('*') ?? []) {
      try { handler(event, ...args) } catch (e) { this.log(`[web] 通配处理错误：${e.message}`) }
    }
  }

  close() {
    this._closed = true
    clearTimeout(this._reconnectTimer)
    try { this._ws?.close() } catch {}
  }
}

/**
 * 创建 WebTransport 实例。
 * @param {{ baseUrl: string, token?: string }} opts
 */
export function createWebTransport(opts) {
  return new WebTransport(opts)
}
