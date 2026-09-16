/** 渲染进程：只通过 window.hermes 与主进程通信（无 Node 权限）。 */
const $ = (id) => document.getElementById(id)

const logsEl = $('logs')
const MAX_LINES = 300

function appendLog({ line, stream }) {
  const div = document.createElement('div')
  div.textContent = line
  if (stream === 'stderr') div.className = 'err'
  else if (/HERMES_BACKEND_READY|listening on/.test(line)) div.className = 'hi'
  logsEl.appendChild(div)
  while (logsEl.childElementCount > MAX_LINES) logsEl.removeChild(logsEl.firstChild)
  logsEl.scrollTop = logsEl.scrollHeight
}

function paintPhase(phase, extra = {}) {
  $('phase').textContent = phase
  $('dot').className = 'dot ' + phase
  $('s-phase').textContent = phase
}

function paintPort(baseUrl, port) {
  $('s-port').textContent = port ?? '-'
  $('s-url').textContent = baseUrl ?? '-'
}

async function refresh() {
  const info = await window.hermes.info()
  if (!info) return
  if (info.error) {
    $('s-health').textContent = info.error
    return
  }
  const h = info.health || {}
  $('s-version').textContent = h.version ?? '-'
  $('s-health').textContent = h.ok ? 'ok' : 'not ok'
  $('s-auth').textContent = h.auth_required ? '需要 token' : '未启用'
  if (info.status?.release_date) $('s-version').textContent += ` (${info.status.release_date})`
}

window.hermes.onState((state) => {
  paintPhase(state.phase)
  if (state.port) paintPort(state.baseUrl, state.port)
})

window.hermes.onLog(appendLog)

window.hermes.onReady(({ port, baseUrl }) => {
  paintPhase('ready')
  paintPort(baseUrl, port)
  refresh()
})

window.hermes.onError(({ message }) => {
  paintPhase('failed')
  appendLog({ line: `核心启动失败：${message}`, stream: 'stderr' })
})

window.hermes.onExit((info) => {
  paintPhase('exited')
  appendLog({ line: `核心进程已退出：${JSON.stringify(info)}`, stream: 'stderr' })
})

$('refresh').addEventListener('click', refresh)
$('restart').addEventListener('click', async () => {
  paintPhase('restarting')
  await window.hermes.restart()
})
$('docs').addEventListener('click', async () => {
  const info = await window.hermes.state()
  if (info.port) window.hermes.openExternal(`http://127.0.0.1:${info.port}/docs`)
})

// 首屏：把已缓冲的日志补上
window.hermes.state().then((state) => {
  paintPhase(state.phase)
  if (state.port) paintPort(state.baseUrl, state.port)
  for (const entry of state.logs || []) appendLog(entry)
  if (state.phase === 'ready') refresh()
})
