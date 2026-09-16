#!/usr/bin/env node
/**
 * 本地"门户兼容后端"（mock）—— 用来验证一件事：
 * 核心的 billing / subscription 读数与操作，能不能指向**我们自己的服务端**而不是 Nous 官方云。
 *
 * 结论性背景（见 docs/CORE-CONTRACT.md）：核心的门户地址可用环境变量覆盖
 * （HERMES_PORTAL_BASE_URL / NOUS_PORTAL_BASE_URL，且是"最高优先级、绕过 host 白名单"的运维开关），
 * 要实现的接口只有 8 个 /api/billing/*。这个 mock 把它们全部实现（含幂等键），并把每个请求打日志，
 * 于是"核心到底调了哪些接口、要什么字段"变成可观测的事实。
 *
 * 用法：
 *   node scripts/dev/mock-portal.mjs --port 8799            # 起服务（前台，Ctrl+C 退出）
 *   PORTAL_LOG=/tmp/portal.log node scripts/dev/mock-portal.mjs
 * 搭配：scripts/dev/portal-spike.mjs 会自动起它、起核心、跑一遍调用并打印结果。
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const PORT = Number(flag('port', process.env.PORT || 8799))
const LOG = process.env.PORTAL_LOG || path.join(process.env.TMPDIR || '/tmp', 'mock-portal.log')

const log = (line) => {
  const entry = `[${new Date().toISOString()}] ${line}\n`
  process.stdout.write(entry)
  try {
    appendFileSync(LOG, entry)
  } catch (err) {
    mkdirSync(path.dirname(LOG), { recursive: true })
    appendFileSync(LOG, entry)
  }
}

// 故意的"本地特征"：这些值出现在核心返回里，就说明数据来自我们而不是官方云
const ORG = { id: 'org_local', slug: 'local-portal', name: '本地门户（mock）' }
const BALANCE = '42.50'
// 注意字段名：tiers[] 用 name；current 用 tierName（核心的解析器就是这么读的，实测踩过一次）
const TIERS = [
  { tierId: 'free', name: 'Free', tierOrder: 0, isEnabled: true, isCurrent: false, dollarsPerMonthDisplay: '$0', monthlyCredits: 0 },
  { tierId: 'plus', name: 'Plus', tierOrder: 1, isEnabled: true, isCurrent: true, dollarsPerMonthDisplay: '$20', monthlyCredits: 2000 },
  { tierId: 'pro', name: 'Pro', tierOrder: 2, isEnabled: true, isCurrent: false, dollarsPerMonthDisplay: '$100', monthlyCredits: 12000 }
]
const charges = new Map()

const json = (res, code, body) => {
  const text = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

const readBody = (req) =>
  new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        resolve({ __raw: raw })
      }
    })
  })

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req)
  const auth = String(req.headers.authorization || '')
  log(`${req.method} ${url.pathname}${url.search} auth=${auth.slice(0, 16)}… idem=${req.headers['idempotency-key'] ?? '-'} body=${JSON.stringify(body).slice(0, 120)}`)

  if (!auth.startsWith('Bearer ')) {
    return json(res, 401, { error: 'unauthorized', message: '需要 Bearer token' })
  }

  switch (`${req.method} ${url.pathname}`) {
    case 'GET /api/billing/state':
      return json(res, 200, {
        balanceUsd: BALANCE,
        cliBillingEnabled: true,
        chargePresets: [10, 25, 50],
        minUsd: 5,
        maxUsd: 500,
        canChangePlan: true,
        org: ORG,
        role: 'OWNER',
        card: { brand: 'Visa', last4: '4242' },
        monthlyCap: { limitUsd: '200', spentThisMonthUsd: '12.50', isDefaultCeiling: false },
        autoReload: { enabled: true, thresholdUsd: '10', reloadToUsd: '50' },
        portalUrl: '/billing?topup=open'
      })
    case 'GET /api/billing/subscription':
      return json(res, 200, {
        context: 'personal',
        orgId: ORG.id,
        role: 'OWNER',
        current: { tierId: 'plus', tierName: 'Plus', cycleEndsAt: '2026-10-16T00:00:00Z', cancelAtPeriodEnd: false },
        tiers: TIERS,
        usage: { creditsRemaining: 1234, monthlyCredits: 2000 }
      })
    case 'POST /api/billing/charge': {
      const id = `ch_local_${charges.size + 1}`
      charges.set(id, { chargeId: id, status: 'pending', amountUsd: String(body.amountUsd ?? '') })
      return json(res, 200, { chargeId: id, status: 'pending' })
    }
    case 'PATCH /api/billing/auto-top-up':
      return json(res, 200, { ok: true, autoReload: body })
    case 'POST /api/billing/subscription/preview':
      return json(res, 200, {
        amountDueNowCents: 1200,
        effect: 'upgrade',
        effectiveAt: '2026-09-16T00:00:00Z',
        targetTierId: body.subscriptionTypeId ?? 'plus',
        targetTierName: 'Plus'
      })
    case 'PUT /api/billing/subscription/pending-change':
      return json(res, 200, { ok: true, pendingDowngradeAt: '2026-10-16T00:00:00Z' })
    case 'DELETE /api/billing/subscription/pending-change':
      return json(res, 200, { ok: true, cleared: true })
    case 'POST /api/billing/subscription/upgrade':
      return json(res, 200, { ok: true, tierId: body.subscriptionTypeId ?? 'plus', status: 'active' })
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/billing/charge/')) {
    const id = url.pathname.split('/').pop()
    const hit = charges.get(id)
    if (!hit) return json(res, 404, { error: 'unknown_charge' })
    return json(res, 200, { ...hit, status: 'succeeded', paidAt: '2026-09-16T00:00:00Z' })
  }

  // 其它路径一律记下来并回 404 —— 这样"核心还想要什么接口"会暴露在日志里
  log(`!! 未实现的路径 ${req.method} ${url.pathname}`)
  return json(res, 404, { error: 'not_implemented', path: url.pathname })
})

server.listen(PORT, '127.0.0.1', () => {
  log(`mock 门户已启动：http://127.0.0.1:${PORT}（日志 ${LOG}）`)
})
