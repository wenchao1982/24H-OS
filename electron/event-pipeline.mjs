/**
 * 事件背压 + 通知聚合（Sprint-01 T4）。
 *
 * 背景：核心会持续推 token 级增量（`message.delta` / `reasoning.delta` / `thinking.delta`…）。
 * 渲染层一旦卡住（长列表渲染、Markdown 重排），事件就会在主进程里越堆越多，
 * 最后是内存曲线爆炸 + 界面"补课"式追赶。所以这里做两件事：
 *
 *  1. `EventQueue`：硬上限（默认 10000）。满了之后**优先丢 token 类增量**，
 *     状态/错误/工具事件一律保留进队（需要时挤掉最老的可丢事件）。
 *     丢多少条要能被看见 —— 计数通过 `onOverflow` 报给主进程，再转发给渲染层。
 *  2. `NotificationAggregator`：同一 `type+sessionId` 的通知在 5s 窗口内合并成一条，
 *     避免"跑一个任务弹 30 个通知"。
 *
 * 两者都不依赖 electron / 真实时钟（时间由调用方传 `now`），便于确定性单测。
 */

/** 事件队列硬上限：方案 v1.4.0 §8.28 的固定值。 */
export const EVENT_QUEUE_LIMIT = 10_000

/** 通知合并窗口：5 秒。 */
export const NOTIFY_WINDOW_MS = 5_000

/**
 * 可以丢的"增量流"事件：丢了最多是少几帧动画/少几个字，turn 结束时会用完整文本兜回来。
 * 注意这里**不含** message.complete / error / tool.* / session.* —— 那些丢了界面就会卡在错误状态。
 *
 * ⚠️ 名单里的名字必须全部出现在 `electron/contract.generated.json` 的 `events` 里。
 * 这里曾写过 `agent.token`（只在 gateway.js 注释里出现过的旧名，核心 0.21.3 的 69 个事件里没有），
 * 规则永不命中还没人发现。现在钉两条断言：`events.queue.droppable-list-subset-of-contract`
 * （scripts/backend-tests.mjs，静态）与 `scripts/smoke.mjs --static` 的契约比对。
 * 核心改名 → 断言红，别再凭记忆写事件名。
 */
export const DROPPABLE_EVENT_TYPES = new Set([
  'message.delta',
  'message.interim',
  'reasoning.delta',
  'thinking.delta',
  'tool.generating',
  'browser.progress',
  'subagent.progress',
  'moa.progress',
  'pet.generate.progress',
  'pet.hatch.progress',
  'preview.restart.progress',
  'session.resume_progress',
  'voice.transcript'
])

export const isDroppableEvent = (event) => DROPPABLE_EVENT_TYPES.has(String(event?.type ?? ''))

export class EventQueue {
  /**
   * @param {{limit?: number, onOverflow?: (info: {dropped: string, size: number,
   *          droppedTotals: {token: number, critical: number}}) => void}} opts
   */
  constructor({ limit = EVENT_QUEUE_LIMIT, onOverflow = null } = {}) {
    if (!Number.isFinite(limit) || limit <= 0) throw new Error(`事件队列上限必须是正数，收到 ${limit}`)
    this.limit = limit
    this.onOverflow = onOverflow
    this._items = []
    this.droppedToken = 0
    this.droppedCritical = 0
    this.evictedToken = 0
  }

  get size() {
    return this._items.length
  }

  /** 丢掉的统计（渲染层用它显示"已丢弃 N 条增量"）。 */
  get stats() {
    return {
      size: this._items.length,
      limit: this.limit,
      droppedToken: this.droppedToken,
      droppedCritical: this.droppedCritical,
      evictedToken: this.evictedToken
    }
  }

