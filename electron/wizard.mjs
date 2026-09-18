/**
 * 首启向导（Sprint-01 T1）的后端能力：环境自检 / 连通性测试 / 完成态门禁。
 *
 * 设计约束：
 *  - 全部是**真实探测**，不做"写死通过"：运行时是否在位看文件系统，连通性必须让核心真去调一次
 *    （`model.save_key` → `/api/model/set` → `model.options` 探测），失败就返回结构化错误码。
 *  - 本文件不依赖 electron，可在无图形环境里被 scripts/backend-tests.mjs 直接单测。
 *  - **失败不写完成态**：只有连通性真的通过，`runConnectionTestWithPrefs` 才会落 `wizard.completedAt`；
 *    主进程还要求"本次启动内至少有一次通过"，光靠前端喊一声 `wizard:complete` 不算。
 */
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { resolveRuntime } from './runtime.js'

/** 向导状态的结构版本：改向导流程就 +1，老用户的完成态会自动失效、重新走一遍。 */
export const WIZARD_SCHEMA_VERSION = 1
/** 单步超时：`model.save_key` 会真的拿 Key 去服务商那边验证（实测 18s+），不能用小超时。 */
export const CONNECTION_TIMEOUT_MS = 45_000
/** 等"模型回复"的超时：连不上服务商时核心可能一直等，给足但不无限等。 */
export const TURN_TIMEOUT_MS = 90_000
/** 连通性测试发的那句话（越短越省钱）。 */
const PROBE_TEXT = '连通性自检：请只回复 ok'
/** 自检里统计运行时体积时最多走多少个文件（防超大目录卡死 UI）。 */
const DIR_SIZE_MAX_ENTRIES = 40_000

/**
 * 首启门禁的**唯一**判据（主进程与渲染层都用它，避免两边各写一套）。
 *
 * 完成态只有一个落点：`ui-prefs.json.wizard.{completedAt, schemaVersion}`，且只能由
 * `wizard:complete` 写（那个通道要求"本次进程真的连通过核心"）。
 * 渲染层早期写过 `onboarding.done` —— 它**不再是判据**：老机器上的那个键会在 PrefsStore
 * 加载时被一次性迁移成 wizard 块（`legacyOnboardingMigration`），迁移后键被摘掉，
 * 所以"两套真相"不会长期共存，也不会因为口径收敛让老用户重走向导。
 *
 * @param {any} data ui-prefs.json 的内容
 */
export function wizardGate(data) {
  const wizard = data && typeof data === 'object' && data.wizard && typeof data.wizard === 'object' ? data.wizard : null
  const base = { completedAt: null, schemaVersion: null, source: null, expectedSchemaVersion: WIZARD_SCHEMA_VERSION }
  if (!wizard?.completedAt) return { ...base, complete: false, reason: 'not-completed' }
  if (wizard.schemaVersion !== WIZARD_SCHEMA_VERSION) {
    return { ...base, complete: false, reason: 'schema-version-mismatch', completedAt: wizard.completedAt, schemaVersion: wizard.schemaVersion ?? null, source: 'wizard' }
  }
  return {
    ...base,
    complete: true,
    reason: 'complete',
    completedAt: wizard.completedAt,
    schemaVersion: wizard.schemaVersion,
    source: 'wizard',
    migratedFrom: typeof wizard.source === 'string' ? wizard.source : null
  }
}

const toMs = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

/**
 * 把老 prefs 里的 `onboarding.done`（14:04 那版渲染层写的完成态）迁移成 wizard 块。
 * 返回 null 表示不用迁移；返回的对象由调用方（PrefsStore）写进 `data.wizard` 并摘掉旧键。
 * @param {any} data ui-prefs.json 的内容
 * @param {{now?: () => number}} [opts]
 */
