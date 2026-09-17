/**
 * 孤儿核心回收：壳被强杀（任务管理器结束进程、崩溃、断电）时，核心子进程会活下来，
 * 占着端口与内存；用户下次打开可能连到"上一世"的核心上（本机实测见过一个跑了几十分钟的孤儿）。
 *
 * 策略（保守，只清理"确实是孤儿"的）：
 *   ① 可执行文件必须是 python（Linux/macOS 取 `comm`；Windows 取进程名 Name）
 *      —— 只看"命令行里出现过这些字"会误杀包装它的 shell/grep（实测误杀过一次 `bash -c …`）；
 *   ② 参数形态是壳启动核心的那套：`-m hermes_cli.main` + `serve` + `--port 0`；
 *   ③ 父进程已经不在（Linux/macOS: PPID=1；Windows: 父 PID 不存在）；
 *   ④ 存活超过 minAgeSeconds（默认 60s）——避免误杀"刚启动、父进程信息还不稳定"的进程。
 *
 * 只在本机执行、只针对这一种形态，不动用户其它 Hermes 进程（例如 ~/.hermes 的 CLI 会话）。
 */
import { execFileSync } from 'node:child_process'

export const PY_EXECUTABLE = /^(?:.*[\\/])?python[\d.]*(?:\.exe)?$/i

/** 取 argv[0]（命令行第一个 token；带引号的路径要整段取，例如 "C:\Program Files\x\python.exe"） */
export function firstCommandToken(args) {
  const text = String(args || '').trim()
  if (!text) return ''
  if (text.startsWith('"') || text.startsWith("'")) {
    const end = text.indexOf(text[0], 1)
    if (end > 0) return text.slice(1, end)
  }
  return text.split(/\s+/)[0]
}

/**
 * 命令行形态判定。可执行文件是否 python 有两种判据，任一成立即可：
 *   · argv[0] 是 python 路径（Linux 上实测核心的 argv[0] 就是 venv 里的 python）；
 *   · 进程名（ps comm / Windows Name）是 python*。
 * 为什么不能只看进程名：核心会把进程标题改成 hermes（实测 comm = "hermes"），
 * 只看 comm 会漏掉真核心；只看"命令行里出现过这些字"又会误杀包装它的 bash。
 */
export function looksLikeCoreCommand(executable, args) {
  const exe = String(executable || '').trim()
  const text = String(args || '').trim()
  if (!text) return false
  const argv0 = firstCommandToken(text)
  if (!PY_EXECUTABLE.test(exe) && !PY_EXECUTABLE.test(argv0)) return false
  if (!/-m\s+hermes_cli\.main\b/.test(text)) return false
  if (!/\bserve\b/.test(text)) return false
  if (!/--port\s+0\b/.test(text)) return false
  return true
}

/** 纯函数：从 `ps -eo pid=,ppid=,etimes=,comm=,args=` 的输出里挑出孤儿核心 */
export function pickOrphanCores(psOutput, { minAgeSeconds = 60 } = {}) {
  const out = []
  for (const line of String(psOutput || '').split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/)
    if (!m) continue
    const [, pid, ppid, etimes, comm, args] = m
    if (Number(ppid) !== 1) continue // 父进程还在（或被别的进程收养）→ 不归我们管
    if (Number(etimes) < minAgeSeconds) continue
    if (!looksLikeCoreCommand(comm, args)) continue
    out.push({ pid: Number(pid), ageSeconds: Number(etimes), args })
  }
  return out
}

/** Windows：从 Get-CimInstance 的结果里挑孤儿（父 PID 已不存在） */
export function pickOrphanCoresWindows(processes, { minAgeSeconds = 60, now = Date.now() } = {}) {
  const list = Array.isArray(processes) ? processes : []
  const alive = new Set(list.map((p) => Number(p.ProcessId)))
  const out = []
  for (const p of list) {
    if (!looksLikeCoreCommand(p.Name || '', String(p.CommandLine || ''))) continue
    const ppid = Number(p.ParentProcessId)
    if (ppid !== 0 && alive.has(ppid)) continue // 父进程还活着
    const raw = String(p.CreationDate || '')
    let startedAt = null
    const ms = raw.match(/\/Date\((\d+)\)\//)
    if (ms) startedAt = Number(ms[1])
    else if (raw) startedAt = Date.parse(raw)
    if (startedAt && now - startedAt < minAgeSeconds * 1000) continue
    out.push({ pid: Number(p.ProcessId), args: String(p.CommandLine || '') })
  }
  return out
}

/** 执行回收；返回 { found, killed }。dryRun 只报告不杀。 */
export function sweepOrphanCores({ minAgeSeconds = 60, log = () => {}, dryRun = false } = {}) {
  try {
    let orphans = []
    if (process.platform === 'win32') {
      const raw = execFileSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          "Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'python*' } | Select-Object ProcessId,ParentProcessId,Name,CommandLine,CreationDate | ConvertTo-Json -Compress"
        ],
        { encoding: 'utf8', timeout: 20000, windowsHide: true }
      )
      const parsed = raw.trim() ? JSON.parse(raw) : []
      orphans = pickOrphanCoresWindows(Array.isArray(parsed) ? parsed : [parsed], { minAgeSeconds })
    } else {
      const raw = execFileSync('ps', ['-eo', 'pid=,ppid=,etimes=,comm=,args='], { encoding: 'utf8', timeout: 10000 })
      orphans = pickOrphanCores(raw, { minAgeSeconds })
    }
    const killed = []
    for (const o of orphans) {
      if (dryRun) {
        log(`[壳] （演练）发现孤儿核心 pid=${o.pid}，已存活 ${o.ageSeconds ?? '?'}s`)
        continue
      }
      try {
        process.kill(o.pid)
        killed.push(o.pid)
        log(`[壳] 回收孤儿核心 pid=${o.pid}（已存活 ${o.ageSeconds ?? '?'}s）`)
      } catch (err) {
        log(`[壳] 回收 pid=${o.pid} 失败：${err.message}`)
      }
    }
    return { killed, found: orphans }
  } catch (err) {
    log(`[壳] 孤儿回收跳过：${err.message}`)
    return { killed: [], found: [], error: err.message }
  }
}
