/**
 * 与核心的实时通道：WebSocket JSON-RPC。
 *
 * 协议实测（Hermes 0.21.0）：
 *   连接：ws://127.0.0.1:<port>/api/ws?token=<__HERMES_SESSION_TOKEN__>（回环地址用 token 查询参数）
 *   调用：{"jsonrpc":"2.0","id":N,"method":"prompt.submit","params":{...}}
 *   应答：{"jsonrpc":"2.0","id":N,"result":{...}} | {"jsonrpc":"2.0","id":N,"error":{...}}
 *   事件：{"jsonrpc":"2.0","method":"event","params":{"type":"message.delta","session_id":"…","payload":{…}}}
 *
 * 关键方法：session.create / session.list / session.history / session.interrupt /
 *          prompt.submit / model.options / model.save_key / config.get / config.set /
 *          gateway.capabilities
 * 关键事件：gateway.ready / sessions.changed / session.info / turn.started /
 *          agent.token / message.delta / reasoning.delta / thinking.delta /
 *          tool.started / tool.completed / message.complete / error
 */
import { EventEmitter } from 'node:events'

/** 默认调用超时；`model.options` 首次调用可能很慢，单独放宽。 */
const DEFAULT_TIMEOUT = 30_000
const SLOW_METHODS = { 'model.options': 90_000, 'session.history': 60_000 }

export class Gateway extends EventEmitter {
  /**
   * @param {{ baseUrl: string, token?: string|null, log?: (msg: string) => void }} opts
   */
  constructor({ baseUrl, token = null, log = () => {} }) {
    super()
    this.baseUrl = baseUrl
    this.token = token
    this.log = log
    this.ws = null
    this._pending = new Map()
    this._nextId = 1
    this._closed = false
    this._reconnectTimer = null
  }

  get wsUrl() {
    const u = new URL(this.baseUrl)
    const proto = u.protocol === 'https:' ? 'wss:' : 'ws:'
    const token = this.token ? `?token=${encodeURIComponent(this.token)}` : ''
    return `${proto}//${u.host}/api/ws${token}`
  }

  connect() {
    if (this._closed) return Promise.reject(new Error('已关闭'))
    if (this.ws?.readyState === 1) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl)
      this.ws = ws
      const onOpen = () => {
        cleanup()
        this.log('gateway: 已连接')
        this.emit('open')
        resolve()
      }
      const onError = (err) => {
        cleanup()
        reject(new Error(`gateway 连接失败：${err?.message || 'error'}`))
      }
      const cleanup = () => {
        ws.removeEventListener('open', onOpen)
        ws.removeEventListener('error', onError)
      }
      ws.addEventListener('open', onOpen)
      ws.addEventListener('error', onError)
      ws.addEventListener('message', (ev) => this._onFrame(ev.data))
      ws.addEventListener('close', () => {
        this.log('gateway: 已断开')
        this.emit('close')
        for (const [, p] of this._pending) p.reject(new Error('gateway 已断开'))
        this._pending.clear()
        if (!this._closed) {
          this._reconnectTimer = setTimeout(() => {
            this.connect().catch((e) => this.log(`gateway: 重连失败 ${e.message}`))
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
    if (msg.id != null && this._pending.has(msg.id)) {
      const { resolve, reject, timer } = this._pending.get(msg.id)
      clearTimeout(timer)
      this._pending.delete(msg.id)
      if (msg.error) {
        // 保留 JSON-RPC 的错误码：4001 = 运行时已不持有该会话（需 session.resume）
        const err = new Error(msg.error.message || JSON.stringify(msg.error))
        err.code = msg.error.code
        err.data = msg.error.data
        reject(err)
      } else {
        resolve(msg.result)
      }
      return
    }
    // 事件帧：{"method":"event","params":{"type":…,"session_id":…,"payload":…}}
    if (msg.method === 'event' && msg.params) {
      const { type, session_id: sessionId, payload } = msg.params
      this.emit('event', { type, sessionId, payload })
      this.emit(`event:${type}`, { sessionId, payload })
    }
  }

  /** 调用一个 JSON-RPC 方法；超时/错误都走 reject。 */
  call(method, params = {}) {
    if (this._closed) return Promise.reject(new Error('已关闭'))
    const id = this._nextId++
    const timeout = SLOW_METHODS[method] ?? DEFAULT_TIMEOUT
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id)
        reject(new Error(`调用 ${method} 超时（${timeout / 1000}s）`))
      }, timeout)
      this._pending.set(id, { resolve, reject, timer })
      const send = () => this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
      if (this.ws?.readyState === 1) send()
      else this.connect().then(send).catch(reject)
    })
  }

  close() {
    this._closed = true
    clearTimeout(this._reconnectTimer)
    try {
      this.ws?.close()
    } catch {}
  }
}
