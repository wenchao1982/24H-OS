/**
 * 核心进程监管（Sprint-01 T3）：核心异常退出后自动重连，并在重连成功后恢复上次会话。
 *
 * 状态机：`idle → starting → running`；核心掉了进 `reconnecting`（指数退避 1→2→4…封顶 30s）；
 * 连续失败超过 `maxFailures` 就停在 `failed` 并**不再无限重试**（无限重试只会把用户机器拖垮，
 * 而且日志会被刷满，真正的原因反而看不见）。
 *
 * 本文件不依赖 electron，也不自己做定时器实现 —— 定时器/启动动作/恢复动作全部注入，
 * 所以 scripts/backend-tests.mjs 能用假时钟确定性地验证退避序列与恢复行为。
 */
import { EventEmitter } from 'node:events'

export const BACKOFF_BASE_MS = 1000
export const BACKOFF_MAX_MS = 30_000
export const MAX_CONSECUTIVE_FAILURES = 5

/** 第 n 次重连前等多久：1s、2s、4s、8s、16s、30s（封顶）。 */
export function backoffDelay(attempt, { baseDelayMs = BACKOFF_BASE_MS, maxDelayMs = BACKOFF_MAX_MS } = {}) {
  const n = Math.max(1, Math.floor(Number(attempt) || 1))
  return Math.min(maxDelayMs, baseDelayMs * 2 ** (n - 1))
}

export class CoreSupervisor extends EventEmitter {
  /**
   * @param {{start: () => Promise<any>, stop?: () => Promise<any>,
   *          recover?: (info: {attempts: number, lastSessionId: string|null}) => Promise<any>,
   *          log?: (msg: string) => void, baseDelayMs?: number, maxDelayMs?: number,
   *          maxFailures?: number, setTimeoutFn?: typeof setTimeout,
   *          clearTimeoutFn?: typeof clearTimeout}} opts
   */
  constructor({
    start,
    stop,
    recover = null,
    log = () => {},
    baseDelayMs = BACKOFF_BASE_MS,
    maxDelayMs = BACKOFF_MAX_MS,
    maxFailures = MAX_CONSECUTIVE_FAILURES,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout
  } = {}) {
    super()
    if (typeof start !== 'function') throw new Error('CoreSupervisor 需要 start()')
    this._start = start
    this._stop = stop ?? null
    this.recover = recover
    this.log = log
    this.baseDelayMs = baseDelayMs
    this.maxDelayMs = maxDelayMs
    this.maxFailures = maxFailures
    this.setTimeoutFn = setTimeoutFn
    this.clearTimeoutFn = clearTimeoutFn
    this._state = 'idle'
    this._failures = 0
    this._reconnectCount = 0
    this._timer = null
    this._inFlight = null
    this._stopping = false
    this._lastError = null
    this._activeSessionId = null
    this._lastExit = null
  }

  get state() {
    return this._state
  }

  /** 连续失败次数（重连成功即清零）。 */
  get failures() {
    return this._failures
  }

  /** 本次故障期间已经安排过的重连次数。 */
  get reconnectCount() {
    return this._reconnectCount
  }

  get pendingDelayMs() {
    return this._timer ? this._pendingDelayMs ?? null : null
  }

  get stopping() {
    return this._stopping
  }

  get lastSessionId() {
    return this._activeSessionId
  }

  /** 渲染层每次切/建会话都报一次，重连成功后就用它恢复。 */
  noteActiveSession(sessionId) {
    const id = sessionId ? String(sessionId) : null
    this._activeSessionId = id
    return id
  }

  /** 首次启动：失败不抛，直接进入退避重连（开机时没有运行时也能等用户补装）。 */
  async boot() {
    try {
      return await this.start()
    } catch (err) {
      this.log(`[supervisor] 核心启动失败：${err.message}（进入退避重连）`)
      return this._scheduleReconnect({ trigger: 'boot-failed', message: err.message })
    }
  }