  /**
   * 入队。
   * @returns {{accepted: boolean, reason?: string, dropped?: string, evicted?: string}}
   */
  push(event) {
    if (this._items.length < this.limit) {
      this._items.push(event)
      return { accepted: true }
    }
    // 队满：可丢事件直接丢（这是"优先丢 token"的主路径）
    if (isDroppableEvent(event)) {
      this.droppedToken += 1
      this._report('token')
      return { accepted: false, reason: 'queue-full', dropped: 'token' }
    }
    // 关键事件必须进队：先挤掉最老的可丢事件
    const victim = this._items.findIndex((item) => isDroppableEvent(item))
    if (victim >= 0) {
      this._items.splice(victim, 1)
      this._items.push(event)
      this.evictedToken += 1
      this._report('token')
      return { accepted: true, evicted: 'token' }
    }
    // 整个队列都是关键事件（极端情况）：仍然保留最新的，丢最老的，但要单独计账
    this._items.shift()
    this._items.push(event)
    this.droppedCritical += 1
    this._report('critical')
    return { accepted: true, evicted: 'critical' }
  }

  /** 取走全部事件（主进程按帧转发给渲染层）。 */
  drain() {
    const out = this._items
    this._items = []
    return out
  }

  clear() {
    this._items = []
  }

  _report(dropped) {
    this.onOverflow?.({ dropped, size: this._items.length, droppedTotals: { token: this.droppedToken, critical: this.droppedCritical } })
  }
}

export class NotificationAggregator {
  /**
   * @param {{windowMs?: number, flush: (merged: any) => void, now?: () => number}} opts
   */
  constructor({ windowMs = NOTIFY_WINDOW_MS, flush, now = () => Date.now() } = {}) {
    if (typeof flush !== 'function') throw new Error('NotificationAggregator 需要 flush 回调')
    this.windowMs = windowMs
    this.flush = flush
    this.now = now
    this._open = new Map()
    this.flushed = 0
  }

  get pending() {
    return this._open.size
  }

  /**
   * 收一条通知事件（形如 gateway 的 {type, sessionId, payload}）。
   * 同一 `type+sessionId` 落进同一个窗口，重复的正文只留计数与首末时间。
   */
  push(event, { key: keyOverride = null } = {}) {
    const type = String(event?.type ?? 'notice')
    const sessionId = event?.sessionId ?? null
    const key = keyOverride ?? `${type}::${sessionId ?? ''}`
    const at = this.now()
    const existing = this._open.get(key)
    if (!existing) {
      const first = event?.payload?.message
      this._open.set(key, {
        key,
        type,
        sessionId,
        count: 1,
        firstAt: at,
        lastAt: at,
        sample: event?.payload ?? null,
        // 合并后的正文列表：第一条也要在（sample 只保留最后一条，messages 用来回放窗口内都说了什么）
        messages: typeof first === 'string' && first ? [first] : []
      })
      return { queued: true, key, count: 1 }
    }
    existing.count += 1
    existing.lastAt = at
    existing.sample = event?.payload ?? existing.sample
    const message = event?.payload?.message
    if (typeof message === 'string' && message && existing.messages.length < 5) existing.messages.push(message)
    return { queued: true, key, count: existing.count }
  }

  /** 把到期的窗口冲出去（主进程用 1s 的定时器调它）。返回冲出的条数。 */
  sweep() {
    const at = this.now()
    let count = 0
    for (const [key, entry] of this._open) {
      if (at - entry.firstAt < this.windowMs) continue
      this._open.delete(key)
      this.flush(this.merge(entry))
      count += 1
      this.flushed += 1
    }
    return count
  }

  /** 不分窗口全部冲出（退出/手动刷新用）。 */
  flushAll() {
    let count = 0
    for (const [key, entry] of this._open) {
      this._open.delete(key)
      this.flush(this.merge(entry))
      count += 1
      this.flushed += 1
    }
    return count
  }

  /** 合并成一条"通知事件"，形状与核心事件一致，渲染层不用改解析逻辑。 */
  merge(entry) {
    const aggregated = {
      count: entry.count,
      firstAt: entry.firstAt,
      lastAt: entry.lastAt,
      windowMs: this.windowMs,
      messages: entry.messages
    }
    const payload =
      entry.sample && typeof entry.sample === 'object'
        ? { ...entry.sample, aggregated }
        : { message: typeof entry.sample === 'string' ? entry.sample : '', aggregated }
    return { type: entry.type, sessionId: entry.sessionId, payload, aggregated: true }
  }
}
