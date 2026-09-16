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
 *   1. HERMES_RUNTIME_PYTHON +（可选）HERMES_RUNTIME_CORE —— 开发时手动指定
 *   2. resourcesPath/runtime 或 <repo>/runtime —— 随包运行时，两种布局都支持：
 *        a. venv + core 源码树（scripts/build-runtime.sh 的产物）：runtime/venv/bin/python + runtime/core/
 *        b. 单一 venv（已把 hermes 装进去）：runtime/bin/python
 *   3. PATH 里的 hermes —— 用户机器上已装过 Hermes 的情况
 * @param {{resourcesPath?: string, appRoot?: string}} ctx
 */
export function resolveRuntime(ctx = {}) {
  const explicit = process.env.HERMES_RUNTIME_PYTHON
  if (explicit && existsSync(explicit)) {
    const core = process.env.HERMES_RUNTIME_CORE
    return { kind: 'python', cmd: explicit, coreDir: core && existsSync(core) ? core : undefined }
  }

  const roots = [
    ctx.resourcesPath && path.join(ctx.resourcesPath, 'runtime'),
    ctx.appRoot && path.join(ctx.appRoot, 'runtime')
  ].filter(Boolean)

  for (const root of roots) {
    // a) venv + 源码树布局
    const venvPython = path.join(root, 'venv', PY_RELPATH)
    const coreDir = path.join(root, 'core')
    if (existsSync(venvPython) && existsSync(path.join(coreDir, 'hermes_cli'))) {
      return { kind: 'bundled', cmd: venvPython, coreDir, root }
    }
    // b) 单一 venv 布局
    const candidate = path.join(root, PY_RELPATH)
    if (existsSync(candidate)) return { kind: 'python', cmd: candidate, root }
  }

  return { kind: 'path', cmd: IS_WIN ? 'hermes.exe' : 'hermes' }
}

/** 把解析结果变成 argv（python 类运行时都走 `-m hermes_cli.main`，PATH 上的 hermes 直接跑）。 */
export function buildArgs(runtime, { profile } = {}) {
  const serve = ['serve', '--host', '127.0.0.1', '--port', '0']
  const head = profile ? ['--profile', profile] : []
  return runtime.kind === 'path' ? [...head, ...serve] : ['-m', 'hermes_cli.main', ...head, ...serve]
}

/** 核心启动超时（毫秒）。Windows 首次启动时要被 Defender 扫一遍 300MB 运行时，放长一些。 */
const START_TIMEOUT_MS = Number(process.env.HERMES_START_TIMEOUT_MS || 180_000)

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
      // 随包布局（venv + 源码树）：把源码树放进 PYTHONPATH，并以它为 cwd 启动
      if (runtime.coreDir) env.PYTHONPATH = env.PYTHONPATH ? `${runtime.coreDir}${path.delimiter}${env.PYTHONPATH}` : runtime.coreDir

      const child = spawn(runtime.cmd, args, {
        env,
        cwd: runtime.coreDir ?? undefined,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      this.child = child

      let settled = false
      const startedAt = Date.now()
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(new Error(`核心 ${START_TIMEOUT_MS / 1000} 秒内未就绪（命令：${runtime.cmd} ${args.join(' ')}）`))
      }, START_TIMEOUT_MS)
      // 每 10 秒报一次等待进度，UI 上能看出"还在跑"而不是卡死
      const ticker = setInterval(() => {
        if (settled) return
        this.opts.onLog?.(`[壳] 等待核心就绪… 已 ${Math.round((Date.now() - startedAt) / 1000)}s`, 'shell')
      }, 10_000)

      const feed = (stream) => (chunk) => {
        for (const line of String(chunk).split(/\r?\n/)) {
          if (!line.trim()) continue
          this.opts.onLog?.(line, stream)
          const m = READY_RE.exec(line)
          if (m && !settled) {
            settled = true
            clearTimeout(timer)
            clearInterval(ticker)
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
          clearInterval(ticker)
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
          clearInterval(ticker)
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
    return this.request('GET', pathname)
  }

  /** 通用带鉴权请求（REST）。token 每次调用现取，核心重启后自动跟上。 */
  async request(method, pathname, body) {
    if (!this.baseUrl) throw new Error('核心未就绪')
    const token = await this.sessionToken()
    const res = await fetch(`${this.baseUrl}${pathname}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    })
    const text = await res.text()
    let parsed = null
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      parsed = { _raw: text.slice(0, 500) }
    }
    if (!res.ok) throw new Error(`${method} ${pathname} → HTTP ${res.status} ${text.slice(0, 200)}`)
    return parsed
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