  /** 单次启动（重复调用复用同一个 promise）。成功 → running；失败 → 抛给调用方。 */
  start() {
    if (this._stopping) return Promise.reject(new Error('监管器已停止，不能启动核心'))
    if (this._inFlight) return this._inFlight
    this._setState('starting')
    this._inFlight = (async () => {
      try {
        const result = await this._start()
        this._failures = 0
        this._reconnectCount = 0
        this._setState('running')
        this.emit('running', { result })
        return result
      } catch (err) {
        this._lastError = err?.message || String(err)
        this._setState('failed', { message: this._lastError })
        this.emit('start-failed', { message: this._lastError })
        throw err
      } finally {
        this._inFlight = null
      }
    })()
    return this._inFlight
  }

  /** 核心意外退出（由 Runtime 的 exit 回调驱动）。 */
  handleExit(info = {}) {
    this._lastExit = info
    if (this._stopping) return { retrying: false, reason: 'stopping' }
    if (this._timer) return { retrying: false, reason: 'already-scheduled' }
    return this._scheduleReconnect({ trigger: 'core-exit', exit: info })
  }

  /** 用户主动重启（设置里换运行时/点重启）：不算崩溃，不进入退避循环，失败直接抛给调用方。 */
  async restart() {
    await this.stop()
    this._stopping = false
    this._failures = 0
    this._reconnectCount = 0
    this._lastError = null
    this._setState('idle')
    return this.start()
  }

  async stop() {
    this._stopping = true
    if (this._timer) {
      this.clearTimeoutFn(this._timer)
      this._timer = null
    }
    this._setState('stopped')
    try {
      await this._stop?.()
    } catch (err) {
      this.log(`[supervisor] 关闭核心失败：${err.message}`)
    }
  }

  // ── 内部 ──────────────────────────────────────────────────────────────
  _scheduleReconnect(trigger) {
    if (this._stopping) return { retrying: false, reason: 'stopping' }
    if (this._timer) return { retrying: false, reason: 'already-scheduled' }
    this._failures += 1
    if (this._failures > this.maxFailures) {
      this._setState('failed')
      this.emit('failed', {
        attempts: this.maxFailures,
        lastError: this._lastError,
        hint: `连续 ${this.maxFailures} 次重连失败，已停止自动重试（可在设置里手动重启）`
      })
      return { retrying: false, reason: 'max-failures', failures: this._failures }
    }
    const delayMs = backoffDelay(this._failures, { baseDelayMs: this.baseDelayMs, maxDelayMs: this.maxDelayMs })
    this._reconnectCount += 1
    this._pendingDelayMs = delayMs
    this._setState('reconnecting', { attempt: this._failures, delayMs })
    this.emit('reconnect-scheduled', { attempt: this._failures, delayMs, trigger })
    this._timer = this.setTimeoutFn(() => {
      this._timer = null
      this._pendingDelayMs = null
      return this._attemptReconnect()
    }, delayMs)
    this._timer?.unref?.()
    return { retrying: true, delayMs, attempt: this._failures }
  }

  async _attemptReconnect() {
    const attempts = this._reconnectCount
    this.emit('reconnecting', { attempts })
    try {
      await this.start()
    } catch (err) {
      this.log(`[supervisor] 第 ${attempts} 次重连失败：${err.message}`)
      return this._scheduleReconnect({ trigger: 'reconnect-failed', message: err.message })
    }
    const info = { attempts, lastSessionId: this._activeSessionId }
    let restored = null
    if (this.recover) {
      try {
        restored = await this.recover(info)
      } catch (err) {
        // 恢复失败不影响"核心已经回来了"这个事实，渲染层拿到 sessionId=null 自己决定怎么办
        this.log(`[supervisor] 恢复上次会话失败：${err.message}`)
      }
    }
    this.emit('reconnected', { ...info, restored })
    return { retrying: false, ok: true, attempts, restored }
  }

  _setState(state, extra = {}) {
    this._state = state
    this.emit('state', { state, failures: this._failures, reconnectCount: this._reconnectCount, ...extra })
  }
}
