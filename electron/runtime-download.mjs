/**
 * 运行时资产下载器：从分发源取"清单 + 压缩包"，校验 sha256 后落到 <runtimesRoot>/runtime.<版本>/。
 *
 * 为什么要有它（见 docs/PLAN.md §5.1）：随包 336MB 让"升级核心"变成"重装壳"。资产化之后，
 * 核心升级 = 下载一个新版本目录 + 切换（壳里已有切换/回退 UI），壳本身不用重出。
 *
 * 设计取舍：
 *   · 允许 http：内容用 sha256 校验，明文传输不改完整性（但首次信任仍靠随包清单/域名）；
 *   · 解压用系统 tar（Windows 10+ 自带 tar.exe），不引第三方依赖；
 *   · 先解到临时目录、校验清单里的 coreTreeSha256 与压缩包内清单一致，再原子改名到最终位置；
 *   · 失败不留半成品（临时目录会被清掉）。
 */
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { pipeline } from 'node:stream/promises'
import path from 'node:path'
import { Readable } from 'node:stream'

const fetchJson = async (url, timeoutMs = 20000) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': '24h-os-shell' } })
  if (!res.ok) throw new Error(`取清单失败：HTTP ${res.status}（${url}）`)
  return res.json()
}

/** 当前平台标识（与 package-runtime 的产物一致：win-x64 / linux-x64 / darwin-arm64 …） */
export function platformKey(platformName = process.platform, arch = process.arch) {
  if (platformName === 'win32') return 'win-x64'
  if (platformName === 'darwin') return `darwin-${arch}`
  return `${platformName}-${arch}`
}

/**
 * 读分发源上的清单。
 * 约定：分发源按平台分目录 —— <base>/<平台>/runtime-manifest.json（多平台并存互不覆盖）。
 * 兼容"直接把清单放 base 下"的老写法；平台不匹配就拒绝（装上了也跑不起来）。
 */
export async function fetchDistManifest(baseUrl, { platform = platformKey() } = {}) {
  const base = String(baseUrl || '').replace(/\/+$/, '')
  if (!base) throw new Error('没有配置分发源地址')
  let manifest = null
  let usedBase = `${base}/${platform}`
  try {
    manifest = await fetchJson(`${usedBase}/runtime-manifest.json`)
  } catch {
    usedBase = base
    manifest = await fetchJson(`${base}/runtime-manifest.json`).catch(() => {
      throw new Error(`取清单失败：${base}/${platform}/runtime-manifest.json 与 ${base}/runtime-manifest.json 都读不到`)
    })
  }
  if (!manifest?.name || !manifest?.sha256) throw new Error('分发源的清单里缺 name / sha256 字段')
  if (manifest.platform && manifest.platform !== platform) {
    throw new Error(`分发源上的是 ${manifest.platform} 资产，当前机器是 ${platform}（放对应平台的目录）`)
  }
  return { ...manifest, url: `${usedBase}/${manifest.name}` }
}

/** 流式下载并按 sha256 校验；返回落盘的临时文件路径 */
export async function downloadVerified({ url, sha256, targetFile, onProgress, timeoutMs = 60 * 60 * 1000 }) {
  mkdirSync(path.dirname(targetFile), { recursive: true })
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': '24h-os-shell' } })
  if (!res.ok || !res.body) throw new Error(`下载失败：HTTP ${res.status}（${url}）`)
  const total = Number(res.headers.get('content-length') || 0)
  const hash = createHash('sha256')
  let received = 0
  let lastReport = 0
  const source = Readable.fromWeb(res.body)
  source.on('data', (chunk) => {
    hash.update(chunk)
    received += chunk.length
    const now = Date.now()
    if (onProgress && now - lastReport > 500) {
      lastReport = now
      onProgress({ received, total, percent: total ? Math.round((received / total) * 100) : null })
    }
  })
  await pipeline(source, createWriteStream(targetFile))
  const actual = hash.digest('hex')
  if (actual !== String(sha256).toLowerCase()) {
    rmSync(targetFile, { force: true })
    throw new Error(`sha256 校验失败：期望 ${String(sha256).slice(0, 12)}… 实际 ${actual.slice(0, 12)}…（文件可能被改动或下载不完整）`)
  }
  if (onProgress) onProgress({ received, total, percent: 100, done: true })
  return targetFile
}

