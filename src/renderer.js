/**
 * 渲染进程：会话列表 + 对话流（流式）+ 模型选择 + 设置。
 * 只通过 window.hermes 与主进程通信；所有调用返回 {ok,data} | {ok,error}。
 */
const $ = (id) => document.getElementById(id)
/** 调核心时用的会话 id：优先运行时 id（resume 之后 stored id 会失效） */
const rid = () => state.runtimeSessionId ?? state.sessionId
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
  sessionId: null, // 列表里的会话 id（磁盘会话，稳定；高亮/匹配用它）
  runtimeSessionId: null, // 核心当前持有的运行时 id（所有核心调用用它；resume 后可能不同）
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
  coreVersion: null,
  runtimeInfo: null,
  update: { status: '未检查', message: '' },
  view: 'chat', // chat | skills | tasks | usage
  panelOpen: false,
  panelTab: 'files',
  paletteQuery: '',
  paletteIndex: 0,
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
  const msg = String(message ?? '')
  if (code === 5032 || /No inference provider/i.test(msg)) {
    showBanner('还没有配置模型：请到「设置」填入服务商 API Key，或切换一个可用模型。', {
      action: { label: '去设置', onClick: () => openSettings('model') }
    })
    return '还没配置模型 —— 打开「设置 → 服务商与模型」填入 API Key 后重试。'
  }
  if (code === 4001 || /session not found/i.test(msg)) {
    return '这个会话在核心里已经不在了（核心重启过）；正在用会话列表里的记录重新唤起，请重试一次。'
  }
  if (code === 4023 || /cannot delete an active session/i.test(msg)) {
    return '正在使用的会话不能直接删：先切到别的会话，或先关闭它再删。'
  }
  if (/401|invalid api key|unauthorized|authentication/i.test(`${code} ${msg}`)) {
    return 'API Key 无效或已失效：到「设置 → 服务商与模型」重新粘贴一次（注意别带空格）。'
  }
  if (/429|rate limit|too many requests/i.test(`${code} ${msg}`)) {
    return '触发了服务商限流：等几十秒再发，或在设置里换一个模型。'
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up|network/i.test(msg)) {
    return '网络连不上服务商：检查本机网络/代理，或稍后重试（核心需要能访问模型服务商的 API）。'
  }
  if (/insufficient|balance|quota|欠费|余额/i.test(msg)) {
    return '服务商侧额度/余额不足：去服务商控制台充值后再试。'
  }
  return msg
}

/** 切换默认模型（命令面板与模型下拉共用） */
async function switchModel(provider, model) {
  const res = await window.hermes.modelSet({ scope: 'main', provider, model })
  if (!res.ok) {
    showBanner(`切换模型失败：${explainError(res.error, res.code)}`, { error: true })
    return
  }
  state.model = res.data?.model || model
  $('session-label').textContent = `${provider} ${state.model}`
  const sel = $('model-select')
  for (const opt of sel.options) if (opt.value === `${provider}::${model}`) sel.value = opt.value
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

function emptyHint(text, { spinning = true } = {}) {
  clearThread()
  thread.appendChild(el('div', spinning ? 'empty' : 'empty static', text))
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
    const menuBtn = el('button', null, '⋯')
    menuBtn.title = '更多操作'
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      openMenu(sessionMenuItems(s, row, title))
    })
    acts.appendChild(menuBtn)
    line.appendChild(acts)
    row.appendChild(line)
    const meta = el('div', 'm', `${s.message_count ?? 0} 条消息`)
    meta.title = s.id
    row.appendChild(meta)
    row.addEventListener('click', () => activateSession(s.id))
    box.appendChild(row)
  }
}

/** 会话行的「⋯」菜单项（一个动作一处实现，命令面板里调用的是同一批函数） */
function sessionMenuItems(session, row, titleEl) {
  return [
    { id: 'rename', label: '重命名', run: () => startRename(row, titleEl, session.id) },
    { id: 'activate', label: '切换到该会话', run: () => activateSession(session.id) },
    { id: 'copy-id', label: '复制 session id', run: () => copyToClipboard(session.id, 'session id') },
    { id: 'export', label: '导出为 Markdown…', run: () => exportSession(session) },
    { id: 'branch', label: '从该会话分叉', run: () => branchSession(session.id) },
    { id: 'undo', label: '撤销该会话的上一轮', run: () => undoTurn(session.id) },
    { id: 'delete', label: '删除会话', danger: true, run: () => removeSession(session.id) }
  ]
}

/** 弹系统原生菜单（Electron 的 Menu.popup）：由壳负责，渲染层只给"有哪些动作、当前选中哪个"。
 *  这样不需要在渲染层算坐标、也不写内联样式（CSP style-src 'self' 下更省心）。 */
