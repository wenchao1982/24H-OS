/**
 * 渲染进程：会话列表 + 对话流（流式）+ 模型选择 + 设置。
 * 只通过 window.hermes 与主进程通信；所有调用返回 {ok,data} | {ok,error}。
 */
const $ = (id) => document.getElementById(id)
const LIMIT = { MESSAGES: 400, LOGS: 300 }

/** 当前版本只对外提供 DeepSeek：设置里的服务商、模型下拉都按这张白名单过滤。
 *  匹配 slug 或 name（核心不同版本对 deepseek 的 name 有时是 "DeepSeek" 有时是 "deepseek"）。
 *  一个都没匹配上就退回"全部可填 key 的服务商"，免得界面变成死路。 */
const PROVIDER_ALLOWLIST = ['deepseek']
/** 模型名兜底：核心要等填了 key 才会返回该服务商的模型列表，没 key 时给用户看这个（核心 0.21.3 的实名单） */
const MODEL_FALLBACK = { deepseek: ['deepseek-v4-pro', 'deepseek-flash'] }
const providerMatchesAllowlist = (p) =>
  PROVIDER_ALLOWLIST.some((k) => String(p.slug ?? '').toLowerCase() === k || String(p.name ?? '').toLowerCase().includes(k))
/** 只有 api_key 类服务商能接受 save_key；moa(virtual)/opencode-free(hermes)/oauth 类都填不了 key */
const canHoldApiKey = (p) => p.auth_type === 'api_key'

/** 主题：跟随系统 / 深色 / 浅色。刻意放在渲染层，壳不参与（换主题不需要重启核心）。 */
const themeMedia = window.matchMedia('(prefers-color-scheme: light)')
let themePref = 'system' // 由壳的 ui-prefs.json 提供，默认跟系统
function applyTheme(pref) {
  themePref = pref
  const resolved = pref === 'system' ? (themeMedia.matches ? 'light' : 'dark') : pref
  document.documentElement.dataset.theme = resolved
  const label = pref === 'system' ? '跟随系统' : pref === 'dark' ? '深色' : '浅色'
  const btn = $('btn-theme')
  if (btn) btn.title = `外观：${label}（点一下切换）`
}
function persistTheme(pref) {
  // 主题是"壳长什么样"的偏好，交给主进程写 userData/ui-prefs.json（不碰核心配置）
  window.hermes.prefsSet({ theme: pref })
}
/** 壳期望的核心「桌面契约」版本（session.create 的 info.desktop_contract）。
 *  实测：0.21.0 → 6，0.21.3 → 7；随包运行时用的是 0.21.3，所以这里是 7。
 *  核心过旧/过新都会在顶部告警条提示，避免静默不兼容。 */
const EXPECTED_DESKTOP_CONTRACT = 7

const state = {
  sessionId: null, // 当前活跃会话（核心给的短 id）
  sessions: [],
  providers: [],
  keyProviders: [], // 能填 API Key 的服务商（设置页用）
  providerNarrowed: false, // 是否被白名单收窄过（用于设置页那句说明）
  model: '',
  streaming: null, // { text, thinking, tools: Map }
  busy: false,
  tokens: 0,
  cwd: '',
  contract: null,
  providerReady: null,
  corePhase: 'starting', // 核心当前阶段（窗口通常比核心先就绪，靠它决定要不要等）
  searchQuery: '',
  _searchTimer: null
}

/* ───────────────────── 顶部告警条（兼容性 / 未配置模型）───────────────────── */

function showBanner(text, { error = false, action } = {}) {
  const box = $('banner')
  box.textContent = ''
  box.hidden = false
  box.className = 'banner' + (error ? ' err' : '')
  box.appendChild(el('span', null, text))
  if (action) {
    const btn = el('button', null, action.label)
    btn.addEventListener('click', action.onClick)
    box.appendChild(btn)
  }
}

function hideBanner() {
  $('banner').hidden = true
}

/** 核心契约版本对齐检查：壳编译期期望的版本 vs 运行时实际给的值 */
function checkContract(info) {
  const actual = info?.desktop_contract ?? null
  state.contract = actual
  if (actual == null) return
  if (actual < EXPECTED_DESKTOP_CONTRACT) {
    showBanner(`核心过旧：桌面契约 ${actual} < 期望 ${EXPECTED_DESKTOP_CONTRACT}。请更新运行时（scripts/build-runtime.sh）。`, { error: true })
  } else if (actual > EXPECTED_DESKTOP_CONTRACT) {
    showBanner(`核心较新：桌面契约 ${actual} > 壳支持的 ${EXPECTED_DESKTOP_CONTRACT}。壳可能不兼容，建议同步升级壳。`)
  }
}

/** 把核心的错误码翻译成人话，并给下一步动作 */
function explainError(message, code) {
  if (code === 5032 || /No inference provider/i.test(message || '')) {
    showBanner('还没有配置模型：请到「设置」填入服务商 API Key，或切换一个可用模型。', {
      action: { label: '去设置', onClick: () => $('btn-settings').click() }
    })
    return '还没配置模型 —— 点右上角「设置」填入 API Key 后重试。'
  }
  return message
}