export function legacyOnboardingMigration(data, { now = () => Date.now() } = {}) {
  if (!data || typeof data !== 'object') return null
  const onboarding = data.onboarding && typeof data.onboarding === 'object' ? data.onboarding : null
  if (onboarding?.done !== true) return null
  const wizard = data.wizard && typeof data.wizard === 'object' ? data.wizard : null
  if (wizard?.completedAt) return null
  return {
    completedAt: toMs(onboarding.doneAt) ?? now(),
    schemaVersion: WIZARD_SCHEMA_VERSION,
    source: 'onboarding-record-migrated',
    migratedAt: now()
  }
}

/**
 * 首启门禁的**决策**（纯函数，主进程与测试共用同一份口径）：
 *  - 已完成 → 放行；
 *  - `HERMES_SKIP_WIZARD_GATE=1`（开发/排障逃生门）→ 放行；
 *  - 向导自己的会话（`payload.onboarding === true`）→ 放行（不然"第一句话"那步自己也建不了会话）；
 *  - 本进程已跑过向导环境自检（`inProgress`，来自 main.js 的 wizardSelfCheckRan）→ 放行；
 *  - 老用户升级（prefs 里已有 lastSessionId，说明之前正常用过）→ 放行（视作已完成，避免升级即失效）；
 *  - 其余 → 拒绝，主进程抛 `EWIZARD_INCOMPLETE`。
 */
export function decideFlowGate({ data, kind = 'session.create', payload = {}, env = process.env, inProgress = false } = {}) {
  const gate = wizardGate(data)
  if (gate.complete) return { allowed: true, reason: 'complete', gate }
  if (env?.HERMES_SKIP_WIZARD_GATE === '1') return { allowed: true, reason: 'env-skip', gate }
  if (kind === 'session.create' && payload?.onboarding === true) return { allowed: true, reason: 'onboarding', gate }
  // 渲染层本次已经跑过向导的环境自检（wizard:selfcheck）——说明它就在向导里，
  // 它建会话是"第一句话"那步（用户可能跳过了模型那步，prefs 里未必有东西）
  if (inProgress) return { allowed: true, reason: 'onboarding-in-progress', gate }
  // 这里曾有第二条 `onboarding-in-progress` 网：ui-prefs.onboarding 里有内容（老渲染层写过的 provider）
  // 就放行。它存在的唯一理由是"渲染层自己往 onboarding 里写过东西"，而那个写入点已经删掉
  // （`grep -rn 'onboarding' src/` 只剩只读展示 + PrefsStore 的一次性迁移），
  // 留着它等于给"旧键"留后门 —— 完成态权威必须只有 wizard.completedAt。故本轮删除。
  const legacy = typeof data?.lastSessionId === 'string' && data.lastSessionId.length > 0
  if (legacy) return { allowed: true, reason: 'grandfathered-legacy-install', gate }
  return { allowed: false, reason: gate.reason, gate }
}

/** 通用偏好补丁里不许带 `wizard`：完成态只能走 wizard:complete，不能让前端顺手改掉。 */
export function sanitizePrefsPatch(patch, { allowWizard = false } = {}) {
  if (!patch || typeof patch !== 'object') return {}
  const next = { ...patch }
  if (!allowWizard) delete next.wizard
  return next
}

/**
 * `wizard:complete` 的服务端校验：本次进程里必须已经有过一次成功的连通性测试。
 * （渲染层可能出错、也可能被绕过，写完成态这件事必须由主进程说了算。）
 */
export function assertWizardCompleteAllowed({ data, verifiedInProcess = false }) {
  const gate = wizardGate(data)
  if (gate.complete) return { allowed: true, alreadyComplete: true, gate }
  if (!verifiedInProcess) {
    const err = new Error('不能标记向导完成：本次启动还没有一次通过的核心连通性测试')
    err.code = 'EWIZARD_NO_CONNECTION'
    throw err
  }
  return { allowed: true, alreadyComplete: false, gate }
}

/**
 * 统计目录体积。
 * 优先走系统 `du -sk`（C 实现，几十毫秒）；拿不到就退回 JS 递归（有 maxEntries 上限）。
 * 这一步跑在主进程里，随包运行时有几万个文件，逐个 stat 会把界面卡出白屏。
 */
