/**
 * 运行时管理：启动 / 观测 / 关闭 Hermes Agent 核心。
 *
 * 核心的启动契约（已实测，0.21.0）：
 *   1) 壳启动：  <python> -m hermes_cli.main serve --host 127.0.0.1 --port 0
 *      —— 端口给 0 由核心自选，避免端口冲突占位问题。
 *   2) 就绪信号：核心往 stdout 打一行 `HERMES_BACKEND_READY port=<N>`，
 *      同时（非必需）还会打 "Hermes backend listening on 127.0.0.1:<N>"。
 *   3) 健康检查：GET http://127.0.0.1:<N>/api/health
 *      -> {"ok":true,"version":"0.21.0","auth_required":false}
 *   4) 鉴权：GET / 返回的 HTML 里内联 window.__HERMES_SESSION_TOKEN__="<token>"；
 *      需要鉴权的接口用 header `Authorization: Bearer <token>`（实测 /api/status 200）。
 *   5) 协议参考：/openapi.json（265 个端点）+ /docs。
 *
 * 本文件不依赖 electron，可用 `node electron/runtime.js --probe` 单独跑通，
 * 便于在没有图形环境的机器上验证"核心启动链路"。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const READY_RE = /HERMES_BACKEND_READY port=(\d+)/

const IS_WIN = process.platform === 'win32'
/** 运行时目录里 python 可执行文件的位置（POSIX venv vs Windows venv）。 */
const PY_RELPATH = IS_WIN ? path.join('Scripts', 'python.exe') : path.join('bin', 'python')

/**
 * 找到能跑核心的 python。顺序（先具体后笼统）：
 *   1. HERMES_RUNTIME_PYTHON —— 开发时指向任意一份 Hermes 运行时/venv
 *   2. resourcesPath/runtime   —— 打包后随壳发行的运行时（见 README「运行时怎么带」）
 *   3. <repo>/runtime         —— 本地开发：把运行时放在仓库根的 runtime/
 *   4. PATH 里的 hermes        —— 用户机器上已装过 Hermes 的情况
 * @param {{resourcesPath?: string, appRoot?: string}} ctx
 */
export function resolveRuntime(ctx = {}) {
  const explicit = process.env.HERMES_RUNTIME_PYTHON
  if (explicit && existsSync(explicit)) return { kind: 'python', cmd: explicit }

  const roots = [ctx.resourcesPath && path.join(ctx.resourcesPath, 'runtime'), ctx.appRoot && path.join(ctx.appRoot, 'runtime')]
  for (const root of roots) {
    if (!root) continue
    const candidate = path.join(root, PY_RELPATH)
    if (existsSync(candidate)) return { kind: 'python', cmd: candidate, root }
  }

  // 兜底：用户机器上已有 hermes（或 hermes-agent）可执行文件
  return { kind: 'path', cmd: IS_WIN ? 'hermes.exe' : 'hermes' }
}

/** 把解析结果变成 argv（两种形态最终都跑 `serve`）。 */
export function buildArgs(runtime, { profile } = {}) {
  const serve = ['serve', '--host', '127.0.0.1', '--port', '0']
  const head = profile ? ['--profile', profile] : []
  return runtime.kind === 'python' ? ['-m', 'hermes_cli.main', ...head, ...serve] : [...head, ...serve]
}

export class Runtime {
  /**
   * @param {{resourcesPath?: string, appRoot?: string, hermesHome?: string, profile?: string,
   *          onLog?: (line: string, stream: 'stdout'|'stderr') => void}} opts
   */
  constructor(opts = {}) {
    this.opts = opts
    this.child = null
    this.port = null
    this.exitInfo = null
    this._waiters = []
    this._onExit = null
  }

