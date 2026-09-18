/**
 * 关窗拦截（Sprint-01 T2 的壳侧那一半）：输入框里有没处理的内容时，关窗要先问一句。
 *
 * 为什么这件事必须在主进程做，而不是渲染层的 `beforeunload`：
 *  1. `beforeunload` 里**没法 await 用户的选择**——它只能同步地返回一个"要拦"的信号，
 *     于是"三选（清空 / 保留 / 取消）"必须拆成两趟：拦一次 → 用户点完 → 再 close 一次。
 *     这套二次关闭在真机上依赖"窗口还没开始销毁"等一串时序，且和菜单退出/`app.quit()`
 *     这类外壳发起的关闭路径会打架（拦了 shell 的退出 → 窗口关不掉）。
 *  2. 主进程的 `win.on('close')` 是**所有**关窗路径（点×、Cmd+W、菜单退出、系统会话结束）
 *     的唯一汇合点，`event.preventDefault()` 同步生效，之后再 await 渲染层的答复是安全的。
 *
 * 兜底原则：**宁可放行，绝不把窗口卡死**。渲染层不答复（崩了/卡了/还没接这条通道）→
 * 超时后按"保留草稿"关窗，只记一条日志。用户永远关得掉自己的窗口。
 */

/** 渲染层答复关窗询问的超时（ms）。超过就按"保留草稿"放行。 */
export const CLOSE_DECISION_TIMEOUT_MS = 2000

/** 渲染层能给的答复：清空草稿 / 保留草稿 / 取消关窗。 */
export const CLOSE_ACTIONS = new Set(['clear', 'keep', 'cancel'])

export class CloseGuard {
  /**
   * @param {{ask: () => {action?: string, sessionId?: string|null}|Promise<*>,
   *          log?: (msg: string) => void,
   *          timeoutMs?: number,
   *          setTimeoutFn?: typeof setTimeout,
   *          clearTimeoutFn?: typeof clearTimeout}} opts
   *   `ask` = 向渲染层问一句（壳里就是发 `app:close-request`）；由调用方决定怎么问。
   */
  constructor({
    ask,
    log = () => {},
    timeoutMs = CLOSE_DECISION_TIMEOUT_MS,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout
  } = {}) {
    if (typeof ask !== 'function') throw new Error('CloseGuard 需要 ask（问渲染层一句的函数）')
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error(`关窗询问超时必须是非负数，收到 ${timeoutMs}`)
    this.ask = ask
    this.log = log
    this.timeoutMs = timeoutMs
    this.setTimeoutFn = setTimeoutFn
    this.clearTimeoutFn = clearTimeoutFn
    /** 渲染层声明的"有未保存输入"。壳不猜，只听渲染层报（它才知道输入框里有什么）。 */
    this.dirty = false
    /** 已放行的关窗（放行后不再重复追问，避免"关闭 → 又拦一次"的循环）。 */
    this.approved = false
    /** 正在等答复，期间的重复关窗事件直接拦下，不叠第二次询问。 */
    this.asking = false
    /** 询问次数（测试与诊断用）。 */
    this.asked = 0
    /** 超时/异常放行的次数：非 0 说明渲染层这条通道有问题。 */
    this.timeouts = 0
  }

  /** 渲染层报"有没有未保存的输入"。 */
  setDirty(dirty) {
    const next = dirty === true
    if (next !== this.dirty) this.log(next ? '渲染层报告有未保存的输入：关窗要先问一句' : '未保存的输入已处理完：关窗直接放行')
    this.dirty = next
    if (!next) this.approved = false // 之后又脏了还能再拦
    return this.dirty
  }

  /** 显式放行（例如 `app.quit()` 里已经开始退出流程，不再追问）。 */
  approve() {
    this.approved = true
  }

  /**
   * 关窗前调用。
   * @returns {Promise<{allow: boolean, action: string, sessionId?: string|null}>}
   *   `action`：`approved`（已放行）/`clean`（本来就没草稿）/`keep`/`clear`/`cancel`/
   *   `timeout`/`error`（放行了的兜底）/`asking`（正在问，本次先拦下）。
   */
  async confirmClose() {
    if (this.approved) return { allow: true, action: 'approved' }
    if (!this.dirty) return { allow: true, action: 'clean' }
    if (this.asking) return { allow: false, action: 'asking' }

    this.asking = true
    this.asked += 1
    let timer = null
    try {
      const outcome = await Promise.race([
        Promise.resolve()
          .then(() => this.ask())
          .then((reply) => ({ kind: 'answer', reply }))
          .catch((err) => ({ kind: 'error', err })),
        new Promise((resolve) => {
          timer = this.setTimeoutFn(() => resolve({ kind: 'timeout' }), this.timeoutMs)
        })
      ])

      if (outcome.kind === 'timeout') {
        this.timeouts += 1
        this.log(`关窗询问超过 ${this.timeoutMs}ms 没答复：按“保留草稿”关窗（渲染层这条通道可能没接上）`)
        return { allow: true, action: 'timeout' }
      }
      if (outcome.kind === 'error') {
        this.timeouts += 1
        this.log(`关窗询问失败（${outcome.err?.message ?? outcome.err}）：按“保留草稿”关窗`)
        return { allow: true, action: 'error' }
      }

      const reply = outcome.reply ?? {}
      const action = reply.action
      if (action === 'cancel') {
        this.log('关窗被取消：用户选择先处理未保存的输入')
        return { allow: false, action: 'cancel' }
      }
      if (CLOSE_ACTIONS.has(action)) {
        return { allow: true, action, sessionId: reply.sessionId ?? null }
      }
      this.log(`关窗答复里的 action 不认识（${String(action)}）：按“保留草稿”关窗`)
      return { allow: true, action: 'unknown', sessionId: reply.sessionId ?? null }
    } finally {
      if (timer) this.clearTimeoutFn(timer)
      this.asking = false
    }
  }
}
