#!/usr/bin/env node
/**
 * 核心契约体检：把"这个核心到底给我们开放了什么"变成可重复的实测。
 *
 * 为什么需要：契约里 200+ 个方法是"存在"的，但存在 ≠ 能用 —— 有些要登录上游账号
 * （billing/subscription）、有些要装插件、有些只是空态。这个脚本用壳自己的两个模块
 * （runtime.js + gateway.js）起一个隔离的核心（临时 HERMES_HOME），逐个调用并打印**原始**
 * 返回或错误码，不做解释。
 *
 * 用法：
 *   node scripts/contract-probe.mjs                        # 默认清单（商业化/账号/能力面）
 *   node scripts/contract-probe.mjs --methods model.options,session.list
 *   node scripts/contract-probe.mjs --timeout 8000 --json
 *   HERMES_RUNTIME_PYTHON=/path/to/python node scripts/contract-probe.mjs   # 指定运行时
 *
 * 注意：会**写临时 home**（例如 save_key 会写 key），所以默认隔离，不碰你自己的 ~/.hermes。
 */
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Gateway } from '../electron/gateway.js'
import { Runtime } from '../electron/runtime.js'

const DEFAULT_METHODS = [
  'gateway.capabilities', 'setup.status', 'setup.runtime_check',
  'billing.state', 'billing.charge_status', 'subscription.state', 'usage.bars',
  'free_tier.status', 'insights.get',
  'profiles.list', 'toolsets.list', 'plugins.list', 'skills.manage', 'mcp.catalog', 'cron.manage'
]

const argv = process.argv.slice(2)
const flag = (name, fallback = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback)
const asJson = argv.includes('--json')
const timeoutMs = Number(flag('--timeout', 30000))
const methods = (flag('--methods') || DEFAULT_METHODS.join(',')).split(',').map((s) => s.trim()).filter(Boolean)

const withTimeout = (promise, ms, name) =>
  Promise.race([
    promise,
    new Promise((_resolve, reject) => setTimeout(() => reject(Object.assign(new Error(`调用 ${name} 超时（${ms / 1000}s）`), { code: 'client_timeout' })), ms))
  ])

const home = process.env.HERMES_HOME || mkdtempSync(path.join(os.tmpdir(), '24h-contract-'))
const runtime = new Runtime({ appRoot: path.resolve(import.meta.dirname, '..'), hermesHome: home, onLog: () => {} })
const rows = []
let gateway = null
try {
  const port = await runtime.start()
  const token = await runtime.sessionToken()
  gateway = new Gateway({ baseUrl: runtime.baseUrl, token, log: () => {} })
  await gateway.connect()
  if (!asJson) console.log(`核心 0.21.x 就绪 port=${port}  home=${home}\n`)
  for (const method of methods) {
    let row
    try {
      const result = await withTimeout(gateway.call(method, {}), timeoutMs, method)
      row = { method, ok: true, result }
    } catch (err) {
      row = { method, ok: false, code: err.code ?? null, message: String(err.message ?? err).slice(0, 300) }
    }
    rows.push(row)
    if (!asJson) {
      const body = row.ok ? JSON.stringify(row.result) : `code=${row.code} ${row.message}`
      console.log(`${row.ok ? '✓' : '✗'} ${method} → ${body.slice(0, 400)}`)
    }
  }
} catch (err) {
  rows.push({ method: '(启动)', ok: false, message: err.message })
  if (!asJson) console.error('核心启动失败：' + err.message)
} finally {
  gateway?.close()
  await runtime.stop()
}

if (asJson) console.log(JSON.stringify(rows, null, 2))
process.exit(rows.every((r) => r.ok) ? 0 : 0) // 探针是"读事实"，不因某项不可用而失败
