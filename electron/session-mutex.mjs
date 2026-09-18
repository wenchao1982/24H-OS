/**
 * 会话互斥（Sprint-01 T5）：同一会话上的操作串行、跨会话的操作互不阻塞。
 *
 * 为什么要它：会话切换 / 关闭 / 发送都是异步的，用户连点两下就会并发触发两组调用 ——
 * 结果是核心那边同一个 session 被 activate/resume 交叉调用（出现"半截状态"），
 * 或者切完 A 又切回 B 时事件被路由到错的会话。
 *
 * 用法：
 *   await mux.run(`session:${id}`, () => gwCall('session.activate')({session_id: id}))
 *   await mux.runAll([SWITCH_MUX_KEY, `session:${id}`], fn)   // 全局切换 mux + 单会话锁
 *
 * 实现是"每个 key 一条 promise 链"：后续任务挂在前一个任务的 settle 之后执行，
 * 不会因为前一个任务抛错而断链（错误照常抛给各自的调用方）。
 */
export const SWITCH_MUX_KEY = '__session.switch__'

export class KeyedSerializer {
  constructor({ log = () => {} } = {}) {
    this._tails = new Map()
    this.log = log
    this.queued = 0
    this.completed = 0
  }

  /** 当前有多少个 key 在用（诊断用）。 */
  get activeKeys() {
    return [...this._tails.keys()]
  }

  isBusy(key) {
    return this._tails.has(String(key))
  }

  /** 同一个 key 上的任务严格串行。 */
  run(key, task) {
    const k = String(key)
    const prev = this._tails.get(k) ?? Promise.resolve()
    this.queued += 1
    const result = prev.then(() => task())
    const tail = result.then(
      (value) => {
        this.completed += 1
        if (this._tails.get(k) === tail) this._tails.delete(k)
        return value
      },
      (err) => {
        this.completed += 1
        if (this._tails.get(k) === tail) this._tails.delete(k)
        throw err
      }
    )
    this._tails.set(k, tail)
    return result
  }

  /**
   * 一次拿多个 key（按键名排序后依次入链，避免两个调用方以相反顺序拿锁而互相等待）。
   * 典型用法：切换会话 = 全局切换 mux + 该会话的锁。
   */
  runAll(keys, task) {
    const unique = [...new Set((keys ?? []).map(String))].sort()
    if (!unique.length) return this.run('__global__', task)
    const [head, ...rest] = unique
    return this.run(head, () => (rest.length ? this.runAll(rest, task) : task()))
  }

  /** 等所有在跑的任务落地（测试/退出前用）。 */
  async drain() {
    while (this._tails.size) {
      await Promise.allSettled([...this._tails.values()])
    }
  }
}
