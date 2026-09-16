/**
 * 渲染进程：会话列表 + 对话流（流式）+ 模型选择 + 设置。
 * 只通过 window.hermes 与主进程通信；所有调用返回 {ok,data} | {ok,error}。
 */
const $ = (id) => document.getElementById(id)
const LIMIT = { MESSAGES: 400, LOGS: 300 }
/** 壳期望的核心「桌面契约」版本（session.create 的 info.desktop_contract）。
 *  实测：0.21.0 → 6，0.21.3 → 7；随包运行时用的是 0.21.3，所以这里是 7。
 *  核心过旧/过新都会在顶部告警条提示，避免静默不兼容。 */
const EXPECTED_DESKTOP_CONTRACT = 7

const state = {
  sessionId: null, // 当前活跃会话（核心给的短 id）
  sessions: [],
  providers: [],
  model: '',
  streaming: null, // { text, thinking, tools: Map }
  busy: false,
  tokens: 0,
  cwd: '',
  contract: null,
  providerReady: null,
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

  const bubble = el('div', 'bubble', msg.text ?? '')
  bubble.dataset.role = 'text'
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
    row.appendChild(el('div', 'm', `${s.message_count ?? 0} 条 · ${s.id}`))
    row.addEventListener('click', () => activateSession(s.id))
    box.appendChild(row)
  }
}

/** 行内改名（Electron 里没有 window.prompt） */
function startRename(row, titleEl, id) {
  const input = el('input')
  input.value = titleEl.textContent
  input.className = 'rename'
  input.style.cssText = 'width:100%;padding:3px 6px;font-size:12.5px'
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
  if (!state.providers.length) {
    sel.appendChild(new Option('模型：无可用服务商', ''))
    return
  }
  for (const p of state.providers) {
    const models = p.models?.length ? p.models : ['default']
    for (const m of models) {
      const label = `${p.name || p.slug}${p.is_current ? '（当前）' : ''} · ${m}`
      sel.appendChild(new Option(label, `${p.slug}::${m}`))
    }
  }
  if (state.model) {
    for (const opt of sel.options) if (opt.value.endsWith(`::${state.model}`)) sel.value = opt.value
  }
}

function renderProviderSelect() {
  const sel = $('set-provider')
  sel.textContent = ''
  for (const p of state.providers) {
    sel.appendChild(new Option(`${p.name || p.slug}${p.is_current ? '（当前）' : ''}`, p.slug))
  }
  if (!state.providers.length) sel.appendChild(new Option('（未读到服务商）', ''))
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
  state.providers = res.data?.providers ?? []
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
  $('files-path').textContent = filesUI.path || '—'
  if (!filesUI.entries.length) {
    box.appendChild(el('div', 'empty', '空目录'))
    return
  }
  for (const e of filesUI.entries) {
    const row = el('div', 'entry')
    row.appendChild(el('span', 'ico', e.isDirectory ? '📁' : '📄'))
    row.appendChild(el('span', null, e.name))
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
  $('core-state').textContent = phase + (extra.port ? ` :${extra.port}` : '')
  $('dot').className = 'dot ' + phase
  $('gw-chip').hidden = phase !== 'ready'
  if (phase === 'ready') refreshRunInfo()
}

function setGatewayState(connected) {
  $('gw-state').textContent = connected ? '已连接' : '未连接'
}

function refreshRunInfo() {
  window.hermes.state().then((s) => {
    renderRunInfo({
      核心: s.phase,
      端口: s.port ?? '-',
      会话: state.sessionId ?? '-',
      模型: state.model || '-'
    })
  })
}

/* ───────────────────────── 设置 ───────────────────────── */

async function loadSettingsForm() {
  const cfg = await window.hermes.configGet()
  if (cfg.ok) {
    const c = cfg.data ?? {}
    $('set-model').value = c.model ?? state.model ?? ''
    window.__cfg = c
  }
  renderProviderSelect()
  refreshRunInfo()
}

async function saveSettings() {
  const provider = $('set-provider').value
  const key = $('set-key').value.trim()
  const model = $('set-model').value.trim()
  const status = $('settings-status')
  status.textContent = ''
  try {
    if (key && provider) {
      const r = await window.hermes.modelSaveKey({ provider, api_key: key, key })
      if (!r.ok) throw new Error(`保存 Key 失败：${r.error}`)
      $('set-key').value = ''
      status.textContent = `已保存 ${provider} 的 Key。`
    }
    if (model) {
      const r = await window.hermes.modelSet({ model, provider: provider || undefined })
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
$('btn-settings').addEventListener('click', async () => {
  $('settings').hidden = false
  await loadSettingsForm()
})
$('btn-close-settings').addEventListener('click', () => {
  $('settings').hidden = true
})
$('btn-save-settings').addEventListener('click', saveSettings)
$('btn-restart-core').addEventListener('click', async () => {
  const status = $('settings-status')
  status.textContent = '正在重启核心…'
  const res = await window.hermes.restart()
  status.textContent = res.ok ? '核心已重启。' : `重启失败：${res.error}`
})
$('model-select').addEventListener('change', async (e) => {
  const [provider, model] = String(e.target.value).split('::')
  if (!model) return
  const res = await window.hermes.modelSet({ provider, model })
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

window.hermes.onState((s) => setCoreState(s.phase, s))
window.hermes.onReady(({ port }) => setCoreState('ready', { port }))
window.hermes.onRuntimeError(({ message }) => {
  setCoreState('failed')
  renderMessage({ role: 'error', text: `核心启动失败：${message}` })
})
window.hermes.onRuntimeExit(() => setCoreState('exited'))
window.hermes.onLog(appendLog)
window.hermes.onGatewayStatus(({ connected }) => setGatewayState(connected))
window.hermes.onEvent(onGatewayEvent)

/* ───────────────────────── 启动 ───────────────────────── */

async function boot() {
  const s = await window.hermes.state()
  setCoreState(s.phase, s)
  for (const e of s.logs ?? []) appendLog(e)
  if (s.phase !== 'ready') {
    emptyHint('正在启动核心…')
    return
  }
  await refreshModels()
  await refreshSessions()
  paintCwd('')
  if (state.sessions.length) await activateSession(state.sessions[0].id)
  else await newSession()
  refreshRunInfo()
}

boot()
