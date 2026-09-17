#!/usr/bin/env node
/**
 * 分发源体检（CI 与本地都能跑，**不下载大文件**）：
 *   ① 平台目录的清单可读、字段齐全；
 *   ② .sha256 文件与清单里的 sha256 一致（防"换了包忘了更新校验值"）；
 *   ③ 资产 HEAD 的 content-length 与清单里的 size 一致（防半个包）；
 *   ④ 顺手列出分发源上有哪些平台。
 *
 * 用法：
 *   node scripts/dev/check-dist.mjs                                  # 默认取壳里预置的地址
 *   node scripts/dev/check-dist.mjs --base http://111.229.225.8:8899
 *   node scripts/dev/check-dist.mjs --platform win-x64 --platform linux-x64
 */
const args = process.argv.slice(2)
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback
}
const all = (name) => args.reduce((acc, a, i) => (a === `--${name}` && args[i + 1] ? [...acc, args[i + 1]] : acc), [])

const BASE = (flag('base') || process.env.DIST_URL || 'http://111.229.225.8:8899').replace(/\/+$/, '')
const PLATFORMS = all('platform').length ? all('platform') : ['win-x64', 'linux-x64']

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}
const get = async (url, opts = {}) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000), headers: { 'User-Agent': '24h-os-check' }, ...opts })
  return res
}

console.log(`分发源体检：${BASE}\n`)
for (const platform of PLATFORMS) {
  let manifest
  try {
    const res = await get(`${BASE}/${platform}/runtime-manifest.json`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    manifest = await res.json()
  } catch (err) {
    check(`[${platform}] 清单可读`, false, err.message)
    continue
  }
  check(
    `[${platform}] 清单字段齐全`,
    Boolean(manifest.name && manifest.sha256 && manifest.coreVersion),
    `${manifest.name} core=${manifest.coreVersion} size=${(Number(manifest.size) / 1024 / 1024).toFixed(0)}MB platform=${manifest.platform ?? '-'}`
  )

  try {
    const text = await (await get(`${BASE}/${platform}/${manifest.name}.sha256`)).text()
    const sha = text.trim().split(/\s+/)[0]
    check(`[${platform}] .sha256 与清单一致`, sha === manifest.sha256, `${sha?.slice(0, 12)}…`)
  } catch (err) {
    check(`[${platform}] .sha256 可读`, false, err.message)
  }

  try {
    const head = await get(`${BASE}/${platform}/${manifest.name}`, { method: 'HEAD' })
    const len = Number(head.headers.get('content-length') || 0)
    check(`[${platform}] 资产大小与清单一致`, len === Number(manifest.size), `HEAD ${(len / 1024 / 1024).toFixed(1)}MB vs 清单 ${(Number(manifest.size) / 1024 / 1024).toFixed(1)}MB`)
  } catch (err) {
    check(`[${platform}] 资产可访问（HEAD）`, false, err.message)
  }
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 项通过`)
process.exit(failed.length ? 1 : 0)
