#!/usr/bin/env node
/**
 * 无界面冒烟测试：走壳真正使用的两个模块（runtime.js + gateway.js），
 * 覆盖「启动核心 → 取 token → WS 连接 → 会话 → 发消息 → 事件流 → 关闭」。
 *
 *   HERMES_RUNTIME_PYTHON=/path/to/venv/bin/python npm run smoke
 *
 * 说明：本机没有图形环境，所以 GUI 部分测不了；这个脚本保证"壳与核心的协议层"是通的。
 * 没有配置模型 key 时，prompt.submit 会以 message.complete(status=error) 结束 —— 这属预期，
 * 说明通路正常（能收到完整事件序列）。
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Gateway } from '../electron/gateway.js'
import { callWithSessionRemap } from '../electron/session-remap.mjs'
import { Runtime } from '../electron/runtime.js'

/** 跨平台临时目录：Windows 上 '/tmp' 会被解析成 C:\tmp（多半不存在），必须用系统临时目录 */
const TMP = os.tmpdir()

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

// ── 起步前的静态护栏（这类问题不会在协议层暴露，但会让界面完全空白）────────────
{
  const root = path.resolve(import.meta.dirname, '..')
  const preload = path.join(root, 'electron', 'preload.cjs')
  const mainJs = readFileSync(path.join(root, 'electron', 'main.js'), 'utf8')
  const preloadSrc = existsSync(preload) ? readFileSync(preload, 'utf8') : ''
  check(
    'preload 是 CommonJS 的 preload.cjs，且被 main.js 引用',
    existsSync(preload) && /preload\.cjs/.test(mainJs),
    existsSync(preload) ? 'preload.cjs 存在' : '缺 electron/preload.cjs'
  )
  check(
    'preload 内没有 ESM import（Electron 按 CJS 加载 preload）',
    preloadSrc.length > 0 && !/^\s*import\s/m.test(preloadSrc),
    /^\s*import\s/m.test(preloadSrc) ? '发现 import —— 会加载失败' : '仅 require'
  )

  // CSP 是 style-src 'self'，任何内联 style 属性/赋值都会被拦（DevTools 里报
  // "Applying inline style violates ... Content Security Policy"），所以样式必须走类名。
  const html = readFileSync(path.join(root, 'src', 'index.html'), 'utf8')
  const rendererSrc = readFileSync(path.join(root, 'src', 'renderer.js'), 'utf8')
  check('index.html 无内联 style 属性（CSP style-src self）', !/style\s*=/.test(html), /style\s*=/.test(html) ? '发现 style= 属性' : '干净')
  check('renderer.js 不写内联样式', !/\.style\.(cssText|setProperty)|setAttribute\(['\"]style/.test(rendererSrc), '仅通过 className 控制样式')

  // 界面「没反应 / 关不掉」这类问题同样测不出来于协议层：
  //  ① 作者样式的 display 会盖掉 UA 的 [hidden]{display:none} → 带 hidden 的元素其实一直显示
  //  ② 窗口通常比核心先就绪，初始化只挂在 boot() 上的话，模型/会话列表会永远空着
  const cssSrc = readFileSync(path.join(root, 'src', 'styles.css'), 'utf8')
  const hiddenOk = /\[hidden\][^{]*\{[^}]*display\s*:\s*none/.test(cssSrc)
  check('styles.css 让 hidden 真的隐藏', hiddenOk, hiddenOk ? '有 [hidden] 显示规则' : '缺 [hidden] 规则：设置弹层会一直显示且关不掉')
  const closers = ['btn-close-settings-x', 'btn-close-settings', "e.key === 'Escape'"].filter((k) => html.includes(k) || rendererSrc.includes(k))
  check('设置弹层有四个关闭入口（✕ / 关闭 / Esc / 点底色）', closers.length >= 3, `命中 ${closers.length} 个`)
  const lateReady = /onReady\([\s\S]{0,240}afterCoreReady/.test(rendererSrc)
  check('核心晚就绪也会补跑首屏加载', lateReady, lateReady ? 'onReady → afterCoreReady' : 'onReady 没接初始化：模型/会话列表会一直空着')
  const iconCss = /\.entry\.dir \.ico::before/.test(cssSrc) && /\.entry\.file \.ico::before/.test(cssSrc)
  check('文件图标用 CSS 画（不依赖 emoji 字体）', iconCss, iconCss ? '有 .entry.dir/.file 图标规则' : '缺 CSS 图标规则，会退回 emoji')
  const richSrc = /function renderRich/.test(rendererSrc) && /\.md-table/.test(cssSrc)
  check('助手回复走 Markdown 渲染', richSrc, richSrc ? 'renderRich + .md-* 样式齐' : '缺 renderRich 或 .md-* 样式：回复会显示裸 Markdown')
  // 不带 include_unconfigured=1 的话，全新安装只会拿到 moa/opencode-free 这类虚拟项，
  // 用户一填 key 就是 4002 unknown provider（实机踩过）
  // 契约比对：我们调用的每个方法/事件，核心都声明过吗？（防"名字写错/核心升级改名"）
  const contractFile = path.join(root, 'electron', 'contract.generated.json')
  if (existsSync(contractFile)) {
    const contract = JSON.parse(readFileSync(contractFile, 'utf8'))
    const known = new Set(Object.keys(contract.methods ?? {}))
    const usedMethods = [...mainJs.matchAll(/gwCall\('([^']+)'\)/g)].map((m) => m[1])
    const missingMethods = [...new Set(usedMethods)].filter((m) => !known.has(m))
    check(
      `壳调用的 gateway 方法与核心契约一致（契约核心 ${contract.coreVersion ?? '?'}，${known.size} 个方法）`,
      missingMethods.length === 0,
      missingMethods.length ? `核心没声明：${missingMethods.join(', ')}` : `用到 ${new Set(usedMethods).size} 个，全部命中`
    )
    const knownEvents = new Set(contract.events ?? [])
    const usedEvents = [...rendererSrc.matchAll(/case '([a-z][a-z._]+)':/g)].map((m) => m[1])
    const missingEvents = [...new Set(usedEvents)].filter((e) => !knownEvents.has(e))
    check(
      '渲染层处理的事件都在核心契约里',
      missingEvents.length === 0,
      missingEvents.length ? `核心没声明：${missingEvents.join(', ')}` : `处理 ${new Set(usedEvents).size} 个事件，全部命中`
    )
  } else {
    check('契约快照存在（node scripts/gen-contract.mjs 生成）', false, '缺 electron/contract.generated.json')
  }

  // 平台标识一致性（Windows 上"产出的目录名"必须等于"下载器找的目录名"，否则下载 404）
  {
    const { platformKey, platformCompatible } = await import('./lib/platform.mjs')
    const cases = [
      [platformKey('win32', 'x64') === 'win-x64', 'platformKey(win32,x64) = win-x64'],
      [platformKey('linux', 'x64') === 'linux-x64', 'platformKey(linux,x64) = linux-x64'],
      [platformCompatible('win32', 'win-x64') === true, 'win32 与 win-x64 视为兼容'],
      [platformCompatible('linux-x64', 'win-x64') === false, 'linux-x64 与 win-x64 不兼容'],
      [platformCompatible('win-x64', 'win-arm64') === false, 'x64 与 arm64 不兼容']
    ]
    const bad = cases.filter(([ok]) => !ok).map(([, name]) => name)
    check('平台标识与兼容性判断正确（资产目录/护栏靠它）', bad.length === 0, bad.length ? `失败：${bad.join('；')}` : `${cases.length} 条断言通过`)
  }

  const pkgJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  const updaterDep = Boolean(pkgJson.dependencies?.['electron-updater'])
  check('壳自更新依赖已声明（electron-updater）', updaterDep, updaterDep ? '在 dependencies 里' : 'package.json 的 dependencies 缺 electron-updater')

  const sweepOk = existsSync(path.join(root, 'electron', 'orphan-sweep.mjs')) && /sweepOrphanCores\(/.test(mainJs)
  check('启动前会回收孤儿核心（壳被强杀后的残留）', sweepOk, sweepOk ? 'orphan-sweep.mjs 已被调用' : '缺 orphan-sweep 或 main.js 未调用')

  const catalogOk = /include_unconfigured=1/.test(mainJs)
  check('模型目录带 include_unconfigured=1（否则只能看到虚拟 provider）', catalogOk, catalogOk ? '已带' : '缺：设置页会列出 moa 这类不能填 key 的项')
}

// 核心 home 隔离：这条链路会真的写配置（model.save_key 会覆盖 key、还会写自定义端点），
// 默认必须落在临时目录里，绝不碰用户自己的 ~/.hermes。要用真实 home 就显式传 HERMES_HOME=。
const hermesHome = process.env.HERMES_HOME || mkdtempSync(path.join(TMP, '24h-os-smoke-home-'))
console.log(`核心 home：${hermesHome}${process.env.HERMES_HOME ? '（来自 HERMES_HOME）' : '（临时，跑完可删）'}`)

// `npm run smoke -- --static`：只跑静态护栏（CI 的 Linux 容器里没有随包运行时，也能跑这一段）
if (process.argv.includes('--static')) {
  const failedStatic = results.filter((r) => !r.ok)
  console.log(`\n静态护栏 ${results.length - failedStatic.length}/${results.length} 通过（已跳过需要核心的部分）`)
  if (failedStatic.length) {
    console.error('失败项：', failedStatic.map((f) => f.name).join('、'))
    process.exit(1)
  }
  process.exit(0)
}

const runtime = new Runtime({
  appRoot: path.resolve(import.meta.dirname, '..'),
  hermesHome,
  onLog: () => {}
})

let gateway = null
try {
  const port = await runtime.start()
  check('核心启动并就绪（解析 HERMES_BACKEND_READY）', Number.isInteger(port), `port=${port}`)

  const health = await runtime.health()
  check('健康检查 /api/health', health?.ok === true, `version=${health?.version} auth_required=${health?.auth_required}`)

  const token = await runtime.sessionToken()
  check('取到会话 token（/ 的内联注入）', typeof token === 'string' && token.length > 0, token ? `${token.slice(0, 8)}…` : '无')

  gateway = new Gateway({ baseUrl: runtime.baseUrl, token, log: () => {} })
  const events = []
  gateway.on('event', (e) => events.push(e))
  await gateway.connect()
  check('WS /api/ws 已连接', true)

  // 单个调用超时（默认 45s）只算这一项失败，不中止整轮 —— 有些调用会去探测服务商网络，
  // 在国内网络下偶发很慢；整轮中止会让人误以为"通路坏了"。
  const CALL_TIMEOUT_MS = Number(process.env.SMOKE_CALL_TIMEOUT_MS ?? 45000)
  const gcall = (method, params) =>
    Promise.race([
      gateway.call(method, params),
      new Promise((_resolve, reject) =>
        setTimeout(
          () => reject(Object.assign(new Error(`${method} 超时（${CALL_TIMEOUT_MS / 1000}s；可用 SMOKE_CALL_TIMEOUT_MS 调整）`), { code: 'client_timeout' })),
          CALL_TIMEOUT_MS
        )
      )
    ])

  const caps = await gcall('gateway.capabilities')
  check('gateway.capabilities', typeof caps === 'object', JSON.stringify(caps).slice(0, 60))

  const created = await gcall('session.create', { cols: 100, title: 'smoke' })
  const sid = created?.session_id
  check('session.create 返回 session_id', Boolean(sid), `sid=${sid} model=${created?.info?.model}`)

  // 壳的兼容性检查依赖这个字段：session.create 的 info.desktop_contract（实测 0.21.x = 6）
  check(
    'session.create 带 desktop_contract（壳据此做版本对齐）',
    typeof created?.info?.desktop_contract === 'number',
    `desktop_contract=${created?.info?.desktop_contract}`
  )

  // 工作目录：壳的「工作目录」按钮走 session.cwd.set
  const cwdTarget = TMP
  const cwdRes = await gateway
    .call('session.cwd.set', { session_id: sid, cwd: cwdTarget })
    .then((r) => ({ ok: true, cwd: r?.info?.cwd ?? r?.cwd }))
    .catch((e) => ({ ok: false, code: e.code, message: e.message }))
  check('session.cwd.set 设置工作目录', cwdRes.ok, cwdRes.ok ? `cwd=${cwdRes.cwd ?? cwdTarget}` : `code=${cwdRes.code}`)

  // 会话删除/关闭的规则（用独立的临时会话验证，避免影响后面的断言）：
  //   - 活跃会话（在内存里）不能删 → 4023
  //   - 客户端应先 session.close 从活跃集合摘掉
  //   - 只有跑过对话真正落盘的会话才可删（本机无 key，删未落盘会话会得到 4007）
  const throwaway = await gcall('session.create', { cols: 100, title: 'smoke throwaway' })
  const tsid = throwaway.session_id
  const delActive = await gateway
    .call('session.delete', { session_id: tsid })
    .then(() => ({ ok: true }))
    .catch((e) => ({ ok: false, code: e.code }))
  check(
    '活跃会话不可删（4023；4007 表示该会话尚未落盘）',
    delActive.ok === false && (delActive.code === 4023 || delActive.code === 4007),
    `code=${delActive.code}`
  )

  const closeRes = await gateway
    .call('session.close', { session_id: tsid })
    .then((r) => ({ ok: true, closed: r?.closed }))
    .catch((e) => ({ ok: false, code: e.code }))
  check('session.close 关闭会话（从活跃集合摘除）', closeRes.ok && closeRes.closed === true, `closed=${closeRes.closed}`)

  const closeAgain = await gateway
    .call('session.close', { session_id: tsid })
    .then((r) => ({ ok: true, closed: r?.closed }))
    .catch(() => ({ ok: false }))
  check('session.close 幂等（再调用返回 closed=false）', closeAgain.ok && closeAgain.closed === false)

  const list = await gcall('session.list', {})
  check('session.list', Array.isArray(list?.sessions), `${list?.sessions?.length ?? 0} 个会话`)

  const hist = await gcall('session.history', { session_id: sid })
  check('session.history 结构 {count,messages}', Array.isArray(hist?.messages), `count=${hist?.count}`)

  // 注意：WS 的 model.options 只返回"已认证"的服务商，且会去探测服务商（可能长时间卡在网络）。
  // 壳实际用的是 REST 的完整目录（下一段就测它），这里改用 REST 版，既不碰网络也更贴近产品行为。
  let models
  try {
    models = await runtime.request('GET', '/api/model/options?include_unconfigured=1')
  } catch (err) {
    models = { __error: err.message }
  }
  check(
    '服务商目录可读（REST，壳用的就是这个）',
    Array.isArray(models?.providers),
    models?.__error ?? `${models?.providers?.length ?? 0} 个服务商（含未配置）`
  )

  // ── 服务商目录（设置页依赖它）────────────────────────────────────────────
  // 实机踩过：不带 include_unconfigured 时，全新安装只返回 moa/opencode-free 这类虚拟/内置项，
  // 用户选了 moa 再填 key → 4002 unknown provider: moa。这里把两种情况都钉住。
  const plain = await runtime.request('GET', '/api/model/options').catch(() => null)
  const plainSlugs = (plain?.providers ?? []).map((p) => p.slug)
  check(
    '不带 include_unconfigured 时只给"可用项"（这正是当初的坑）',
    !plainSlugs.includes('deepseek'),
    plainSlugs.join(',') || '(空)'
  )
  const catalog = await runtime.request('GET', '/api/model/options?include_unconfigured=1').catch(() => null)
  const keyable = (catalog?.providers ?? []).filter((p) => p.auth_type === 'api_key')
  const ds = keyable.find((p) => /deepseek/i.test(p.slug + ' ' + (p.name ?? '')))
  check(
    '完整目录里有可填 Key 的 DeepSeek（设置页只列这一类）',
    Boolean(ds),
    ds ? `slug=${ds.slug} key_env=${ds.key_env} authenticated=${ds.authenticated}` : `keyable=${keyable.length} 项里没有 deepseek`
  )

  // 发一条消息：观察完整事件序列。未配模型时，0.21.0 以 message.complete(status=error) 收尾，
  // 0.21.3 直接发 error 帧 —— 对壳而言"turn 结束"的信号是两者之一（UI 两条都处理）。
  const submit = await gcall('prompt.submit', { session_id: sid, text: 'smoke test' })
  check('prompt.submit 被接受', submit?.status === 'streaming', JSON.stringify(submit))
  await sleep(6000)

  const types = events.map((e) => e.type)
  const closed = types.includes('message.complete') || types.includes('error')
  check('收到 turn 结束信号（message.complete 或 error）', closed, types.join(', ').slice(0, 140))

  const readable = events.some(
    (e) =>
      (e.type === 'error' && typeof e.payload?.message === 'string' && e.payload.message.length > 0) ||
      (e.type === 'message.complete' && typeof e.payload?.text === 'string' && e.payload.text.length > 0)
  )
  check('未配模型时给出可读错误（而非静默失败）', readable)

  // interrupt 走的是"需要 provider"的路径：未配置模型时核心回 5032 —— 这属于环境未就绪，
  // 不是参数错误（能拿到带码的答复本身说明 RPC 形状被接受）。配置好模型后这里会真正成功。
  const NO_PROVIDER = 5032
  // ── M2：文件面板 / 会话搜索 / 改名 / 删除 ───────────────────────────────
  const fsList = await runtime.request('GET', '/api/fs/list?path=' + encodeURIComponent(TMP))
  check('REST /api/fs/list 列目录', Array.isArray(fsList?.entries), `${fsList?.entries?.length ?? 0} 项`)

  const fixture = path.join(TMP, '24h-os-smoke-file.txt')
  writeFileSync(fixture, 'hello 24H-OS\n')
  const fileRead = await runtime.request('GET', '/api/files/read?path=' + encodeURIComponent(fixture))
  check(
    'REST /api/files/read 读文件（data_url）',
    typeof fileRead?.data_url === 'string' && String(fileRead.data_url).startsWith('data:'),
    `size=${fileRead?.size} mime=${fileRead?.mime_type}`
  )

  const search = await runtime.request('GET', '/api/sessions/search?q=' + encodeURIComponent('smoke'))
  check('REST /api/sessions/search 会话搜索', Array.isArray(search?.results), `${search?.results?.length ?? 0} 条结果`)

  const renamed = await gateway
    .call('session.title', { session_id: sid, title: 'smoke 重命名' })
    .then((r) => ({ ok: true, title: r?.title }))
    .catch((e) => ({ ok: false, message: e.message }))
  check('session.title 改名', renamed.ok, renamed.title ?? renamed.message)

  // ── 设置页的载荷形状（踩过一次：save_key 的参数名写成 provider，被严格契约拒绝）──
  // 判定标准：只要不是「参数校验失败」就算形状正确；模型/key 本身无效（如假 key）不算问题。
  const isSchemaError = (msg) => /invalid params|Extra inputs|Extra inputs are not permitted|validation/i.test(String(msg || ''))

  const saveKey = await gateway
    .call('model.save_key', { slug: 'deepseek', api_key: 'sk-smoke-dummy' })
    .then((r) => ({ ok: true, r }))
    .catch((e) => ({ ok: false, message: e.message, code: e.code }))
  check(
    'model.save_key 载荷形状正确（slug + api_key）',
    saveKey.ok || !isSchemaError(saveKey.message),
    saveKey.ok ? '已保存（临时 home）' : `code=${saveKey.code} ${String(saveKey.message).slice(0, 60)}`
  )

  const setModel = await runtime
    .request('POST', '/api/model/set', { scope: 'main', provider: 'deepseek', model: 'deepseek-chat' })
    .then((r) => ({ ok: true, r }))
    .catch((e) => ({ ok: false, message: e.message }))
  check(
    'POST /api/model/set 载荷形状正确（scope/provider/model）',
    setModel.ok || !isSchemaError(setModel.message),
    setModel.ok ? '已设置（临时 home）' : String(setModel.message).slice(0, 70)
  )

  const endpoints = await runtime
    .request('GET', '/api/providers/custom-endpoints')
    .then((r) => ({ ok: true, r }))
    .catch((e) => ({ ok: false, message: e.message }))
  check('GET /api/providers/custom-endpoints 可读', endpoints.ok, endpoints.ok ? '已读取' : String(endpoints.message).slice(0, 60))

  const upsert = await runtime
    .request('POST', '/api/providers/custom-endpoints', {
      name: 'smoke-endpoint',
      base_url: 'https://example.invalid/v1',
      model: 'smoke-model',
      make_default: false
    })
    .then((r) => ({ ok: true, r }))
    .catch((e) => ({ ok: false, message: e.message }))
  check(
    'POST /api/providers/custom-endpoints 载荷形状正确',
    upsert.ok || !isSchemaError(upsert.message),
    upsert.ok ? '已写入（临时 home）' : String(upsert.message).slice(0, 70)
  )

  const interrupted = await gateway
    .call('session.interrupt', { session_id: sid })
    .then(() => ({ ok: true }))
    .catch((e) => ({ ok: false, code: e.code, message: e.message }))
  check(
    'session.interrupt 参数被接受（5032 = 本机未配模型，跳过）',
    interrupted.ok || interrupted.code === NO_PROVIDER,
    interrupted.ok ? 'done' : `code=${interrupted.code}`
  )

  // 恢复路径：运行时不再持有该 id 时，核心要求客户端用 stored id 走 session.resume
  const bogus = await gateway
    .call('session.history', { session_id: 'deadbeef-not-in-memory' })
    .then(() => ({ ok: true }))
    .catch((e) => ({ ok: false, code: e.code }))
  check('未知 session_id 返回 4001（可识别的错误码）', bogus.ok === false && bogus.code === 4001, `code=${bogus.code}`)

  // 恢复路径的真实形态：会话被运行时回收后，用 stored id 调任何方法都会 4001，
  // 必须 resume → 用**返回的新 id** 重试（壳里就是 electron/session-remap.mjs 这段逻辑）。
  const stored0 = (await gcall('session.list', {}))?.sessions?.[0]?.id
  if (stored0) {
    await gcall('session.close', { session_id: stored0 }).catch(() => {})
    const staleCode = await gateway
      .call('session.history', { session_id: stored0 })
      .then(() => null)
      .catch((e) => e.code)
    let remap = null
    const retried = await callWithSessionRemap(
      (m, p) => gateway.call(m, p),
      'session.history',
      { session_id: stored0 },
      { onRemap: (from, to) => { remap = { from, to } } }
    ).then((r) => ({ ok: true, count: r?.count })).catch((e) => ({ ok: false, code: e.code, message: e.message }))
    check(
      '会话被回收后：4001 → resume → 用新 id 重试成功（壳的恢复逻辑）',
      (staleCode === 4001 || staleCode === null) && retried.ok,
      `stale=${staleCode ?? '可直读'} remap=${remap ? `${remap.from}→${remap.to}` : '未触发'} retried=${retried.ok ? `count=${retried.count}` : retried.code}`
    )
  } else {
    check('会话被回收后：4001 → resume → 用新 id 重试成功（壳的恢复逻辑）', false, '这个 home 里没有可测的 stored 会话，跳过')
  }

  const stored = (await gcall('session.list', {}))?.sessions?.[0]?.id
  if (stored) {
    const resumed = await gateway
      .call('session.resume', { session_id: stored, cols: 100 })
      .then((r) => ({ ok: true, id: r?.session_id }))
      .catch((e) => ({ ok: false, message: e.message }))
    check('session.resume 用 stored id 恢复运行时会话', resumed.ok && Boolean(resumed.id), resumed.id ?? resumed.message)
    if (resumed.id) {
      const after = await gateway
        .call('session.interrupt', { session_id: resumed.id })
        .then(() => ({ ok: true }))
        .catch((e) => ({ ok: false, code: e.code, message: e.message }))
      check(
        '恢复后 interrupt 参数被接受',
        after.ok || after.code === NO_PROVIDER,
        after.ok ? 'done' : `code=${after.code}`
      )
    }
  }
} catch (err) {
  check('异常中断', false, err.message)
} finally {
  gateway?.close()
  await runtime.stop()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length) {
  console.error('失败项：', failed.map((f) => f.name).join('、'))
  process.exitCode = 1
}