export function dirSizeSync(dir, { maxEntries = DIR_SIZE_MAX_ENTRIES, spawnSyncFn = spawnSync } = {}) {
  if (process.platform !== 'win32' && typeof spawnSyncFn === 'function') {
    try {
      const res = spawnSyncFn('du', ['-sk', dir], { encoding: 'utf8' })
      if (res?.status === 0) {
        const kb = Number.parseInt(String(res.stdout ?? '').trim().split(/\s+/)[0], 10)
        if (Number.isFinite(kb) && kb >= 0) {
          const bytes = kb * 1024
          return { bytes, files: null, truncated: false, mb: Math.round((bytes / 1024 / 1024) * 10) / 10, source: 'du' }
        }
      }
    } catch {
      /* 没有 du / 被权限拦：退回下面的递归 */
    }
  }
  return walkDirSize(dir, { maxEntries })
}

/** 递归统计目录体积（du 不可用时的兜底；超上限标 truncated）。 */
export function walkDirSize(dir, { maxEntries = DIR_SIZE_MAX_ENTRIES } = {}) {
  let bytes = 0
  let files = 0
  let truncated = false
  const walk = (current) => {
    if (truncated) return
    let entries = []
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (files >= maxEntries) {
        truncated = true
        return
      }
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        try {
          const st = fs.statSync(full)
          if (st.isFile()) {
            bytes += st.size
            files += 1
          }
        } catch {
          /* 断链的软链接等，忽略 */
        }
      }
    }
  }
  walk(dir)
  return { bytes, files, truncated, mb: Math.round((bytes / 1024 / 1024) * 10) / 10, source: 'walk' }
}

/** PATH 上能不能找到某个可执行文件（没有随包运行时时用它兜底判断）。 */
export function findOnPath(cmd, env = process.env) {
  const dirs = String(env.PATH || '').split(path.delimiter).filter(Boolean)
  const names = process.platform === 'win32' ? [`${cmd}.exe`, `${cmd}.cmd`, cmd] : [cmd]
  for (const dir of dirs) {
    for (const name of names) {
      const full = path.join(dir, name)
      try {
        if (fs.existsSync(full) && fs.statSync(full).isFile()) return full
      } catch {
        /* 忽略不可读目录 */
      }
    }
  }
  return null
}

/** 探针文件：确认目录真的可写（只 stat 不算数）。 */
function probeWritable(dir) {
  const probe = path.join(dir, `.24h-write-probe-${process.pid}`)
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(probe, 'ok', 'utf8')
    fs.unlinkSync(probe)
    return { ok: true, detail: dir }
  } catch (err) {
    return { ok: false, detail: `${dir}：${err.message}` }
  }
}

/** 回环端口能否绑定（核心默认 `--port 0` 也要在回环上开监听）。 */
function probeLoopback() {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', (err) => resolve({ ok: false, detail: `127.0.0.1 绑定失败：${err.message}` }))
    server.listen(0, '127.0.0.1', () => {
      const port = server.address()?.port
      server.close(() => resolve({ ok: true, detail: `127.0.0.1 可绑定（临时端口 ${port}）` }))
    })
  })
}

/**
 * 环境自检：向导第一步用。返回 {ok, checks[]}，每条 check 带 `blocking` 标记，
 * `ok` 只看 blocking 项 —— 例如"PATH 上没有随包运行时清单"不阻塞，但"根本找不到运行时"阻塞。
 */