async function openMenu(items) {
  const res = await window.hermes.showContextMenu(
    items.map((i) => ({ id: i.id, label: i.label, danger: Boolean(i.danger), enabled: i.enabled !== false }))
  )
  const id = res?.ok ? res.data?.id : null
  if (!id) return
  const hit = items.find((i) => i.id === id)
  if (hit) hit.run()
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

/** 设置 · 诊断：把"出问题时要看的东西"一次列全（版本、契约、运行时、路径） */
function renderPanes(info) {
  const diag = $('diag-list')
  if (diag) {
    diag.textContent = ''
    for (const [k, v] of Object.entries(info)) {
      const row = el('div', 'kv')
      row.appendChild(el('b', null, k))
      row.appendChild(el('code', null, String(v)))
      diag.appendChild(row)
    }
  }
  const paths = $('path-list')
  if (paths) {
    paths.textContent = ''
    const rows = [
      ['核心数据（HERMES_HOME）', state.paths?.hermesHome],
      ['壳数据（偏好）', state.paths?.userData],
      ['随包运行时', state.paths?.runtime],
      ['会话工作目录', state.cwd]
    ]
    for (const [k, v] of rows) {
      const row = el('div', 'kv')
      row.appendChild(el('b', null, k))
      row.appendChild(el('code', null, v || '—'))
      paths.appendChild(row)
    }
  }
}

/** 诊断信息（一键复制用）：版本 + 路径 + 契约 + 最近日志 */
function diagnosticsText() {
  const lines = [
    `24H-OS ${state.shellVersion ?? '?'}（Electron ${state.electronVersion ?? '?'}）`,
    `核心 ${state.coreVersion ?? '?'} · 桌面契约 ${state.contract ?? '?'}（壳期望 ${EXPECTED_DESKTOP_CONTRACT}）`,
    `运行时 ${state.runtimeInfo ? `${state.runtimeInfo.coreVersion ?? '?'} / python ${state.runtimeInfo.python ?? '?'} / ${state.runtimeInfo.layout ?? '?'}` : '未读到清单'}`,
    `HERMES_HOME ${state.paths?.hermesHome ?? '?'}`,
    `userData ${state.paths?.userData ?? '?'}`,
    `会话 ${state.sessionId ?? '—'} · 模型 ${state.model || '—'}`,
    `主题 ${themePref} · 面板 ${state.panelOpen ? state.panelTab : '收起'} · 视图 ${state.view}`,
    '',
    '最近日志：',
    ...logLines.slice(-30)
  ]
  return lines.join('\n')
}

/* ───────────────────────── 视图 / 右侧面板 / 命令面板 ───────────────────────── */

const VIEWS = ['chat', 'skills', 'tasks', 'usage']

/** 一级导航切换：对话 / 技能 / 任务 / 用量 */
function setView(view) {
  if (!VIEWS.includes(view)) view = 'chat'
  state.view = view
  $('shell').dataset.view = view
  for (const v of VIEWS) {
    const btn = $(`nav-${v}`)
    if (btn) btn.classList.toggle('active', v === view)
  }
  $('side').hidden = view !== 'chat'
  $('chat-view').hidden = view !== 'chat'
  for (const v of ['skills', 'tasks', 'usage']) $(`page-${v}`).hidden = v !== view
  // 右侧面板只在对话页有意义
  $('panel').hidden = !(view === 'chat' && state.panelOpen)
  if (view === 'skills') renderSkillsPage()
  if (view === 'tasks') renderTasksPage()
  if (view === 'usage') renderUsagePage()
}

/** 右侧面板：文件 / 预览 / 日志 三个标签 */
function setPanelTab(tab) {
  state.panelTab = tab
  for (const t of ['files', 'preview', 'logs']) {
    $(`tab-${t}`).classList.toggle('active', t === tab)
    $(`pane-${t}`).hidden = t !== tab
  }
  if (tab === 'logs') drawer.scrollTop = drawer.scrollHeight
}
function showPanel(tab) {
  state.panelOpen = true
  const tab_ = tab || state.panelTab
  state.panelTab = tab_
  $('panel').hidden = false
  setPanelTab(tab_)
  if (tab_ === 'files' && !filesUI.path) openDir(state.cwd || '.')
}
function hidePanel() {
  state.panelOpen = false
  $('panel').hidden = true
}
function togglePanel(tab) {
  if (state.panelOpen && (!tab || tab === state.panelTab)) hidePanel()
  else showPanel(tab)
}

/* ── 命令面板（Ctrl/Cmd + K）─────────────────────────────────────────────
   功能一多，顶栏按钮一定会崩；上游桌面也是把这里当主入口。 */
function paletteCommands() {
  const cmds = [
    { title: '新建会话', hint: '对话', run: () => newSession() },
    { title: '刷新会话列表', hint: '对话', run: () => refreshSessions() },
    { title: '搜索会话', hint: '对话', run: () => { setView('chat'); $('search').focus() } },
    { title: '打开设置', hint: '设置', run: () => openSettings('model') },
    { title: '设置 · 外观', hint: '设置', run: () => openSettings('appearance') },
    { title: '设置 · 数据与目录', hint: '设置', run: () => openSettings('data') },
    { title: '设置 · 诊断', hint: '设置', run: () => openSettings('diagnostics') },
    { title: '设置 · 高级（自定义端点 / 更新 / 重启核心）', hint: '设置', run: () => openSettings('advanced') },
    { title: '面板 · 文件', hint: '面板', run: () => { setView('chat'); showPanel('files') } },
    { title: '面板 · 预览', hint: '面板', run: () => { setView('chat'); showPanel('preview') } },
    { title: '面板 · 日志', hint: '面板', run: () => { setView('chat'); showPanel('logs') } },
    { title: '面板 · 收起', hint: '面板', run: () => hidePanel() },
    { title: '跳到对话', hint: '导航', run: () => setView('chat') },
    { title: '跳到技能', hint: '导航', run: () => setView('skills') },
    { title: '跳到任务', hint: '导航', run: () => setView('tasks') },
    { title: '跳到用量', hint: '导航', run: () => setView('usage') },
    { title: '主题 · 跟随系统', hint: '外观', run: () => switchTheme('system') },
    { title: '主题 · 深色', hint: '外观', run: () => switchTheme('dark') },
    { title: '主题 · 浅色', hint: '外观', run: () => switchTheme('light') },
    { title: '导出当前会话（Markdown）', hint: '会话', run: () => exportCurrentSession() },
    { title: '撤销上一轮', hint: '会话', run: () => undoTurn() },
    { title: '从当前会话分叉', hint: '会话', run: () => branchSession() },
    { title: '复制诊断信息', hint: '诊断', run: () => copyDiagnostics() },
    { title: '打开核心数据目录', hint: '诊断', run: () => openRuntimeFolder() },
    { title: '重启核心', hint: '核心', run: () => restartCore() },
    { title: '检查更新', hint: '更新', run: () => checkUpdate() }
  ]
  for (const p of state.providers.filter((x) => x.authenticated)) {
    for (const m of p.models ?? []) {
      cmds.push({ title: `切换模型：${m}`, hint: '模型', run: () => switchModel(p.slug, m) })
    }
  }
  return cmds
}

function renderPalette() {
  const q = state.paletteQuery.trim().toLowerCase()
  const all = paletteCommands()
  const list = (q ? all.filter((c) => c.title.toLowerCase().includes(q)) : all).slice(0, 40)
  state.paletteItems = list
  if (state.paletteIndex >= list.length) state.paletteIndex = 0
  const box = $('palette-list')
  box.textContent = ''
  if (!list.length) {
    box.appendChild(el('div', 'empty static', '没有匹配的命令'))
    return
  }
  list.forEach((c, i) => {
    const row = el('div', 'palette-item' + (i === state.paletteIndex ? ' active' : ''))
    row.appendChild(el('span', 't', c.title))
    if (c.hint) row.appendChild(el('span', 'hint', c.hint))
    row.addEventListener('click', () => runPaletteItem(i))
    row.addEventListener('mousemove', () => {
      if (state.paletteIndex !== i) {
        state.paletteIndex = i
        renderPalette()
      }
    })
    box.appendChild(row)
  })
}

function openPalette() {
  state.paletteQuery = ''
  state.paletteIndex = 0
  $('palette-input').value = ''
  $('palette').hidden = false
  renderPalette()
  $('palette-input').focus()
}
function closePalette() {
  $('palette').hidden = true
}
function runPaletteItem(i) {
  const cmd = (state.paletteItems ?? [])[i]
  closePalette()
  if (cmd) cmd.run()
}

/* ── 右侧面板专用的服务端能力（技能 / 任务 / 用量）───────────────────── */
/** 核心的技能分组 key → 中文标题（核心只给英文 key，界面别再暴露英文） */
const SKILL_GROUP_LABELS = {
  'autonomous-ai-agents': '智能体与编码',
  creative: '创意与设计',
  devops: '运维与调试',
  documents: '文档处理',
  media: '媒体',
  email: '邮件',
  'note-taking': '笔记',
  research: '研究',
  data: '数据',
  apple: 'Apple 生态',
  communication: '沟通',
  productivity: '效率',
  system: '系统'
}
const groupLabel = (key) => SKILL_GROUP_LABELS[key] ?? key

async function renderSkillsPage() {
  const body = $('skills-body')
  const summary = $('skills-summary')
  if (!body.dataset.loaded) body.appendChild(el('div', 'empty static', '读取技能…'))
  const res = await window.hermes.skillsList().catch(() => ({ ok: false, error: '调用失败' }))
  if (!res.ok) {
    body.textContent = ''
    body.appendChild(el('div', 'empty static', `读取技能失败：${res.error}`))
    return
  }
  const data = res.data ?? {}
  const groups = data.skills ?? {}
  const total = Object.values(groups).reduce((n, list) => n + (Array.isArray(list) ? list.length : 0), 0)
  summary.textContent = `${total} 个技能（核心返回 ${Object.keys(groups).length} 组）`
  body.textContent = ''
  for (const [group, items] of Object.entries(groups)) {
    const sec = el('div', 'group')
    sec.appendChild(el('div', 'group-title', groupLabel(group)))
    for (const item of items ?? []) {
      const row = el('div', 'list-row')
      const raw = typeof item === 'string' ? item : item.name ?? ''
      const nice = String(raw).replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
      row.appendChild(el('div', 't', nice))
      row.title = raw
      const desc = typeof item === 'object' ? item.description : ''
      if (desc) row.appendChild(el('div', 'm', desc))
      sec.appendChild(row)
    }
    body.appendChild(sec)
  }
}

async function renderTasksPage() {
  const body = $('tasks-body')
  const summary = $('tasks-summary')
  const res = await window.hermes.cronList().catch(() => ({ ok: false, error: '调用失败' }))
  if (!res.ok) {
    body.textContent = ''
    body.appendChild(el('div', 'empty static', `读取定时任务失败：${res.error}`))
    return
  }
  const jobs = res.data?.jobs ?? []
  summary.textContent = jobs.length ? `${jobs.length} 个任务` : '还没有定时任务'
  body.textContent = ''
  if (!jobs.length) {
    body.appendChild(
      el('div', 'empty static', '还没有定时任务。定时任务由核心的 cron 管理，目前这个界面只做只读展示。')
    )
    return
  }
  for (const job of jobs) {
    const row = el('div', 'list-row')
    row.appendChild(el('div', 't', job.name || job.job_id || '（未命名任务）'))
    row.appendChild(el('div', 'm', `${job.schedule ?? '—'} · ${job.deliver ?? ''} ${job.next_run_at ? '· 下次 ' + job.next_run_at : ''}`))
    body.appendChild(row)
  }
}

async function renderUsagePage() {
  const body = $('usage-body')
  const summary = $('usage-summary')
  const [ins, bars] = await Promise.all([
    window.hermes.insights({ days: 30 }).catch(() => ({ ok: false })),
    window.hermes.usageBars().catch(() => ({ ok: false }))
  ])
  body.textContent = ''
  if (ins.ok) {
    const d = ins.data ?? {}
    summary.textContent = `最近 ${d.days ?? 30} 天`
    const card = el('div', 'stat-row')
    card.appendChild(stat('会话', d.sessions ?? 0))
    card.appendChild(stat('消息', d.messages ?? 0))
    body.appendChild(card)
  } else {
    body.appendChild(el('div', 'empty static', '读取用量失败（核心未就绪？）'))
  }
  const b = bars.ok ? bars.data ?? {} : {}
  if (b.available) {
    const sec = el('div', 'group')
    sec.appendChild(el('div', 'group-title', b.plan_name ? `套餐：${b.plan_name}` : '套餐'))
    if (b.total_spendable_display) sec.appendChild(el('div', 'list-row', `可用余额：${b.total_spendable_display}`))
    if (b.renews_display) sec.appendChild(el('div', 'list-row', `续期：${b.renews_display}`))
    body.appendChild(sec)
  } else {
    body.appendChild(
      el('div', 'hint', '账号用量（余额 / 套餐）需要登录上游账号，本版本未接入 —— 当前是"自带 API Key"模式。')
    )
  }
}

function stat(label, value) {
  const box = el('div', 'stat')
  box.appendChild(el('div', 'v', String(value)))
  box.appendChild(el('div', 'k', label))
  return box
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
  const res = await window.hermes.sessionCwdSet({ session_id: rid(), cwd: dir })
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
  state.runtimeSessionId = res.data?.session_id ?? null
  state.sessionId = res.data?.session_id ?? null // 新建会话时两者相同（还没落盘）
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
    emptyHint(`切换会话失败：${explainError(res.error, res.code)}`, { spinning: false })
    return
  }
  state.sessionId = id // 列表里的 id（高亮用）
  state.runtimeSessionId = res.data?.session_id ?? id // 核心的运行时 id（后续调用用它）
  checkContract(res.data?.info)
  paintCwd(res.data?.info?.cwd)
  await loadHistory(state.runtimeSessionId)
  renderSessions()
  refreshUsage()
}