/* ───────────────────────── 渲染：消息 ───────────────────────── */

const thread = $('thread')
const drawer = $('drawer')

function el(tag, cls, text) {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (text != null) node.textContent = text
  return node
}

/** 一条消息 = { role: 'user'|'assistant'|'error'|'info', text, thinking, tools: [] } */
/* ───────────────────── 最小 Markdown 渲染 ─────────────────────
   只用 document.createElement 拼 DOM（不用 innerHTML，也不在流式过程中反复重排）。
   支持：围栏代码块、表格、有序/无序列表、标题、引用、粗体/斜体/行内代码/链接。
   流式生成时先按纯文本走（快），一轮结束或读历史时再渲染成富文本。 */
const MD_INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g

function mdIsLink(url) {
  return /^https?:\/\//i.test(url || '')
}

function mdInline(text) {
  const frag = document.createDocumentFragment()
  for (const part of String(text).split(MD_INLINE)) {
    if (!part) continue
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      frag.appendChild(el('strong', null, part.slice(2, -2)))
    } else if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      frag.appendChild(el('code', 'md-code', part.slice(1, -1)))
    } else if (/^\[/.test(part)) {
      const m = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
      if (m && mdIsLink(m[2])) {
        const a = el('a', 'md-link', m[1])
        a.title = m[2]
        a.addEventListener('click', () => window.hermes.openExternal(m[2]))
        frag.appendChild(a)
      } else {
        frag.appendChild(document.createTextNode(part))
      }
    } else {
      frag.appendChild(document.createTextNode(part))
    }
  }
  return frag
}