export async function selfCheck({
  appRoot,
  resourcesPath = null,
  pinnedRoot = null,
  hermesHome = null,
  userDataDir = null,
  env = process.env,
  resolveRuntimeFn = resolveRuntime,
  spawnSyncFn = spawnSync,
  dirSizeFn = dirSizeSync,
  now = () => Date.now()
} = {}) {
  const checks = []
  const add = (check) => checks.push({ blocking: true, ...check })
  const resolved = resolveRuntimeFn({ appRoot, resourcesPath, pinnedRoot })
  const root = resolved?.root ?? null
  const bundledLayout = Boolean(root) && (resolved.kind === 'bundled' || resolved.kind === 'python')
  const pathBinary = resolved?.kind === 'path' ? findOnPath(resolved.cmd, env) : null

  add({
    id: 'runtime.resolved',
    label: '解析运行时',
    ok: Boolean(resolved?.cmd),
    detail: resolved?.kind === 'path' ? `PATH 上的 ${resolved.cmd}` : `${resolved?.label ?? resolved?.kind}：${root ?? resolved?.cmd}`
  })

  let size = null
  let manifest = null
  if (bundledLayout) {
    size = dirSizeFn(root)
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(root, '.24h-os-runtime.json'), 'utf8'))
    } catch {
      manifest = null
    }
  }
  add({
    id: 'runtime.bundled',
    label: '随包运行时在位',
    ok: bundledLayout,
    // 没有随包运行时、但 PATH 上有 hermes 时不阻塞（开发机常见）；两者都没有就必须拦住
    blocking: !pathBinary,
    detail: bundledLayout
      ? `${root}（${size?.mb ?? '?'} MB${size?.truncated ? '，已截断统计' : ''}）`
      : pathBinary
        ? `未随包，使用 ${pathBinary}`
        : '既没有 runtime/ 目录，PATH 上也没有 hermes'
  })

  add({
    id: 'runtime.manifest',
    label: '运行时清单',
    ok: Boolean(manifest?.coreVersion),
    blocking: false,
    detail: manifest?.coreVersion
      ? `core ${manifest.coreVersion}${manifest.builtAt ? `（构建于 ${manifest.builtAt}）` : ''}`
      : bundledLayout
        ? '缺 .24h-os-runtime.json（不影响启动，仅诊断信息少一项）'
        : '跳过（未使用随包运行时）'
  })

  if (bundledLayout || pathBinary) {
    const python = resolved.kind === 'path' ? pathBinary : resolved.cmd
    const probe = spawnSyncFn(python, ['-V'], { encoding: 'utf8' })
    add({
      id: 'runtime.python',
      label: '解释器可执行',
      ok: probe?.status === 0,
      blocking: false,
      detail: probe?.status === 0 ? String(probe.stdout || probe.stderr).trim() : `${python} 执行失败：${probe?.error?.message ?? `exit ${probe?.status}`}`
    })
  } else {
    add({ id: 'runtime.python', label: '解释器可执行', ok: false, blocking: false, detail: '跳过：没有可用的运行时' })
  }

  const home = probeWritable(hermesHome || path.join(userDataDir || appRoot || process.cwd(), 'hermes'))
  add({ id: 'home.writable', label: '核心数据目录可写', ok: home.ok, detail: home.detail })

  if (userDataDir) {
    const prefs = probeWritable(userDataDir)
    add({ id: 'prefs.writable', label: '壳偏好目录可写', ok: prefs.ok, detail: prefs.detail })
  } else {
    add({ id: 'prefs.writable', label: '壳偏好目录可写', ok: false, blocking: true, detail: '未提供 userDataDir，无法确认' })
  }

  const loopback = await probeLoopback()
  add({ id: 'loopback.bind', label: '回环端口可用', ok: loopback.ok, detail: loopback.detail })

  const blockingFailed = checks.filter((c) => c.blocking && !c.ok)
  return {
    ok: blockingFailed.length === 0,
    checks,
    blockingFailed: blockingFailed.map((c) => c.id),
    resolved: {
      kind: resolved?.kind ?? null,
      root,
      cmd: resolved?.cmd ?? null,
      label: resolved?.label ?? null,
      bundledPresent: bundledLayout,
      pathBinary
    },
    bundled: { present: bundledLayout, root, sizeMb: size?.mb ?? null, coreVersion: manifest?.coreVersion ?? null },
    generatedAt: now()
  }
}