async function loadHistory(id) {
  const target = id ?? rid()
  let res = await window.hermes.sessionHistory({ session_id: target })
  if (!res.ok && (res.code === 4001 || /session not found/i.test(res.error ?? ''))) {
    // 运行时不再持有它：让核心把它装回来（main 侧会做 resume 并把新 id 推给我们）
    const resumed = await window.hermes.sessionResume({ session_id: state.sessionId ?? target, cols: 100 })
    if (resumed.ok && resumed.data?.session_id) {
      state.runtimeSessionId = resumed.data.session_id
      res = await window.hermes.sessionHistory({ session_id: state.runtimeSessionId })
    }
  }
  if (!res.ok) {
    emptyHint(`读取历史失败：${explainError(res.error, res.code)}`, { spinning: false })
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

  const res = await window.hermes.send({ session_id: rid(), text })
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
  refreshUsage()
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
    case 'message.start': // 核心的回合开始事件（契约里的正式名字；曾经写成 turn.started，等于没接上）
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
        showBanner('首次启动：还没配置模型。到「设置 → 服务商与模型」填入 DeepSeek API Key 就能开始对话。', {
          action: { label: '去设置', onClick: () => openSettings('model') }
        })
      } else if (payload?.provider_configured === true) {
        hideBanner()
      }
      break
    case 'session.usage':
      // 核心主动推用量：直接更新上下文条，不用再额外问一次
      if (payload && (payload.context_percent != null || payload.total != null)) renderUsagePayload(payload)
      else refreshUsage()
      break
    case 'session.reclaimed':
      // 运行时按 LRU 回收了会话：不发消息就没事，下次发会自动 resume（4001 → 恢复路径）
      showBanner('这个会话已被运行时回收（内存紧张时会发生）。继续发消息会自动把它恢复回来。')
      break
    case 'message.interim':
      if (state.streaming && payload?.text) {
        state.streaming.msg.text += payload.text
        paintStream()
      }
      break
    case 'subagent.thinking':
    case 'subagent.tool':
      // 子智能体活动：目前只在工具区提示，完整 UI 留到后面做
      if (payload?.name) $('turn-state').textContent = `子任务：${payload.name}`
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
  state.panelOpen = true
  $('panel').hidden = false
  setPanelTab('files')
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
  showPanel('preview') // 预览统一在右侧面板的"预览"标签里
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

// 面板开合统一走 showPanel/hidePanel/togglePanel（见"视图 / 右侧面板"一节）

/* ───────────────────────── 日志 / 状态 ───────────────────────── */

const logLines = []
function appendLog(entry) {
  logLines.push(entry.line)
  if (logLines.length > 800) logLines.shift()
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

async function refreshDiagnostics() {
  // 一次性把"出问题要看的东西"取齐：壳版本 / 核心版本 / 契约 / 运行时清单 / 路径
  const [st, rt, inf] = await Promise.all([
    window.hermes.state().catch(() => ({ ok: false })),
    window.hermes.runtimeInfo().catch(() => ({ ok: false })),
    window.hermes.uiInfo().catch(() => ({ ok: false }))
  ])
  const s = st?.data ?? {}
  state.runtimeInfo = rt?.ok ? rt.data?.manifest ?? null : null
  state.paths = inf?.ok ? inf.data?.paths ?? null : state.paths
  state.shellVersion = inf?.ok ? inf.data?.appVersion ?? state.shellVersion : state.shellVersion
  state.electronVersion = inf?.ok ? inf.data?.electronVersion ?? state.electronVersion : state.electronVersion
  if (s.phase === 'ready' && state.coreVersion == null) {
    const health = await window.hermes.health().catch(() => null)
    if (health?.ok) state.coreVersion = health.data?.version ?? null
  }
  renderPanes({
    核心状态: s.phase ?? '-',
    端口: s.port ?? '-',
    核心版本: state.coreVersion ?? '读取中…',
    桌面契约: `${state.contract ?? '-'}（期望 ${EXPECTED_DESKTOP_CONTRACT}）`,
    运行时核心: state.runtimeInfo?.coreVersion ?? '未读到清单',
    运行时构建: state.runtimeInfo?.builtAt ?? '-',
    壳版本: state.shellVersion ?? '-',
    Electron: state.electronVersion ?? '-',
    会话: state.sessionId ?? '-',
    模型: state.model || '-'
  })
}
function refreshRunInfo() {
  refreshDiagnostics()
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

/* ───────────────────── 会话动作（导出 / 撤销 / 分叉）───────────────────── */

async function copyToClipboard(text, what = '内容') {
  if (!text) {
    showBanner(`没有可复制的${what}`, { error: true })
    return
  }
  const res = await window.hermes.copyText(String(text))
  if (!res.ok) showBanner(`复制失败：${res.error}`, { error: true })
}

/** 把会话历史拼成 Markdown（导出用；标题、时间、工具调用都带上） */
function historyToMarkdown(session, messages) {
  const lines = [`# ${session.title || session.id}`, '', `- 会话：\`${session.id}\``, `- 导出时间：${new Date().toLocaleString()}`, '']
  for (const m of messages) {
    const role = m.role === 'user' ? '你' : m.role === 'assistant' ? '24H' : m.role
    const text =
      typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content.map((c) => c.text ?? '').join('')
          : ''
    if (!text) continue
    lines.push(`## ${role}`, '', text, '')
  }
  return lines.join('\n')
}

async function exportSession(session) {
  const hist = await window.hermes.sessionHistory({ session_id: session.id })
  if (!hist.ok) {
    showBanner(`导出失败：读不到会话历史（${hist.error}）`, { error: true })
    return
  }
  const md = historyToMarkdown(session, hist.data?.messages ?? [])
  const safeTitle = String(session.title || session.id).replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)
  const res = await window.hermes.saveTextFile({ defaultName: `${safeTitle}.md`, content: md })
  if (!res.ok) {
    showBanner(`导出失败：${res.error}`, { error: true })
    return
  }
  if (res.data?.path) showBanner(`已导出：${res.data.path}`, { action: { label: '打开目录', onClick: () => window.hermes.openPath(res.data.path) } })
}

async function exportCurrentSession() {
  const session = state.sessions.find((s) => s.id === state.sessionId) ?? { id: state.sessionId, title: state.sessionId }
  if (!session.id) {
    showBanner('还没有可导出的会话', { error: true })
    return
  }
  await exportSession(session)
}

async function undoTurn(sessionId = state.sessionId) {
  if (!sessionId) return
  const res = await window.hermes.sessionUndo({ session_id: sessionId })
  if (!res.ok) {
    showBanner(`撤销失败：${explainError(res.error, res.code)}`, { error: true })
    return
  }
  if (sessionId === state.sessionId) await loadHistory(sessionId)
  await refreshSessions()
}

async function branchSession(sessionId = state.sessionId) {
  if (!sessionId) return
  const res = await window.hermes.sessionBranch({ session_id: sessionId })
  if (!res.ok) {
    showBanner(`分叉失败：${explainError(res.error, res.code)}`, { error: true })
    return
  }
  await refreshSessions()
  const newId = res.data?.session_id ?? res.data?.id
  if (newId) await activateSession(newId)
  showBanner('已从当前会话分叉出新会话')
}

/* ───────────────────── 诊断 / 更新 / 连通性 ───────────────────── */

async function copyDiagnostics() {
  const res = await window.hermes.copyText(diagnosticsText())
  const st = $('diag-status')
  if (st) st.textContent = res.ok ? '诊断信息已复制到剪贴板（可直接发给技术支持）' : `复制失败：${res.error}`
}

async function openRuntimeFolder() {
  const dir = state.paths?.hermesHome
  if (!dir) {
    showBanner('还没读到核心数据目录', { error: true })
    return
  }
  await window.hermes.openPath(dir)
}

async function restartCore() {
  const status = $('settings-status') ?? $('conn-status')
  if (status) status.textContent = '正在重启核心…'
  const res = await window.hermes.restart()
  if (status) status.textContent = res.ok ? '核心已重启。' : `重启失败：${res.error}`
}

async function testConnection() {
  const st = $('conn-status')
  st.textContent = '正在测试（会向核心要一次运行时自检）…'
  const res = await window.hermes.runtimeCheck({}).catch(() => ({ ok: false, error: '调用失败' }))
  if (!res.ok) {
    st.textContent = `测试失败：${res.error}`
    return
  }
  const d = res.data ?? {}
  if (d.ok) {
    st.textContent = `连接正常（${d.provider ?? state.model ?? '已配置服务商'}）`
  } else {
    st.textContent = `还没就绪：${explainError(d.error ?? '未知原因', d.code)}`
  }
}

/** 设置 · 高级：运行时列表（多份并存时可切换；切换会重启核心） */
async function renderRuntimeList() {
  const box = $('runtime-list')
  if (!box) return
  const res = await window.hermes.runtimeList().catch(() => ({ ok: false, error: '调用失败' }))
  box.textContent = ''
  if (!res.ok) {
    box.appendChild(el('div', 'hint', `读取运行时列表失败：${res.error}`))
    return
  }
  const data = res.data ?? {}
  const list = data.candidates ?? []
  if (!list.length) {
    box.appendChild(el('div', 'hint', '没有找到运行时目录（开发模式下可能来自 PATH 上的 hermes）'))
    return
  }
  const kindLabel = { current: '当前默认', previous: '上一份（回退用）', archived: '历史版本', downloaded: '已下载（分发源）' }
  const distInput = $('dist-url')
  if (distInput && document.activeElement !== distInput) distInput.value = data.distUrl ?? distInput.value
  for (const item of list) {
    const row = el('div', 'kv')
    const left = el('span')
    left.appendChild(el('code', null, item.name))
    left.appendChild(el('span', 'hint', ` ${kindLabel[item.kind] ?? ''}${item.coreVersion ? ' · 核心 ' + item.coreVersion : ''}${item.coreCommit ? ' · ' + item.coreCommit.slice(0, 8) : ''}`))
    row.appendChild(left)
    const right = el('span')
    const btn = el(
      'button',
      null,
      data.pinned === item.dir ? '使用中' : item.usable ? '切换到此运行时' : '不可用'
    )
    btn.disabled = data.pinned === item.dir || !item.usable
    btn.addEventListener('click', async () => {
      $('runtime-status').textContent = `正在切换到 ${item.name} 并重启核心…`
      const act = await window.hermes.runtimeActivate({ dir: item.dir })
      $('runtime-status').textContent = act.ok ? `已切换到 ${item.name}，核心已重启。` : `切换失败：${act.error}`
      renderRuntimeList()
      refreshDiagnostics()
    })
    right.appendChild(btn)
    row.appendChild(right)
    box.appendChild(row)
  }
}

/** 运行时分发源：保存地址 / 检查更新 / 下载安装（下载走壳，进度由 runtime:download 事件推回来） */
async function saveDistUrl() {
  const url = $('dist-url').value.trim()
  const res = await window.hermes.runtimeDist({ url }).catch(() => ({ ok: false, error: '调用失败' }))
  $('dist-status').textContent = res.ok ? (url ? `已保存分发源：${url}` : '已清空分发源地址') : `保存失败：${res.error}`
}

async function checkRuntimeUpdate() {
  const st = $('dist-status')
  st.textContent = '正在读取分发源清单…'
  const res = await window.hermes.runtimeCheckUpdate().catch(() => ({ ok: false, error: '调用失败' }))
  if (!res.ok) {
    st.textContent = `检查失败：${res.error}`
    return null
  }
  const d = res.data ?? {}
  if (!d.configured) {
    st.textContent = d.message
    return null
  }
  if (d.error) {
    st.textContent = `检查失败：${d.error}`
    return null
  }
  st.textContent = (d.message ?? '') + (d.installed?.length ? `（已下载：${d.installed.join(', ')}）` : '')
  return d
}

async function installRuntime() {
  const st = $('dist-status')
  const btn = $('btn-runtime-install')
  st.textContent = '正在下载运行时…'
  btn.disabled = true
  try {
    const res = await window.hermes.runtimeInstall().catch((err) => ({ ok: false, error: String(err?.message ?? err) }))
    if (!res.ok) {
      st.textContent = `安装失败：${res.error}`
      return
    }
    st.textContent = `已安装运行时 ${res.data?.coreVersion ?? ''}，可在上面列表里切换使用。`
    renderRuntimeList()
  } finally {
    btn.disabled = false
  }
}

window.hermes.onRuntimeDownload?.((progress) => {
  const st = $('dist-status')
  if (!st) return
  if (progress?.stage === 'download') {
    const pct = progress.percent != null ? `${progress.percent}%` : `${(Number(progress.received || 0) / 1024 / 1024).toFixed(0)} MB`
    st.textContent = `正在下载：${pct}`
  } else if (progress?.message) {
    st.textContent = `${progress.message}`
  }
})

async function checkUpdate() {
  const st = $('update-status')
  st.textContent = '正在检查…'
  const res = await window.hermes.updateCheck().catch(() => ({ ok: false, error: '调用失败' }))
  if (!res.ok) {
    st.textContent = `检查失败：${res.error}`
    return
  }
  const d = res.data ?? {}
  st.textContent = d.message ?? (d.available ? `发现新版本 ${d.version}` : '已是最新版本')
}

/* ───────────────────── 上下文用量 ───────────────────── */

/** 把用量对象画到输入框上方的上下文条（事件推送与主动查询共用一处实现） */
function renderUsagePayload(d) {
  const pct = typeof d.context_percent === 'number' ? Math.round(d.context_percent) : null
  const parts = []
  if (pct != null) parts.push(`上下文 ${pct}%`)
  if (d.context_used != null && d.context_max != null) parts.push(`${d.context_used}/${d.context_max}`)
  else if (d.total) parts.push(`${d.total} tokens`)
  if (d.cost_usd) parts.push(`$${Number(d.cost_usd).toFixed(4)}`)
  if (d.avg_tps) parts.push(`${Math.round(d.avg_tps)} tok/s`)
  const node = $('context-usage')
  node.textContent = parts.join(' · ')
  node.title = JSON.stringify(d, null, 1).slice(0, 800)
}

async function refreshUsage() {
  if (!state.sessionId) {
    $('context-usage').textContent = ''
    return
  }
  const res = await window.hermes.sessionUsage({ session_id: rid() }).catch(() => ({ ok: false }))
  if (!res.ok) {
    $('context-usage').textContent = ''
    return
  }
  renderUsagePayload(res.data ?? {})
}

/* ───────────────────────── 事件绑定 ───────────────────────── */

for (const v of ['chat', 'skills', 'tasks', 'usage']) {
  const btn = $(`nav-${v}`)
  if (btn) btn.addEventListener('click', () => setView(v))
}
$('nav-settings').addEventListener('click', () => openSettings('model'))
$('btn-palette').addEventListener('click', openPalette)
$('palette-input').addEventListener('input', (e) => {
  state.paletteQuery = e.target.value
  state.paletteIndex = 0
  renderPalette()
})
$('palette-input').addEventListener('keydown', (e) => {
  const items = state.paletteItems ?? []
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    state.paletteIndex = Math.min(state.paletteIndex + 1, Math.max(items.length - 1, 0))
    renderPalette()
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    state.paletteIndex = Math.max(state.paletteIndex - 1, 0)
    renderPalette()
  } else if (e.key === 'Enter') {
    e.preventDefault()
    runPaletteItem(state.paletteIndex)
  }
})
$('palette').addEventListener('click', (e) => {
  if (e.target === $('palette')) closePalette()
})
$('btn-new').addEventListener('click', newSession)
$('btn-refresh').addEventListener('click', refreshSessions)
$('btn-send').addEventListener('click', send)
$('btn-stop').addEventListener('click', async () => {
  if (!state.sessionId) return
  await window.hermes.sessionInterrupt({ session_id: rid() })
  finishStream()
})
$('btn-cwd').addEventListener('click', pickCwd)
// 右侧面板（文件 / 预览 / 日志 三个标签，替代原来的"文件右栏 + 日志底抽屉"）
$('btn-panel').addEventListener('click', () => togglePanel())
$('btn-panel-close').addEventListener('click', hidePanel)
for (const t of ['files', 'preview', 'logs']) $(`tab-${t}`).addEventListener('click', () => showPanel(t))
$('btn-files-refresh').addEventListener('click', () => (filesUI.path ? openDir(filesUI.path) : showPanel('files')))
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
function setSettingsSection(sec) {
  const panes = document.querySelectorAll('.settings-pane')
  const navs = document.querySelectorAll('#settings-nav button')
  let hit = false
  panes.forEach((pane) => {
    const on = pane.dataset.sec === sec
    pane.hidden = !on
    if (on) hit = true
  })
  navs.forEach((b) => b.classList.toggle('active', b.dataset.sec === sec && hit))
  if (!hit && panes.length) setSettingsSection(panes[0].dataset.sec)
}
function closeSettings() {
  $('settings').hidden = true
}
function openSettings(section) {
  $('settings').hidden = false
  if (section) setSettingsSection(section)
  markThemeSegment()
  loadSettingsForm()
  renderRuntimeList()
}
document.querySelectorAll('#settings-nav button').forEach((b) =>
  b.addEventListener('click', () => setSettingsSection(b.dataset.sec))
)

/** 主题：一个动作一处状态（顶栏按钮、设置里的分段、命令面板都走这里） */
function switchTheme(pref) {
  applyTheme(pref)
  persistTheme(pref)
  markThemeSegment()
}
function markThemeSegment() {
  document.querySelectorAll('#theme-seg button').forEach((b) => {
    b.classList.toggle('active', b.dataset.themePref === themePref)
  })
}
document.querySelectorAll('#theme-seg button').forEach((b) =>
  b.addEventListener('click', () => switchTheme(b.dataset.themePref))
)
$('btn-theme').addEventListener('click', () => {
  switchTheme((document.documentElement.dataset.theme || 'dark') === 'dark' ? 'light' : 'dark')
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
  if ((e.metaKey || e.ctrlKey) && String(e.key).toLowerCase() === 'k') {
    e.preventDefault()
    openPalette()
    return
  }
  if (e.key === 'Escape') {
    if (!$('palette').hidden) closePalette()
    else if (!$('settings').hidden) closeSettings()
  }
})
$('btn-save-settings').addEventListener('click', saveSettings)
$('btn-ce-save').addEventListener('click', saveCustomEndpoint)
$('btn-restart-core').addEventListener('click', () => restartCore())
$('btn-test-connection').addEventListener('click', () => testConnection())
$('btn-refresh-models').addEventListener('click', async () => {
  const st = $('conn-status')
  st.textContent = '正在重新读取模型名单…'
  await refreshModels()
  st.textContent = state.providers.some((p) => p.authenticated) ? '模型名单已更新。' : '还没检测到已配置 Key 的服务商。'
  renderProviderSelect()
})
$('btn-open-cwd').addEventListener('click', async () => {
  const dir = state.cwd
  const st = $('cwd-status')
  if (!dir) {
    st.textContent = '当前会话还没有工作目录'
    return
  }
  const res = await window.hermes.openPath(dir)
  st.textContent = res.ok ? `已打开 ${dir}` : `打开失败：${res.error}`
})
$('btn-copy-cwd').addEventListener('click', async () => {
  const st = $('cwd-status')
  const res = await window.hermes.copyText(state.cwd || '')
  st.textContent = res.ok ? '已复制工作目录路径' : `复制失败：${res.error}`
})
$('btn-copy-diagnostics').addEventListener('click', () => copyDiagnostics())
$('btn-open-log-dir').addEventListener('click', () => {
  closeSettings()
  showPanel('logs')
})
$('btn-check-update').addEventListener('click', () => checkUpdate())
$('btn-dist-save').addEventListener('click', () => saveDistUrl())
$('btn-runtime-check').addEventListener('click', () => checkRuntimeUpdate())
$('btn-runtime-install').addEventListener('click', () => installRuntime())
$('model-select').addEventListener('change', async (e) => {
  const [provider, model] = String(e.target.value).split('::')
  if (!model) return
  await switchModel(provider, model)
})
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    send()
  }
})