function renderRich(node, text) {
  const src = String(text ?? '')
  node.textContent = ''
  if (!src) return
  // 没有 Markdown 特征就走纯文本（省掉整条解析路径）
  if (!/[`*_|#\[\]>\n]/.test(src)) {
    node.textContent = src
    return
  }
  const lines = src.split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (/^\s*```/.test(line)) {
      const body = []
      i++
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++])
      i++
      const pre = el('pre', 'md-fence')
      pre.appendChild(el('code', null, body.join('\n')))
      node.appendChild(pre)
      continue
    }
    if (/\|/.test(line) && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(lines[i + 1] ?? '') && /-/.test(lines[i + 1] ?? '')) {
      const head = line.split('|').map((c) => c.trim()).filter((c, idx, arr) => !(c === '' && (idx === 0 || idx === arr.length - 1)))
      i += 2
      const rows = []
      while (i < lines.length && /\|/.test(lines[i])) {
        rows.push(lines[i].split('|').map((c) => c.trim()).filter((c, idx, arr) => !(c === '' && (idx === 0 || idx === arr.length - 1))))
        i++
      }
      const table = el('table', 'md-table')
      const thead = el('thead')
      const htr = el('tr')
      for (const cell of head) htr.appendChild(el('th', null, cell))
      thead.appendChild(htr)
      table.appendChild(thead)
      const tbody = el('tbody')
      for (const row of rows) {
        const tr = el('tr')
        for (const cell of row) tr.appendChild(el('td', null, cell))
        tbody.appendChild(tr)
      }
      table.appendChild(tbody)
      node.appendChild(table)
      continue
    }
    const ul = line.match(/^\s*[-*]\s+(.*)$/)
    const ol = line.match(/^\s*\d+\.\s+(.*)$/)
    if (ul || ol) {
      const list = el(ol ? 'ol' : 'ul', 'md-list')
      const re = ol ? /^\s*\d+\.\s+(.*)$/ : /^\s*[-*]\s+(.*)$/
      while (i < lines.length && re.test(lines[i])) {
        list.appendChild(el('li', null, lines[i].replace(re, '$1')))
        i++
      }
      node.appendChild(list)
      continue
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/)
    if (h) {
      node.appendChild(el('div', `md-h md-h${h[1].length}`, h[2]))
      i++
      continue
    }
    if (/^\s*>\s?/.test(line)) {
      const quote = el('blockquote', 'md-quote')
      const body = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''))
      quote.appendChild(mdInline(body.join('\n')))
      node.appendChild(quote)
      continue
    }
    if (!line.trim()) {
      i++
      continue
    }
    const para = []
    while (i < lines.length && lines[i].trim() && !/^\s*(```|#{1,4}\s|[-*]\s|\d+\.\s|>)/.test(lines[i])) para.push(lines[i++])
    const p = el('div', 'md-p')
    p.appendChild(mdInline(para.join('\n')))
    node.appendChild(p)
  }
}

function renderMessage(msg, { append = true } = {}) {
  const wrap = el('div', `msg ${msg.role}`)
  wrap.dataset.role = msg.role
  const who =
    msg.role === 'user' ? '你' : msg.role === 'assistant' ? '24H' : msg.role === 'error' ? '错误' : '系统'
  wrap.appendChild(el('div', 'who', who))

  if (msg.thinking) {
    const th = el('div', 'thinking', msg.thinking)
    th.dataset.role = 'thinking'
    wrap.appendChild(th)
  }

  const bubble = el('div', 'bubble')
  bubble.dataset.role = 'text'
  renderRich(bubble, msg.text ?? '')
  wrap.appendChild(bubble)

  for (const tool of msg.tools ?? []) wrap.appendChild(renderTool(tool))

  if (msg.role === 'error') wrap.classList.add('error')
  if (append) thread.appendChild(wrap)
  return wrap
}

function renderTool(tool) {
  const box = el('details', 'tool')
  const sum = el('summary')
  sum.appendChild(el('b', null, tool.name || 'tool'))
  sum.appendChild(el('span', null, tool.context || ''))
  box.appendChild(sum)
  box.open = Boolean(tool.open)
  const body = tool.result || tool.argsText || (tool.args ? JSON.stringify(tool.args, null, 2) : '')
  if (body) box.appendChild(el('pre', null, body))
  box.dataset.toolId = tool.tool_id || ''
  return box
}

function scrollToEnd() {
  thread.scrollTop = thread.scrollHeight
}

function clearThread() {
  thread.textContent = ''
}

function emptyHint(text) {
  clearThread()
  thread.appendChild(el('div', 'empty', text))
}

/* ───────────────────── 渲染：会话列表 / 模型 ───────────────────── */

function renderSessions() {
  const box = $('sessions')
  box.textContent = ''
  if (!state.sessions.length) {
    box.appendChild(el('div', 'empty', state.searchQuery ? '没有匹配的会话' : '还没有会话'))
    return
  }
  for (const s of state.sessions) {
    const row = el('div', 'sess' + (s.id === state.sessionId ? ' active' : ''))
    const line = el('div', 'row1')
    const title = el('span', 't', s.title || s.preview || s.id)
    line.appendChild(title)
    const acts = el('div', 'acts')
    const rename = el('button', null, '改名')
    rename.addEventListener('click', (e) => {
      e.stopPropagation()
      startRename(row, title, s.id)
    })
    const del = el('button', null, '删除')
    del.addEventListener('click', (e) => {
      e.stopPropagation()
      removeSession(s.id)
    })
    acts.appendChild(rename)
    acts.appendChild(del)
    line.appendChild(acts)
    row.appendChild(line)
    const meta = el('div', 'm', `${s.message_count ?? 0} 条消息`)
    meta.title = s.id
    row.appendChild(meta)
    row.addEventListener('click', () => activateSession(s.id))
    box.appendChild(row)
  }
}

/** 行内改名（Electron 里没有 window.prompt） */
function startRename(row, titleEl, id) {
  const input = el('input')
  input.value = titleEl.textContent
  input.className = 'rename-input'
  titleEl.replaceWith(input)
  input.focus()
  input.select()
  const commit = async () => {
    const value = input.value.trim()
    const res = value ? await window.hermes.sessionTitle({ session_id: id, title: value }) : { ok: true }
    if (!res.ok) showBanner(`改名失败：${res.error}`, { error: true })
    await refreshSessions()
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commit()
    }
    if (e.key === 'Escape') refreshSessions()
  })
  input.addEventListener('blur', commit)
}

async function removeSession(id) {
  // 核心不允许删除「活跃会话」（实测错误：cannot delete an active session）→ 先切到别的会话
  if (id === state.sessionId) {
    const other = state.sessions.find((s) => s.id !== id)
    if (other) await activateSession(other.id)
    else await newSession()
  }
  // 核心规则（4023 cannot delete an active session）：会话只要还在内存里就不能删，
  // 所以先 session.close 把它从活跃集合摘掉，再删。
  await window.hermes.sessionClose({ session_id: id })
  const res = await window.hermes.sessionDelete({ session_id: id })
  if (!res.ok) {
    showBanner(`删除失败：${res.error}`, { error: true })
    return
  }
  await refreshSessions()
}

async function runSearch(q) {
  state.searchQuery = q
  if (!q) {
    await refreshSessions()
    return
  }
  const res = await window.hermes.sessionsSearch({ q })
  if (!res.ok) return
  state.sessions = res.data?.results ?? []
  renderSessions()
}

function renderModelSelect() {
  const sel = $('model-select')
  sel.textContent = ''
  // 能真正跑起来的：已认证 + 有模型名单。当前版本只暴露 DeepSeek，所以再按白名单收一次；
  // 白名单一个都没有（用户自己配了别的）就退回全部已认证的，别让下拉变空。
  const authed = state.providers.filter((p) => p.authenticated && (p.models?.length || 0) > 0)
  // 目录里有白名单服务商（DeepSeek）时走严格模式：没填 key 就只给"去设置填 Key"的提示，
  // 不把 moa / opencode-free 这类摆上来（它们不是我们要卖的那条路）。目录里压根没有才退回全部。
  const allowlistedInCatalog = state.providers.some(providerMatchesAllowlist)
  const usable = allowlistedInCatalog ? authed.filter(providerMatchesAllowlist) : authed
  for (const p of usable) {
    for (const m of p.models) {
      const label = `${p.name || p.slug}${p.is_current ? '（当前）' : ''} · ${m}`
      sel.appendChild(new Option(label, `${p.slug}::${m}`))
    }
  }
  if (!usable.length) {
    // 还没填 key：不要给一个空白下拉 —— 直接说下一步该干什么
    sel.appendChild(new Option('模型：先在「设置」里填 DeepSeek API Key', ''))
    return
  }
  if (state.model) {
    for (const opt of sel.options) if (opt.value.endsWith(`::${state.model}`)) sel.value = opt.value
  }
}

function renderProviderSelect() {
  const sel = $('set-provider')
  sel.textContent = ''
  const list = (state.keyProviders ?? []).filter((p) => p.slug)
  for (const p of list) {
    const state_ = p.authenticated ? '' : '（未配置 Key）'
    sel.appendChild(new Option(`${p.name || p.slug}${state_}`, p.slug))
  }
  if (!list.length) sel.appendChild(new Option('（没读到可填 Key 的服务商）', ''))
  const hint = $('provider-hint')
  if (hint) {
    hint.textContent = state.providerNarrowed
      ? '当前版本只提供 DeepSeek：在 platform.deepseek.com 申请 Key，粘贴后保存。其它服务商可走下面的「高级 → 自定义端点」。'
      : '只列出可以直接填 API Key 的服务商（聚合/内置类服务商不接受 Key，已隐藏）。'
  }
}

function renderRunInfo(info) {
  const box = $('run-info')
  box.textContent = ''
  for (const [k, v] of Object.entries(info)) {
    const row = el('div', 'kv')
    row.appendChild(el('b', null, k))
    row.appendChild(el('code', null, String(v)))
    box.appendChild(row)
  }
}

/* ───────────────────────── 交互逻辑 ───────────────────────── */

function paintCwd(cwd) {
  if (cwd) state.cwd = cwd
  const label = state.cwd ? state.cwd.replace(/^.*[\\/]/, '') || state.cwd : '工作目录'
  $('cwd-label').textContent = label
  $('btn-cwd').title = state.cwd || '选择工作目录'
}

async function pickCwd() {
  const dir = await window.hermes.pickDirectory()
  if (!dir) return
  const res = await window.hermes.sessionCwdSet({ session_id: state.sessionId, cwd: dir })
  if (!res.ok) {
    showBanner(`设置工作目录失败：${res.error}`, { error: true })
    return
  }
  paintCwd(dir)
  if (!$('files-panel').hidden) await openDir(dir)
  hideBanner()
}

async function refreshSessions() {
  const res = await window.hermes.sessionsList({})
  if (!res.ok) return
  state.sessions = res.data?.sessions ?? []
  renderSessions()
}

async function refreshModels() {
  const res = await window.hermes.modelsList({})
  if (!res.ok) {
    $('model-select').textContent = ''
    $('model-select').appendChild(new Option(`模型读取失败：${res.error}`, ''))
    return
  }
  const all = (res.data?.providers ?? []).filter((p) => p && p.slug)
  state.providers = all
  // 设置页的服务商：只列"能填 API Key"的；白名单命中就用白名单，否则退回"全部能填 key 的"
  const keyable = all.filter(canHoldApiKey)
  const allowed = keyable.filter(providerMatchesAllowlist)
  state.keyProviders = allowed.length ? allowed : keyable
  state.providerNarrowed = allowed.length > 0 && allowed.length < keyable.length
  renderModelSelect()
  renderProviderSelect()
}

async function newSession() {
  const res = await window.hermes.sessionsCreate({ cols: 100, title: '' })
  if (!res.ok) {
    emptyHint(`新建会话失败：${res.error}`)
    return
  }
  state.sessionId = res.data?.session_id ?? null
  state.model = res.data?.info?.model || state.model
  checkContract(res.data?.info)
  paintCwd(res.data?.info?.cwd)
  clearThread()
  emptyHint('开始对话吧')
  await refreshSessions()
}

async function activateSession(id) {
  // activate 把磁盘会话装进运行时；运行时已回收该 id 时回落到 resume
  let res = await window.hermes.sessionActivate({ session_id: id, cols: 100 })
  if (!res.ok) res = await window.hermes.sessionResume({ session_id: id, cols: 100 })
  if (!res.ok) {
    emptyHint(`切换会话失败：${res.error}`)
    return
  }
  state.sessionId = res.data?.session_id ?? id
  checkContract(res.data?.info)
  paintCwd(res.data?.info?.cwd)
  await loadHistory(id)
  renderSessions()
}

async function loadHistory(id) {
  const res = await window.hermes.sessionHistory({ session_id: id })
  if (!res.ok) {
    emptyHint(`读取历史失败：${res.error}`)
    return
  }
  const messages = res.data?.messages ?? []
  clearThread()
  if (!messages.length) {
    emptyHint('这个会话还没有消息')
    return
  }
  for (const m of messages) {
    const role = m.role === 'user' ? 'user' : 'assistant'
    const text =
      typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content.map((c) => c.text ?? '').join('')
          : ''
    if (text) renderMessage({ role, text })
  }
  scrollToEnd()
}

/** 发送消息：立刻上屏用户气泡 + 一个空的助手气泡（后续 delta 往里追加）。 */
async function send() {
  const input = $('input')
  const text = input.value.trim()
  if (!text || state.busy || !state.sessionId) return
  input.value = ''
  renderMessage({ role: 'user', text })
  const assistant = { role: 'assistant', text: '', thinking: '', tools: [], toolMap: new Map() }
  const node = renderMessage(assistant)
  state.streaming = { node, msg: assistant }
  state.busy = true
  setBusy(true)
  scrollToEnd()

  const res = await window.hermes.send({ session_id: state.sessionId, text })
  if (!res.ok) {
    pushStreamError(res.error)
    finishStream()
  }
}

function setBusy(busy) {
  $('btn-send').disabled = busy
  $('btn-stop').hidden = !busy
  $('turn-state').textContent = busy ? '生成中…' : ''
}

function pushStreamError(message) {
  const s = state.streaming
  if (s) s.msg.text = s.msg.text ? `${s.msg.text}\n\n[错误] ${message}` : `[错误] ${message}`
  else renderMessage({ role: 'error', text: message })
  paintStream()
}

function paintStream() {
  const s = state.streaming
  if (!s) return
  const textEl = s.node.querySelector('.bubble[data-role="text"]')
  textEl.textContent = s.msg.text
  textEl.classList.toggle('cursor', state.busy)
  let th = s.node.querySelector('.thinking')
  if (s.msg.thinking && !th) {
    th = el('div', 'thinking')
    s.node.insertBefore(th, textEl)
  }
  if (th) th.textContent = s.msg.thinking
  scrollToEnd()
}

function finishStream() {
  state.busy = false
  setBusy(false)
  const s = state.streaming
  if (s) {
    const textEl = s.node.querySelector('.bubble[data-role="text"]')
    textEl?.classList.remove('cursor')
    // 生成过程中是纯文本（每次 delta 都重排太浪费），一轮结束再渲染成富文本
    if (textEl && s.msg.text) renderRich(textEl, s.msg.text)
    if (!s.msg.text) s.node.remove()
  }
  state.streaming = null
  refreshSessions()
}

/* ───────────────────── 核心事件（流式渲染）───────────────────── */

function appendTool(evt) {
  const s = state.streaming
  if (!s) return
  const p = evt.payload ?? {}
  const tool = { tool_id: p.tool_id, name: p.name, context: p.context, args: p.args, argsText: p.args_text, open: false }
  s.msg.tools.push(tool)
  s.msg.toolMap.set(p.tool_id, tool)
  s.node.appendChild(renderTool(tool))
  scrollToEnd()
}

function completeTool(evt) {
  const s = state.streaming
  if (!s) return
  const p = evt.payload ?? {}
  const tool = s.msg.toolMap.get(p.tool_id)
  if (!tool) return
  tool.result =
    (typeof p.result === 'string' && p.result) ||
    (p.inline_diff && String(p.inline_diff)) ||
    (p.result ? JSON.stringify(p.result, null, 2).slice(0, 4000) : '')
  if (tool.result) {
    const box = s.node.querySelector(`details[data-tool-id="${tool.tool_id}"]`)
    if (box && !box.querySelector('pre')) box.appendChild(el('pre', null, tool.result))
  }
  scrollToEnd()
}

function onGatewayEvent(evt) {
  const { type, payload } = evt ?? {}
  if (!type) return
  // 只渲染当前会话的事件
  if (evt.sessionId && state.sessionId && evt.sessionId !== state.sessionId) return

  switch (type) {
    case 'turn.started':
      if (!state.streaming) {
        const assistant = { role: 'assistant', text: '', thinking: '', tools: [], toolMap: new Map() }
        const node = renderMessage(assistant)
        state.streaming = { node, msg: assistant }
        state.busy = true
        setBusy(true)
      }
      break
    case 'message.delta':
      if (state.streaming) {
        state.streaming.msg.text += payload?.text ?? ''
        paintStream()
      }
      break
    case 'reasoning.delta':
    case 'thinking.delta':
      if (state.streaming) {
        state.streaming.msg.thinking += payload?.text ?? ''
        paintStream()
      }
      break
    case 'tool.start':
      appendTool(evt)
      break
    case 'tool.complete':
      completeTool(evt)
      break
    case 'message.complete':
      if (state.streaming) {
        if (payload?.text) state.streaming.msg.text = payload.text
        if (payload?.status === 'error') state.streaming.node.classList.add('error')
        finishStream()
      } else if (payload?.text) {
        renderMessage({ role: payload.status === 'error' ? 'error' : 'assistant', text: payload.text })
        scrollToEnd()
      }
      break
    case 'error':
      pushStreamError(explainError(payload?.message ?? '未知错误', payload?.code))
      finishStream()
      break
    case 'session.info':
      if (payload?.model) {
        state.model = payload.model
        $('session-label').textContent = `${payload.provider || ''} ${payload.model}`.trim()
      }
      break
    case 'setup.ready':
      state.providerReady = payload?.provider_configured ?? null
      if (payload?.provider_configured === false) {
        showBanner('首次启动：还没有配置任何模型服务商。到「设置」填入 API Key 就能开始对话。', {
          action: { label: '去设置', onClick: () => $('btn-settings').click() }
        })
      } else if (payload?.provider_configured === true) {
        hideBanner()
      }
      break
    case 'sessions.changed':
      refreshSessions()
      break
    default:
      break
  }
}

/* ───────────────────────── 文件面板 ───────────────────────── */

const filesUI = { path: '', entries: [] }

function renderEntries() {
  const box = $('entries')
  box.textContent = ''
  // 路径栏很窄：显示尾部两段（完整路径放 tooltip），比截断后半段有用
  const full = filesUI.path || '—'
  const parts = full.split(/[\\/]/).filter(Boolean)
  const short = parts.length > 2 ? '…/' + parts.slice(-2).join('/') : full
  const pathEl = $('files-path')
  pathEl.textContent = short
  pathEl.title = full
  if (!filesUI.entries.length) {
    box.appendChild(el('div', 'empty', '空目录'))
    return
  }
  for (const e of filesUI.entries) {
    const row = el('div', 'entry ' + (e.isDirectory ? 'dir' : 'file'))
    row.appendChild(el('span', 'ico')) // 图形由 CSS 画，见 styles.css 的 .entry .ico
    row.appendChild(el('span', null, e.name))
    row.title = e.path
    row.addEventListener('click', () => (e.isDirectory ? openDir(e.path) : openFile(e.path)))
    box.appendChild(row)
  }
}

async function openDir(dir) {
  $('preview').hidden = true
  const res = await window.hermes.fsList({ path: dir })
  if (!res.ok) {
    showBanner(`列目录失败：${res.error}`, { error: true })
    return
  }
  filesUI.path = dir
  filesUI.entries = (res.data?.entries ?? []).slice().sort(
    (a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name)
  )
  renderEntries()
}

async function openFile(file) {
  const res = await window.hermes.fsRead({ path: file })
  if (!res.ok) {
    showBanner(`读取失败：${res.error}`, { error: true })
    return
  }
  const data = res.data ?? {}
  const box = $('preview')
  box.hidden = false
  box.textContent = ''
  box.appendChild(el('div', null, `${data.name} · ${data.size} B · ${data.mime_type || ''}`))
  const url = data.data_url || ''
  if ((data.mime_type || '').startsWith('image/') && url.startsWith('data:image')) {
    const img = el('img')
    img.src = url
    box.appendChild(img)
    return
  }
  const b64 = url.includes(',') ? url.slice(url.indexOf(',') + 1) : ''
  try {
    const text = decodeURIComponent(escape(atob(b64)))
    box.appendChild(el('pre', null, text.slice(0, 20000)))
  } catch {
    box.appendChild(el('pre', null, '（二进制或非 UTF-8，已省略）'))
  }
}

async function toggleFiles() {
  const panel = $('files-panel')
  panel.hidden = !panel.hidden
  if (!panel.hidden) {
    if (!filesUI.path && state.cwd) await openDir(state.cwd)
    else if (!filesUI.path) await openDir('.')
  }
}

/* ───────────────────────── 日志 / 状态 ───────────────────────── */

function appendLog(entry) {
  const div = el('div', null, entry.line)
  if (entry.stream === 'stderr') div.className = 'err'
  else if (/HERMES_BACKEND_READY|listening on/.test(entry.line)) div.className = 'hi'
  drawer.appendChild(div)
  while (drawer.childElementCount > LIMIT.LOGS) drawer.removeChild(drawer.firstChild)
  drawer.scrollTop = drawer.scrollHeight
}

function setCoreState(phase, extra = {}) {
  state.corePhase = phase
  $('core-state').textContent = phase + (extra.port ? ` :${extra.port}` : '')
  $('dot').className = 'dot ' + phase
  $('gw-chip').hidden = phase !== 'ready'
  if (phase === 'ready') refreshRunInfo()
}

function setGatewayState(connected) {
  $('gw-state').textContent = connected ? '已连接' : '未连接'
}

function refreshRunInfo() {
  // 注意：所有 IPC 调用统一返回 {ok,data}，状态在 data 里 —— 别再直接读 s.phase（会得到 undefined）
  window.hermes.state().then((r) => {
    const s = r?.data ?? {}
    renderRunInfo({
      核心: s.phase ?? '-',
      端口: s.port ?? '-',
      会话: state.sessionId ?? '-',
      模型: state.model || '-'
    })
  })
}

/* ───────────────────────── 设置 ───────────────────────── */

/** 自定义 OpenAI 兼容端点（火山/硅基流动/自建网关等） */
async function loadCustomEndpoints() {
  const box = $('custom-endpoints')
  if (!box) return
  const res = await window.hermes.customEndpoints()
  box.textContent = ''
  if (!res.ok) {
    box.appendChild(el('div', 'hint', `读取失败：${res.error}`))
    return
  }
  const list = Array.isArray(res.data) ? res.data : (res.data?.endpoints ?? [])
  if (!list.length) {
    box.appendChild(el('div', 'hint', '还没有自定义端点。'))
    return
  }
  for (const e of list) {
    box.appendChild(el('div', 'kv', `${e.name || e.id} · ${e.model} · ${e.base_url}`))
  }
}

async function saveCustomEndpoint() {
  const name = $('ce-name').value.trim()
  const baseUrl = $('ce-base').value.trim()
  const model = $('ce-model').value.trim()
  const apiKey = $('ce-key').value.trim()
  const status = $('ce-status')
  if (!name || !baseUrl || !model) {
    status.textContent = '名称 / Base URL / 模型名 都是必填'
    return
  }
  const res = await window.hermes.customEndpointUpsert({
    name,
    base_url: baseUrl,
    model,
    api_key: apiKey || null,
    make_default: true
  })
  status.textContent = res.ok ? '已保存，并设为默认模型。' : `保存失败：${res.error}`
  if (res.ok) {
    $('ce-key').value = ''
    await loadCustomEndpoints()
    await refreshModels()
  }
}

function suggestModel(providerSlug) {
  const p = (state.keyProviders ?? []).find((x) => x.slug === providerSlug)
  if (p?.models?.length) return p.models[0]
  return (MODEL_FALLBACK[providerSlug] ?? [])[0] ?? ''
}

async function loadSettingsForm() {
  const status = $('settings-status')
  if (state.corePhase !== 'ready') {
    // 窗口通常比核心先就绪：这时读配置只会拿到「核心尚未就绪」，
    // 不如直说，并保证核心就绪后会自己补上（见 afterCoreReady）。
    status.textContent = '核心还在启动 —— 就绪后这里会自动读出服务商与配置。'
    renderProviderSelect()
    return
  }
  const loading = '正在读取核心配置…'
  if (!status.textContent) status.textContent = loading
  // 服务商列表来自 model.options；核心晚就绪时它是空的，这里补拉一次，免得下拉框空白
  if (!state.providers.length) await refreshModels()
  const cfg = await window.hermes.configGet()
  if (cfg.ok) {
    const c = cfg.data ?? {}
    $('set-model').value = c.model || state.model || suggestModel($('set-provider').value)
    $('set-model').placeholder = suggestModel($('set-provider').value) || 'deepseek-v4-pro'
    window.__cfg = c
  }
  renderProviderSelect()
  await loadCustomEndpoints()
  refreshRunInfo()
  if (status.textContent === loading) status.textContent = ''
}

async function saveSettings() {
  const provider = $('set-provider').value
  const key = $('set-key').value.trim()
  const model = $('set-model').value.trim()
  const status = $('settings-status')
  const saveBtn = $('btn-save-settings')
  status.textContent = ''
  try {
    if (key && provider) {
      // 核心的契约是 { slug, api_key }（不是 provider/key），参数名写错会被严格校验拒绝。
      // 保存可能要几秒（核心会去服务商那边验证 key），所以给"保存中…"+禁用按钮，别让用户重复点。
      saveBtn.disabled = true
      status.textContent = '正在保存并校验 Key…'
      let r
      try {
        r = await window.hermes.modelSaveKey({ slug: provider, api_key: key })
      } finally {
        saveBtn.disabled = false
      }
      if (!r.ok) {
        // 4002 unknown provider：说明选到了一个不接受 Key 的服务商（虚拟聚合/内置类）
        const hint = /unknown provider/i.test(r.error || '')
          ? '这个服务商不接受 API Key（它是聚合或内置类型）。请在"服务商"里选 DeepSeek。'
          : r.error
        throw new Error(`保存 Key 失败：${hint}`)
      }
      $('set-key').value = ''
      status.textContent = `已保存 ${provider} 的 Key。`
      await refreshModels() // key 生效后核心才会给出该服务商的模型名单
    }
    if (model) {
      // 设置默认模型 = REST POST /api/model/set，体 { scope, provider, model }
      const r = await window.hermes.modelSet({ scope: 'main', provider, model })
      if (!r.ok) throw new Error(`设置模型失败：${r.error}`)
      state.model = model
      status.textContent += ' 默认模型已更新。'
    }
    await refreshModels()
    await loadSettingsForm()
    status.textContent = status.textContent || '已保存。'
  } catch (err) {
    status.textContent = err.message
  }
}

/* ───────────────────────── 事件绑定 ───────────────────────── */

$('btn-new').addEventListener('click', newSession)
$('btn-refresh').addEventListener('click', refreshSessions)
$('btn-send').addEventListener('click', send)
$('btn-stop').addEventListener('click', async () => {
  if (!state.sessionId) return
  await window.hermes.sessionInterrupt({ session_id: state.sessionId })
  finishStream()
})
$('btn-logs').addEventListener('click', () => {
  drawer.hidden = !drawer.hidden
})
$('btn-cwd').addEventListener('click', pickCwd)
$('btn-files').addEventListener('click', toggleFiles)
$('btn-files-refresh').addEventListener('click', () => (filesUI.path ? openDir(filesUI.path) : toggleFiles()))
$('btn-files-up').addEventListener('click', () => {
  if (!filesUI.path) return
  const parent = filesUI.path.replace(/[\\/][^\\/]*$/, '') || '/'
  openDir(parent)
})
$('search').addEventListener('input', (e) => {
  const q = e.target.value.trim()
  clearTimeout(state._searchTimer)
  state._searchTimer = setTimeout(() => runSearch(q), 250)
})
function closeSettings() {
  $('settings').hidden = true
}
function openSettings() {
  $('settings').hidden = false
  loadSettingsForm()
}
$('btn-theme').addEventListener('click', () => {
  const next = (document.documentElement.dataset.theme || 'dark') === 'dark' ? 'light' : 'dark'
  applyTheme(next)
  persistTheme(next)
})
themeMedia.addEventListener('change', () => {
  if (themePref === 'system') applyTheme('system') // 只有"跟随系统"时才跟着系统变
})

$('btn-settings').addEventListener('click', openSettings)
$('btn-close-settings').addEventListener('click', closeSettings)
$('btn-close-settings-x').addEventListener('click', closeSettings)
$('settings').addEventListener('click', (e) => {
  if (e.target === $('settings')) closeSettings() // 点卡片外的底色也能关
})
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('settings').hidden) closeSettings()
})
$('btn-save-settings').addEventListener('click', saveSettings)
$('btn-ce-save').addEventListener('click', saveCustomEndpoint)
$('btn-restart-core').addEventListener('click', async () => {
  const status = $('settings-status')
  status.textContent = '正在重启核心…'
  const res = await window.hermes.restart()
  status.textContent = res.ok ? '核心已重启。' : `重启失败：${res.error}`
})
$('model-select').addEventListener('change', async (e) => {
  const [provider, model] = String(e.target.value).split('::')
  if (!model) return
  const res = await window.hermes.modelSet({ scope: 'main', provider, model })
  if (res.ok) {
    state.model = model
    $('session-label').textContent = `${provider} ${model}`
  }
})
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    send()
  }
})

window.hermes.onState((s) => {
  setCoreState(s.phase, s)
  if (s.phase === 'starting') {
    showBanner('核心正在启动…（首次启动要建运行时环境，可能 1–2 分钟，杀软扫描时更久）', {
      action: { label: '看日志', onClick: () => { $('drawer').hidden = false } }
    })
  }
})

/** 启动失败/超时：给出重试入口与排查提示 */
function onStartupFailure(message) {
  showBanner(`核心启动失败：${message}`, {
    error: true,
    action: { label: '重试', onClick: () => window.hermes.restart() }
  })
  setCoreState('failed')
}
window.hermes.onReady(async ({ port }) => {
  setCoreState('ready', { port })
  await afterCoreReady()
})
window.hermes.onRuntimeError(({ message }) => {
  onStartupFailure(message)
  renderMessage({ role: 'error', text: `核心启动失败：${message}` })
})
window.hermes.onRuntimeExit(() => setCoreState('exited'))
window.hermes.onLog(appendLog)
window.hermes.onGatewayStatus(({ connected }) => setGatewayState(connected))
window.hermes.onEvent(onGatewayEvent)

/* ───────────────────────── 启动 ───────────────────────── */

/** 核心就绪后要跑一次（且只跑一次首屏初始化）。
 *  窗口比核心先就绪是常态（核心要拉 python 起来，几秒到几十秒），所以这条路径
 *  必须由 onReady 也能触发 —— 否则模型列表/会话列表永远停在「读取中…」。 */
let coreReadyLoaded = false
async function afterCoreReady() {
  await refreshModels()
  await refreshSessions()
  refreshRunInfo()
  if (!$('settings').hidden) await loadSettingsForm() // 弹层开着就顺手把配置读出来
  if (coreReadyLoaded) return // 重启核心后再就绪：只刷新列表，保留当前会话
  coreReadyLoaded = true
  paintCwd('')
  if (state.sessions.length) await activateSession(state.sessions[0].id)
  else await newSession()
}

// 启动第一件事：问壳要主题偏好（默认深色，读完再按偏好切，避免白闪）
async function initTheme() {
  try {
    const res = await window.hermes.prefsGet()
    applyTheme(res?.data?.theme || 'system')
  } catch {
    applyTheme('system')
  }
}
initTheme()

async function boot() {
  // IPC 返回的是 {ok,data}：不拆开的话 s.phase 恒为 undefined，
  // 于是「核心已就绪」也会被判成没就绪，首屏永远停在「模型：读取中…」。
  const s = (await window.hermes.state())?.data ?? {}
  setCoreState(s.phase ?? 'starting', s)
  for (const e of s.logs ?? []) appendLog(e)
  if (s.phase !== 'ready') {
    emptyHint('正在启动核心…（就绪后会自动加载会话）')
    return
  }
  await afterCoreReady()
}

boot()