  /** 启动核心并等到就绪；返回端口。重复调用返回同一个 promise。 */
  start() {
    if (this._starting) return this._starting
    this._starting = new Promise((resolve, reject) => {
      this.exitInfo = null
      const runtime = resolveRuntime(this.opts)
      const args = buildArgs(runtime, { profile: this.opts.profile })

      const env = { ...process.env }
      if (this.opts.hermesHome) env.HERMES_HOME = this.opts.hermesHome
      // 让核心按行输出，便于解析就绪信号
      env.PYTHONUNBUFFERED = '1'

      const child = spawn(runtime.cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
      this.child = child

      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(new Error(`核心 60 秒内未就绪（命令：${runtime.cmd} ${args.join(' ')}）`))
      }, 60_000)

      const feed = (stream) => (chunk) => {
        for (const line of String(chunk).split(/\r?\n/)) {
          if (!line.trim()) continue
          this.opts.onLog?.(line, stream)
          const m = READY_RE.exec(line)
          if (m && !settled) {
            settled = true
            clearTimeout(timer)
            this.port = Number(m[1])
            resolve(this.port)
          }
        }
      }
      child.stdout.on('data', feed('stdout'))
      child.stderr.on('data', feed('stderr'))

      child.on('error', (err) => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(err)
        }
      })
      child.on('exit', (code, signal) => {
        this.exitInfo = { code, signal }
        this.child = null
        this._starting = null
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(new Error(`核心进程启动失败/提前退出：code=${code} signal=${signal}`))
        }
        this._onExit?.(this.exitInfo)
      })
    })
    return this._starting
  }

  /** 核心事件的订阅入口（退出）。 */
  onExit(cb) {
    this._onExit = cb
  }

  get baseUrl() {
    return this.port ? `http://127.0.0.1:${this.port}` : null
  }

  /** 健康检查（无需鉴权）。 */
  async health() {
    if (!this.baseUrl) throw new Error('核心未就绪')
    const res = await fetch(`${this.baseUrl}/api/health`)
    return res.json()
  }

  /** 取会话 token（核心在 / 的 HTML 里内联注入）。 */
  async sessionToken() {
    const res = await fetch(`${this.baseUrl}/`)
    const html = await res.text()
    const m = /__HERMES_SESSION_TOKEN__="([^"]+)"/.exec(html)
    return m ? m[1] : null
  }

  /** 带鉴权的请求示例（实测 /api/status 需要它）。 */
  async api(pathname) {
    const token = await this.sessionToken()
    const res = await fetch(`${this.baseUrl}${pathname}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    })
    return { status: res.status, body: await res.json().catch(() => null) }
  }

  /** 优雅关闭：先 SIGTERM，2 秒后仍在则 SIGKILL。 */
  async stop() {
    const child = this.child
    if (!child) return
    this.child = null
    await new Promise((resolve) => {
      const kill = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {}
        resolve()
      }, 2000)
      child.once('exit', () => {
        clearTimeout(kill)
        resolve()
      })
      try {
        child.kill('SIGTERM')
      } catch {
        clearTimeout(kill)
        resolve()
      }
    })
  }
}

/** `node electron/runtime.js --probe`：无图形环境也能验证核心启动链路。 */
if (process.argv.includes('--probe')) {
  const rt = new Runtime({
    appRoot: path.resolve(import.meta.dirname, '..'),
    hermesHome: process.env.HERMES_HOME,
    onLog: (line, stream) => process.stdout.write(`  [核心:${stream}] ${line}\n`)
  })
  try {
    const port = await rt.start()
    console.log(`\n✓ 核心就绪，端口 ${port}（${rt.baseUrl}）`)
    console.log('  健康检查:', JSON.stringify(await rt.health()))
    const status = await rt.api('/api/status')
    console.log(`  /api/status: HTTP ${status.status}`, status.body ? JSON.stringify(status.body).slice(0, 160) : '')
  } catch (err) {
    console.error('✗ 启动失败:', err.message)
    process.exitCode = 1
  } finally {
    await rt.stop()
  }
}