/** 启动阶段：壳按顺序推 stage，界面把"走到哪一步"画成清单 */
const BOOT_STEPS = [
  { key: 'spawn', label: '启动核心进程' },
  { key: 'ready', label: '核心就绪（握手）' },
  { key: 'gateway', label: '建立实时通道' },
  { key: 'data', label: '读取会话与模型' }
]
function renderBootProgress(progress) {
  const stage = progress?.stage ?? 'spawn'
  const idx = BOOT_STEPS.findIndex((s) => s.key === stage)
  clearThread()
  const box = el('div', 'boot')
  box.appendChild(el('div', 'boot-title', progress?.message ?? '正在启动核心…'))
  BOOT_STEPS.forEach((step, i) => {
    const state = idx < 0 ? '' : i < idx ? 'done' : i === idx ? 'active' : ''
    const row = el('div', `boot-step ${state}`)
    row.appendChild(el('span', 'bullet'))
    row.appendChild(el('span', 't', step.label))
    if (i === idx && progress?.message) row.appendChild(el('span', 'm', progress.message))
    box.appendChild(row)
  })
  box.appendChild(el('div', 'hint', '首次启动会建运行时环境，可能 1–2 分钟（杀毒软件扫描时更久）。'))
  thread.appendChild(box)
}
window.hermes.onBootProgress?.((progress) => {
  state.bootProgress = progress
  if (state.corePhase !== 'ready') renderBootProgress(progress)
})

window.hermes.onState((s) => {
  setCoreState(s.phase, s)
  if (s.phase === 'starting') {
    showBanner('核心正在启动…（首次启动要建运行时环境，可能 1–2 分钟，杀软扫描时更久）', {
      action: { label: '看日志', onClick: () => showPanel('logs') }
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
window.hermes.onSessionRemapped?.(({ from, to }) => {
  // 核心把会话装回运行时后 id 会变；不改就会一直 4001（实机上表现为"读取历史失败"）
  state.runtimeSessionId = to
  logLines.push(`[壳] 会话 id 已重映射：${from} → ${to}`)
})
window.hermes.onEvent(onGatewayEvent)

/* ───────────────────────── 启动 ───────────────────────── */

/** 核心就绪后要跑一次（且只跑一次首屏初始化）。
 *  窗口比核心先就绪是常态（核心要拉 python 起来，几秒到几十秒），所以这条路径
 *  必须由 onReady 也能触发 —— 否则模型列表/会话列表永远停在「读取中…」。 */
let coreReadyLoaded = false
async function afterCoreReady() {
  await refreshModels()
  await refreshSessions()
  await refreshDiagnostics()
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
    renderBootProgress(state.bootProgress)
    return
  }
  await afterCoreReady()
}

boot()