/** 给结果补一句人话：成功/失败都带 `message`，渲染层不用自己拼文案。 */
function withMessage(result) {
  if (result.ok) {
    return {
      ...result,
      message: `核心连通：模型回了「${String(result.reply ?? '').slice(0, 40)}」（${result.provider}${result.model ? ` · ${result.model}` : ''}，${result.latencyMs}ms）`,
      detail: result.source
    }
  }
  const human = {
    // 只有"模型真的回了一句话"才算通过：authenticated=true 只代表本地存了 Key（实测假 Key 也是 true）
    provider_error: '模型没有给出回复（Key 无效、余额不足或连不上服务商）',
    timeout: '核心在超时时间内没有回复（网络或服务商无响应）',
    unknown_provider: '核心目录里没有这个服务商',
    missing_provider: '没有指定服务商',
    no_client: '核心通道还没就绪',
    no_event_channel: '事件通道不可用，无法确认模型回话',
    core_error: '核心返回的数据不完整',
    http_401: 'Key 被服务商拒绝（401）',
    http_403: 'Key 没有权限（403）'
  }[result.errorCode]
  return { ...result, message: human ?? `连通性测试失败：${result.error ?? result.errorCode}`, detail: result.error ?? null }
}

/** 给任何 promise 套一个超时（核心探测服务商可能长时间无响应，不能把 UI 挂死）。 */
export function withTimeout(promise, ms, label = '操作') {
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_resolve, reject) => {
      const timer = setTimeout(() => {
        const err = new Error(`${label}超时（${Math.round(ms / 1000)}s）`)
        err.code = 'client_timeout'
        reject(err)
      }, ms)
      timer.unref?.()
    })
  ])
}

export function classifyProbeError(err) {
  const message = String(err?.message ?? err ?? '')
  if (err?.code === 'client_timeout' || /超时|timeout/i.test(message)) return 'timeout'
  const httpStatus = Number(err?.status ?? err?.httpStatus ?? /HTTP (\d{3})/.exec(message)?.[1])
  if (Number.isFinite(httpStatus) && httpStatus >= 400) return `http_${httpStatus}`
  if (err?.code === 4002) return 'unknown_provider'
  return 'error'
}

/**
 * 等一轮对话的结束信号（`message.complete` 或 `error`）。
 * 只认"有正文且不是 error 收尾"的回合 —— 未配模型/Key 无效时 0.21.x 会以
 * `message.complete(status=error)` 或 `error` 帧收尾，那**不算连通**。
 */
function collectTurn(subscribe, sessionId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false
    let unsubscribe = null
    const finish = (value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        unsubscribe?.()
      } catch {
        /* 退订失败无所谓 */
      }
      resolve(value)
    }
    const timer = setTimeout(
      () => finish({ ok: false, errorCode: 'timeout', error: `${Math.round(timeoutMs / 1000)}s 内没有等到模型回复` }),
      timeoutMs
    )
    timer.unref?.()
    unsubscribe = subscribe((evt) => {
      if (!evt) return
      // 事件带 session_id 时必须对得上；不带（部分 error 帧）就当作和本次测试相关
      if (evt.sessionId && sessionId && evt.sessionId !== sessionId) return
      if (evt.type === 'message.complete') {
        const text = String(evt.payload?.text ?? '')
        if (evt.payload?.status === 'error' || !text.trim()) {
          return finish({
            ok: false,
            errorCode: 'provider_error',
            error: String(evt.payload?.message ?? evt.payload?.error ?? '模型这一轮没有给出正文')
          })
        }
        return finish({ ok: true, text, model: evt.payload?.model ?? null })
      }
      if (evt.type === 'error') {
        return finish({ ok: false, errorCode: 'provider_error', error: String(evt.payload?.message ?? '核心报错') })
      }
    })
  })
}

