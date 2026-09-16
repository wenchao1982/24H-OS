#!/usr/bin/env node
/**
 * 「门户兼容后端」技术验证：核心的 billing / subscription 能不能指向我们自己的服务端？
 *
 * 做法（全部在本机、不联网）：
 *   1. 起 mock 门户（scripts/dev/mock-portal.mjs）
 *   2. 造一个隔离的 HERMES_HOME，写 auth.json：provider `nous` 带一个本地 token（expires_at 放远一点）
 *   3. 用 HERMES_PORTAL_BASE_URL 指向 mock，起核心
 *   4. 依次调用 billing.state / usage.bars / subscription.state / billing.charge / billing.charge_status
 *   5. 打印：核心返回了什么 + mock 收到了哪些请求（这是"谁在服务谁"的铁证）
 *
 * 用法：node scripts/dev/portal-spike.mjs
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Gateway } from '../../electron/gateway.js'
import { Runtime } from '../../electron/runtime.js'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const PORT = Number(process.env.PORTAL_PORT || 8799)
const LOG = path.join(os.tmpdir(), 'mock-portal.log')
const HOME = path.join(os.tmpdir(), `24h-portal-spike-${Date.now()}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

mkdirSync(HOME, { recursive: true })
// ① 本地 token（expires_at 用 ISO，且放很远 → 走"未过期直接返回"的快路径，不触发 refresh）
writeFileSync(
  path.join(HOME, 'auth.json'),
  JSON.stringify(
    {
      active_provider: 'nous',
      providers: {
        nous: {
          access_token: 'local-token-abc123',
          refresh_token: 'local-refresh',
          token_type: 'Bearer',
          scope: 'billing:manage',
          expires_at: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
          client_id: 'local-client'
        }
      }
    },
    null,
    2
  ) + '\n',
  'utf8'
)
writeFileSync(LOG, '', 'utf8')

// ② 起 mock 门户
const portal = spawn(process.execPath, [path.join(ROOT, 'scripts', 'dev', 'mock-portal.mjs'), '--port', String(PORT)], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, PORTAL_LOG: LOG }
})
portal.stdout.on('data', () => {})
portal.stderr.on('data', (d) => process.stderr.write(`[mock:err] ${d}`))
await sleep(600)

// ③ 起核心（门户指向 mock）
const runtime = new Runtime({
  appRoot: ROOT,
  hermesHome: HOME,
  onLog: (line, stream) => {
    if (stream === 'stderr' && /portal|billing|auth/i.test(line)) console.log(`[核心:stderr] ${line}`)
  }
})
process.env.HERMES_PORTAL_BASE_URL = `http://127.0.0.1:${PORT}`
let gateway = null
const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? '✓' : '✗'} ${name} — ${detail}`)
}

try {
  await runtime.start()
  const token = await runtime.sessionToken()
  gateway = new Gateway({ baseUrl: runtime.baseUrl, token, log: () => {} })
  await gateway.connect()
  console.log(`核心就绪（HERMES_HOME=${HOME}，门户指向 mock :${PORT}）\n`)

  const call = async (method, params = {}) => {
    try {
      return await gateway.call(method, params)
    } catch (err) {
      return { __error: err.message, __code: err.code }
    }
  }

  const billing = await call('billing.state')
  record(
    'billing.state 读到我们门户的余额',
    billing?.balance_usd === '42.5' || billing?.balance_display?.includes('42'),
    `logged_in=${billing?.logged_in} balance=${billing?.balance_display} org=${billing?.org_name} can_charge=${billing?.can_charge}`
  )

  const subs = await call('subscription.state')
  const tiers = subs?.tiers ?? []
  const tierNames = tiers.map((t) => `${t.tier_id ?? t.tierId}${t.is_current ? '(当前)' : ''}`).join(',')
  record(
    'subscription.state 读到我们门户的套餐表',
    tiers.length >= 2 && Boolean(subs?.current?.tier_id),
    `current=${subs?.current?.tier_id ?? '?'} tiers=[${tierNames}] can_change_plan=${subs?.can_change_plan}`
  )

  const usage = await call('usage.bars')
  record('usage.bars 有读数', usage?.available === true || usage?.ok === true, JSON.stringify(usage).slice(0, 120))

  const charge = await call('billing.charge', { amount_usd: 10 })
  const chargeId = charge?.charge_id ?? charge?.charge?.chargeId ?? charge?.chargeId ?? charge?.id
  record('billing.charge 下单（写操作走我们门户）', !charge?.__error, JSON.stringify(charge).slice(0, 160))

  if (chargeId) {
    const st = await call('billing.charge_status', { charge_id: chargeId })
    record('billing.charge_status 查询订单', !st?.__error, JSON.stringify(st).slice(0, 160))
  }

  await sleep(400)
  const log = readFileSync(LOG, 'utf8').trim().split('\n')
  const hits = log.filter((l) => l.includes('/api/billing'))
  console.log(`\nmock 门户收到 ${hits.length} 个 /api/billing/* 请求：`)
  for (const h of hits) console.log('   ' + h.replace(/^\[[^\]]+\] /, '').slice(0, 150))
  const unexpected = log.filter((l) => l.includes('未实现的路径'))
  if (unexpected.length) {
    console.log('\n核心还想要、但 mock 没实现的路径（待补）：')
    for (const u of unexpected) console.log('   ' + u)
  }
} catch (err) {
  record('整体流程', false, err.message)
} finally {
  gateway?.close()
  await runtime.stop().catch(() => {})
  portal.kill()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 项通过`)
process.exit(failed.length ? 1 : 0)
