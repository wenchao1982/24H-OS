/**
 * 孤儿核心看门狗：周期性检查孤儿进程并清理。
 *
 * 与 orphan-sweep.mjs 的分工：
 *   - orphan-sweep.mjs：启动时一次性清理（纯函数，可测试）
 *   - orphan-watchdog.mjs：运行时周期性清理（定时器 + 状态管理）
 *
 * 策略：
 *   - 每 60 秒检查一次（可通过环境变量调整）
 *   - 只清理"父进程已死 + 存活超过 60s + 形态匹配"的进程
 *   - 发现孤儿时发事件通知 UI（可选）
 */
import { sweepOrphanCores } from './orphan-sweep.mjs'

export class OrphanWatchdog {
  /**
   * @param {{
   *   intervalMs?: number,
   *   minAgeSeconds?: number,
   *   log?: (msg: string) => void,
   *   onOrphansFound?: (orphans: number[]) => void,
   *   setTimeoutFn?: typeof setTimeout,
   *   clearTimeoutFn?: typeof clearTimeout,
   * }} opts
   */
  constructor({
    intervalMs = 60_000,
    minAgeSeconds = 60,
    log = () => {},
    onOrphansFound = null,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout
  } = {}) {
    this.intervalMs = intervalMs
    this.minAgeSeconds = minAgeSeconds
    this.log = log
    this.onOrphansFound = onOrphansFound
    this.setTimeoutFn = setTimeoutFn
    this.clearTimeoutFn = clearTimeoutFn
    this._timer = null
    this._running = false
    this._totalKilled = 0
  }

  /** 启动周期性检查。重复调用安全。 */
  start() {
    if (this._timer) return
    this._schedule()
    this.log('[壳] 孤儿看门狗已启动')
  }

  /** 停止周期性检查。 */
  stop() {
    if (this._timer) {
      this.clearTimeoutFn(this._timer)
      this._timer = null
    }
    this.log(`[壳] 孤儿看门狗已停止（累计清理 ${this._totalKilled} 个）`)
  }

  /** 立即执行一次检查（不等定时器）。 */
  async check() {
    if (this._running) return { killed: [], found: [] }
    this._running = true
    try {
      const result = sweepOrphanCores({
        minAgeSeconds: this.minAgeSeconds,
        log: this.log
      })
      if (result.killed.length) {
        this._totalKilled += result.killed.length
        this.log(`[壳] 看门狗发现并清理了 ${result.killed.length} 个孤儿核心`)
        this.onOrphansFound?.(result.killed)
      }
      return result
    } finally {
      this._running = false
    }
  }

  /** 累计清理数 */
  get totalKilled() {
    return this._totalKilled
  }

  _schedule() {
    this._timer = this.setTimeoutFn(() => {
      this._timer = null
      this.check().catch((err) => {
        this.log(`[壳] 看门狗检查失败：${err.message}`)
      })
      this._schedule()
    }, this.intervalMs)
    this._timer?.unref?.()
  }
}

/**
 * 创建看门狗实例（单例模式，main.js 用）。
 */
export function createOrphanWatchdog(opts = {}) {
  return new OrphanWatchdog(opts)
}