/**
 * 连通性测试（向导第二步）：**真调核心**——
 *   存 Key → 设为当前模型 → 建一个临时会话 → 发一句话 → 等模型真的回话 → 关掉会话。
 *
 * 为什么要跑一轮对话，而不是看服务商目录里的 `authenticated`：
 * 实测（core 0.21.3）**随便填一个假 Key 也会让 `authenticated` 变成 true** ——
 * 它只代表"本地存了 Key"。只有模型真的答出一句话，才算连通。
 *
 * @returns {Promise<{ok: boolean, latencyMs: number, provider: string, model: string|null,
 *                    reply: string|null, errorCode: string|null, error: string|null,
 *                    message: string, steps: string[]}>}
 */
export async function probeConnection({
  provider,
  model = null,
  apiKey = null,
  call, // WS JSON-RPC
  request, // REST
  subscribe = null, // (fn) => unsubscribe：拿核心事件流（等模型回复必须靠它）
  keyTimeoutMs = CONNECTION_TIMEOUT_MS,
  turnTimeoutMs = TURN_TIMEOUT_MS,
  now = () => Date.now()
} = {}) {
  const startedAt = now()
  const steps = []
  let sessionId = null
  const fail = (errorCode, error) =>
    withMessage({
      ok: false,
      latencyMs: now() - startedAt,
      provider: provider ?? null,
      model: model ?? null,
      reply: null,
      errorCode,
      error,
      steps,
      source: null
    })

  if (!provider) return fail('missing_provider', '没有指定服务商')
  if (typeof call !== 'function' || typeof request !== 'function') return fail('no_client', '核心通道未就绪')

  try {
    if (apiKey) {
      // 参数名必须是 slug（写成 provider 会被严格契约拒绝：实机踩过）
      await withTimeout(call('model.save_key', { slug: provider, api_key: apiKey }), keyTimeoutMs, '保存 Key ')
      steps.push('model.save_key')
    }
    if (model) {
      await withTimeout(request('POST', '/api/model/set', { scope: 'main', provider, model }), keyTimeoutMs, '设置模型 ')
      steps.push('model/set')
    }

    const created = await withTimeout(call('session.create', { cols: 100, title: '连通性自检' }), keyTimeoutMs, '建会话 ')
    sessionId = created?.session_id ?? created?.sessionId ?? null
    steps.push('session.create')
    if (!sessionId) return fail('core_error', '核心建会话没有返回 session_id')
    if (typeof subscribe !== 'function') return fail('no_event_channel', '没有事件通道，无法确认模型是否回话')

    const waitTurn = collectTurn(subscribe, sessionId, turnTimeoutMs)
    await withTimeout(call('prompt.submit', { session_id: sessionId, text: PROBE_TEXT }), keyTimeoutMs, '发送测试消息 ')
    steps.push('prompt.submit')

    const turn = await waitTurn
    if (!turn.ok) return fail(turn.errorCode ?? 'provider_error', turn.error)
    return withMessage({
      ok: true,
      latencyMs: now() - startedAt,
      provider,
      model: turn.model ?? model ?? null,
      reply: String(turn.text).slice(0, 200),
      errorCode: null,
      error: null,
      steps,
      source: 'turn'
    })
  } catch (err) {
    return fail(classifyProbeError(err), err.message || String(err))
  } finally {
    // 临时会话要收掉：不然每点一次"测试连接"都会在核心活跃集合里留一个会话
    if (sessionId) {
      try {
        await call('session.close', { session_id: sessionId })
        steps.push('session.close')
      } catch {
        /* 关不掉就算了：核心重启时会自己清 */
      }
    }
  }
}

/**
 * 向导第二步的完整动作：测 → 记证据 → **只有通过才**落完成态。
 * 失败时 `prefs` 里的 `wizard.completedAt` 一定不存在（断言 wizard.connection.failure-keeps-incomplete）。
 */
export async function runConnectionTestWithPrefs({ prefs, ...probeArgs } = {}) {
  const result = await probeConnection(probeArgs)
  if (prefs) {
    prefs.recordConnectionTest(result)
    if (result.ok) {
      prefs.markWizardComplete({
        connection: { provider: result.provider, model: result.model, latencyMs: result.latencyMs, source: result.source }
      })
      prefs.flush() // 完成态是关键状态，不等节流
    }
  }
  return result
}
