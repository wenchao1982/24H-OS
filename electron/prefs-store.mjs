/**
 * 壳侧偏好存储：`<userData>/ui-prefs.json`（主题、运行时目录、向导完成态、会话草稿）。
 *
 * 为什么不引 SQLite：当前壳没有 DB 层，引进来等于换架构；这里的数据量是"几十条草稿"级别，
 * 一个 JSON 文件 + 原子写足够，也便于用户手工备份/排障。
 *
 * 三条硬约定（都能在 scripts/backend-tests.mjs 里被断言钉住）：
 *  1. **原子写**：先写 `<file>.<pid>.<seq>.tmp`，fsync 后再 rename 覆盖。
 *     读的人要么看到旧的完整内容，要么看到新的完整内容，永远不会读到半截 JSON；
 *     断电/强杀最多丢掉最后一次还没落盘的修改。加载时会清掉上次崩死留下的 `.tmp`。
 *  2. **节流合并**：默认 500ms 内的多次修改合并成一次写盘（输入框每敲一个字都写盘没必要）；
 *     关键路径（向导完成态、切换运行时、退出前）用 `flush()` 立刻落盘。
 *  3. **草稿有上限**：超过 LRU 上限时淘汰最久未更新的会话，避免草稿把文件撑大。
 */
import fs from 'node:fs'
import path from 'node:path'
import { WIZARD_SCHEMA_VERSION, legacyOnboardingMigration, wizardGate } from './wizard.mjs'

export const DEFAULT_THROTTLE_MS = 500
export const DEFAULT_DRAFT_LIMIT = 200
export const DEFAULT_DRAFT_MAX_CHARS = 20000

const clone = (value) => (value == null ? value : JSON.parse(JSON.stringify(value)))

export class PrefsStore {
  /**
   * @param {{file: string, throttleMs?: number, draftLimit?: number, draftMaxChars?: number,
   *          now?: () => number, logger?: (msg: string) => void}} opts
   */
  constructor({
    file,
    throttleMs = DEFAULT_THROTTLE_MS,
    draftLimit = DEFAULT_DRAFT_LIMIT,
    draftMaxChars = DEFAULT_DRAFT_MAX_CHARS,
    now = () => Date.now(),
    logger = () => {}
  } = {}) {
    if (!file) throw new Error('PrefsStore 需要 file（ui-prefs.json 的绝对路径）')
    this.file = file
    this.throttleMs = throttleMs
    this.draftLimit = draftLimit
    this.draftMaxChars = draftMaxChars
    this.now = now
    this.logger = logger
    this._data = null
    this._timer = null
    this._seq = 0
    this.writes = 0
    this.evictions = 0
    this.recoveredTemps = 0
    this.migratedOnboarding = false
  }

  // ── 读写基本盘 ─────────────────────────────────────────────────────────
  /** 内存视图（延迟加载磁盘）。调用方拿到的是副本，改它不会影响存储。 */
  snapshot() {
    return clone(this._load())
  }

  /** 浅合并补丁。`wizard` 字段默认拒绝：完成态只能由 wizard:complete 写（见 wizard.mjs）。 */
  patch(patch, { allowWizard = false } = {}) {
    const data = this._load()
    if (!patch || typeof patch !== 'object') return clone(data)
    const next = { ...patch }
    if (!allowWizard) delete next.wizard
    Object.assign(data, next)
    // 渲染层也往这个文件写草稿（键名同为 drafts，但字段是 { text, at }）；这里统一做一次 LRU，
    // 保证"草稿不会把 ui-prefs.json 撑大"这条约束与写入路径无关。
    if (data.drafts && typeof data.drafts === 'object') this._evictDrafts(data.drafts)
    this._touch()
    return clone(data)
  }

  /** 立刻落盘（不等节流）。关键状态变更后调用。 */
  flush() {
    if (this._timer) {
      clearTimeout(this._timer)
      this._timer = null
    }
    this._writeNow()
  }

  /** 退出前调用：把待写内容落盘并停止定时器。 */
  dispose() {
    try {
      this.flush()
    } catch (err) {
      this.logger(`[prefs] 退出前落盘失败：${err.message}`)
    }
  }

  // ── 草稿（输入保护）─────────────────────────────────────────────────────
  /** 写入/更新某个会话的草稿；文本为空则视为清空。返回落盘后的草稿条目（清空时为 null）。 */
  setDraft(sessionId, draft = {}) {
    const id = String(sessionId || '')
    if (!id) throw new Error('草稿需要 sessionId')
    const data = this._load()
    if (!data.drafts || typeof data.drafts !== 'object') data.drafts = {}
    const raw = typeof draft === 'string' ? { text: draft } : draft || {}
    let text = String(raw.text ?? '')
    const truncated = text.length > this.draftMaxChars
    if (truncated) text = text.slice(0, this.draftMaxChars)
    if (!text.trim()) {
      delete data.drafts[id]
      this._touch()
      return null
    }
    data.drafts[id] = {
      text,
      truncated,
      model: raw.model ?? null,
      cwd: raw.cwd ?? null,
      updatedAt: this.now()
    }
    this._evictDrafts(data.drafts)
    this._touch()
    return clone(data.drafts[id])
  }

  getDraft(sessionId) {
    const drafts = this._load().drafts
    return drafts && drafts[String(sessionId || '')] ? clone(drafts[String(sessionId)]) : null
  }

  /** 草稿箱：按最近更新倒序。 */
  listDrafts() {
    const drafts = this._load().drafts ?? {}
    return Object.entries(drafts)
      .map(([sessionId, entry]) => ({ sessionId, ...clone(entry) }))
      .sort((a, b) => (b.updatedAt ?? b.at ?? 0) - (a.updatedAt ?? a.at ?? 0))
  }

