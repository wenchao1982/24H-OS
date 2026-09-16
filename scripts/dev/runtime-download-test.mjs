#!/usr/bin/env node
/**
 * 运行时"资产化"的端到端验证（全部本机，不需要真的分发源）：
 *   1. 起一个静态文件服务，把 dist-assets/ 当作分发源
 *   2. 用壳的下载器 installRuntimeAsset() 走完整流程（下载 → sha256 校验 → 解压 → 落地）
 *   3. 验证落地的运行时**真的能跑**（用它自己的 python import 核心包）
 *   4. 反例：篡改 sha256 → 必须报错且不留半成品
 *
 * 用法：node scripts/dev/runtime-download-test.mjs [--assets dist-assets]
 */
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { installRuntimeAsset, fetchDistManifest } from '../../electron/runtime-download.mjs'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const args = process.argv.slice(2)
const assetsDir = path.resolve(ROOT, args.includes('--assets') ? args[args.indexOf('--assets') + 1] : 'dist-assets')
if (!existsSync(path.join(assetsDir, 'runtime-manifest.json'))) {
  console.error(`dist-assets 里没有 runtime-manifest.json：先跑 npm run package:runtime（当前目录 ${assetsDir}）`)
  process.exit(2)
}

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

// ① 静态分发源
let overrideManifest = null
const server = createServer((req, res) => {
  const name = path.basename(decodeURIComponent(req.url.split('?')[0]))
  if (name === 'runtime-manifest.json' && overrideManifest) {
    const body = JSON.stringify(overrideManifest)
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(body)
  }
  const file = path.join(assetsDir, name)
  if (!existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end('not found')
    return
  }
  const body = readFileSync(file)
  res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': body.length })
  res.end(body)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`
console.log(`静态分发源：${base}（目录 ${path.relative(ROOT, assetsDir)}）\n`)

const runtimesRoot = path.join(os.tmpdir(), `24h-runtimes-${Date.now()}`)
mkdirSync(runtimesRoot, { recursive: true })

try {
  // ② 读清单
  const manifest = await fetchDistManifest(base)
  check('能读到分发源清单', Boolean(manifest.name && manifest.sha256), `${manifest.name} core=${manifest.coreVersion} ${(manifest.size / 1024 / 1024).toFixed(0)}MB`)

  // ③ 完整安装流程
  let lastStage = ''
  const installed = await installRuntimeAsset({
    baseUrl: base,
    runtimesRoot,
    onProgress: (p) => {
      lastStage = p.stage
    }
  })
  check('下载 → 校验 → 解压 → 落地成功', existsSync(installed.dir), `${path.basename(installed.dir)}（最后阶段 ${lastStage}）`)

  // ④ 落地的运行时真的能跑（这才是"资产可用"的证明）
  const py = [path.join(installed.dir, 'venv', 'bin', 'python'), path.join(installed.dir, 'venv', 'Scripts', 'python.exe')].find(existsSync)
  let probe = ''
  try {
    probe = execFileSync(py, ['-c', 'import hermes_cli, sys; print(sys.version.split()[0])'], {
      env: { ...process.env, PYTHONPATH: path.join(installed.dir, 'core') },
      encoding: 'utf8',
      timeout: 120000
    }).trim()
  } catch (err) {
    probe = `失败：${String(err.message).slice(0, 80)}`
  }
  check('落地后的运行时能 import 核心包', /^\d+\.\d+/.test(probe), `python ${probe}`)

  // ⑤ 反例：sha256 被篡改必须拒绝，且不留半成品
  const realManifest = JSON.parse(readFileSync(path.join(assetsDir, 'runtime-manifest.json'), 'utf8'))
  overrideManifest = { ...realManifest, sha256: 'deadbeef'.repeat(8) }
  let rejected = ''
  try {
    await installRuntimeAsset({ baseUrl: base, runtimesRoot })
    rejected = '（没有报错 —— 不符合预期）'
  } catch (err) {
    rejected = err.message
  }
  const leftovers = readFileSync ? await (async () => {
    const { readdirSync } = await import('node:fs')
    return readdirSync(runtimesRoot).filter((n) => n.startsWith('.staging-'))
  })() : []
  check('sha256 不对时拒绝安装且不留半成品', /sha256 校验失败/.test(rejected) && leftovers.length === 0, `${rejected.slice(0, 60)}；残留暂存目录 ${leftovers.length} 个`)
} finally {
  server.close()
  rmSync(runtimesRoot, { recursive: true, force: true })
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 项通过`)
process.exit(failed.length ? 1 : 0)