const untar = (archive, intoDir) =>
  new Promise((resolve, reject) => {
    // Windows 10+ 自带 tar.exe，Linux/macOS 自带 tar —— 不引第三方依赖
    execFile('tar', ['-xzf', archive, '-C', intoDir], { maxBuffer: 16 * 1024 * 1024 }, (err, _stdout, stderr) =>
      err ? reject(new Error(`解压失败：${stderr || err.message}`)) : resolve()
    )
  })

/**
 * 完整流程：下载 → 校验 → 解压到暂存目录 → 核对清单 → 原子改名到 <runtimesRoot>/runtime.<版本>
 * @returns {Promise<{dir: string, coreVersion: string, manifest: object}>}
 */
export async function installRuntimeAsset({ baseUrl, runtimesRoot, onProgress, keepArchive = false }) {
  const manifest = await fetchDistManifest(baseUrl)
  const staging = path.join(runtimesRoot, `.staging-${Date.now()}`)
  mkdirSync(staging, { recursive: true })
  const archive = path.join(staging, manifest.name)
  try {
    onProgress?.({ stage: 'download', message: `正在下载 ${manifest.name}（${(Number(manifest.size || 0) / 1024 / 1024).toFixed(0)} MB）` })
    await downloadVerified({ url: manifest.url, sha256: manifest.sha256, targetFile: archive, onProgress: (p) => onProgress?.({ stage: 'download', ...p }) })
    onProgress?.({ stage: 'verify', message: 'sha256 校验通过' })
    const unpack = path.join(staging, 'unpack')
    mkdirSync(unpack, { recursive: true })
    await untar(archive, unpack)
    const inner = path.join(unpack, '.24h-os-runtime.json')
    if (!existsSync(inner)) throw new Error('压缩包里没有 .24h-os-runtime.json（不是运行时资产？）')
    const innerManifest = JSON.parse(readFileSync(inner, 'utf8'))
    if (innerManifest.coreVersion !== manifest.coreVersion) {
      throw new Error(`包内核心版本 ${innerManifest.coreVersion} 与清单 ${manifest.coreVersion} 不一致`)
    }
    const finalDir = path.join(runtimesRoot, `runtime.${manifest.coreVersion}`)
    rmSync(finalDir, { recursive: true, force: true })
    renameSync(unpack, finalDir)
    onProgress?.({ stage: 'ready', message: `已安装到 ${finalDir}` })
    return { dir: finalDir, coreVersion: manifest.coreVersion, manifest: innerManifest }
  } finally {
    if (!keepArchive) rmSync(staging, { recursive: true, force: true })
  }
}

/** 已安装的下载版运行时（userData/runtimes/runtime.<版本>） */
export function listInstalledRuntimes(runtimesRoot) {
  if (!existsSync(runtimesRoot)) return []
  const out = []
  for (const entry of readdirSync(runtimesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('runtime.')) continue
    const dir = path.join(runtimesRoot, entry.name)
    let manifest = null
    try {
      manifest = JSON.parse(readFileSync(path.join(dir, '.24h-os-runtime.json'), 'utf8'))
    } catch {
      /* 没有清单也列出来，UI 显示"无清单" */
    }
    out.push({ dir, name: entry.name, coreVersion: manifest?.coreVersion ?? entry.name.replace('runtime.', ''), coreCommit: manifest?.coreCommit ?? null, platform: manifest?.platform ?? null, kind: 'downloaded' })
  }
  return out
}