  clearDraft(sessionId) {
    const data = this._load()
    const id = String(sessionId || '')
    const had = Boolean(data.drafts && data.drafts[id])
    if (had) {
      delete data.drafts[id]
      this._touch()
    }
    return had
  }

  // ── 上次活跃会话（核心崩溃重连后要恢复它）───────────────────────────────
  noteSession(sessionId) {
    const id = String(sessionId || '')
    if (!id) return null
    const data = this._load()
    data.lastSessionId = id
    data.lastSessionAt = this.now()
    this._touch()
    return id
  }

  lastSessionId() {
    const id = this._load().lastSessionId
    return typeof id === 'string' && id ? id : null
  }

  // ── 向导（首启）───────────────────────────────────────────────────────
  wizard() {
    const w = this._load().wizard
    return w && typeof w === 'object' ? clone(w) : null
  }

  /** 首启门禁：只有 completedAt 且 schemaVersion 匹配才算"走过向导"。 */
  wizardGate() {
    return wizardGate(this._load())
  }

  /** 记录一次连通性测试结果（证据留痕，但**不**等于完成向导）。 */
  recordConnectionTest(result) {
    const data = this._load()
    data.wizard = {
      ...(data.wizard && typeof data.wizard === 'object' ? data.wizard : {}),
      lastConnectionTest: {
        ok: Boolean(result?.ok),
        provider: result?.provider ?? null,
        model: result?.model ?? null,
        latencyMs: result?.latencyMs ?? null,
        errorCode: result?.errorCode ?? null,
        error: result?.error ?? null,
        at: this.now()
      }
    }
    this._touch()
    return clone(data.wizard)
  }

  markWizardComplete({
    connection = null,
    at = this.now(),
    schemaVersion = WIZARD_SCHEMA_VERSION
  } = {}) {
    const data = this._load()
    const prev = data.wizard && typeof data.wizard === 'object' ? data.wizard : {}
    data.wizard = {
      ...prev,
      completedAt: at,
      schemaVersion,
      connection: connection ? clone(connection) : prev.connection ?? null
    }
    this._touch()
    return clone(data.wizard)
  }

  resetWizard() {
    const data = this._load()
    delete data.wizard
    this._touch()
    return null
  }

  // ── 内部：加载 / 原子写 / 淘汰 ─────────────────────────────────────────
  _load() {
    if (this._data) return this._data
    let parsed = null
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch {
      parsed = null
    }
    this._data = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    this._sweepTemps() // 上次崩死留下的 .tmp 不参与解析，顺手清掉
    this._migrateLegacyOnboarding()
    return this._data
  }

  /**
   * 完成态口径收敛（一次性迁移）：老渲染层写的 `ui-prefs.onboarding.done` → `wizard.completedAt`。
   * 迁移后**摘掉**旧键，这样 `wizard:reset`（重走向导）之后不会再被旧键"复活"成已完成。
   */
  _migrateLegacyOnboarding() {
    const patch = legacyOnboardingMigration(this._data, { now: this.now })
    if (!patch) return
    this._data.wizard = { ...(this._data.wizard ?? {}), ...patch }
    const onboarding = { ...(this._data.onboarding ?? {}) }
    delete onboarding.done
    delete onboarding.doneAt
    this._data.onboarding = onboarding
    this.migratedOnboarding = true
    this.logger('[prefs] 完成态口径收敛：onboarding.done → wizard.completedAt（迁移一次，旧键已摘）')
    this._touch()
  }

  _touch() {
    if (this.throttleMs <= 0) {
      this._writeNow()
      return
    }
    if (this._timer) return
    this._timer = setTimeout(() => {
      this._timer = null
      try {
        this._writeNow()
      } catch (err) {
        this.logger(`[prefs] 写盘失败：${err.message}`)
      }
    }, this.throttleMs)
    this._timer.unref?.()
  }

  _writeNow() {
    const data = this._load()
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.${++this._seq}.tmp`
    const json = JSON.stringify(data, null, 2) + '\n'
    const fd = fs.openSync(tmp, 'w')
    try {
      fs.writeFileSync(fd, json)
      fs.fsyncSync(fd) // rename 之前把内容刷到盘上，避免"文件在、内容是空的"
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(tmp, this.file) // 原子替换：读的人不会看到半截 JSON
    this.writes += 1
    this._sweepTemps()
  }

  /** 清掉 `<ui-prefs.json>.<pid>.<seq>.tmp` 残留（崩溃/断电时留下的半成品）。 */
  _sweepTemps() {
    const dir = path.dirname(this.file)
    const base = path.basename(this.file)
    let names = []
    try {
      names = fs.readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (name === base || !name.startsWith(`${base}.`) || !name.endsWith('.tmp')) continue
      try {
        fs.unlinkSync(path.join(dir, name))
        this.recoveredTemps += 1
      } catch {
        /* 删不掉就算了：下次还能清 */
      }
    }
  }

  /** LRU：超过上限时淘汰最久未更新的草稿。 */
  _evictDrafts(drafts) {
    const ids = Object.keys(drafts)
    if (ids.length <= this.draftLimit) return
    const byAge = ids.sort((a, b) => (drafts[a]?.updatedAt ?? drafts[a]?.at ?? 0) - (drafts[b]?.updatedAt ?? drafts[b]?.at ?? 0))
    while (byAge.length > this.draftLimit) {
      const victim = byAge.shift()
      delete drafts[victim]
      this.evictions += 1
    }
  }
}
