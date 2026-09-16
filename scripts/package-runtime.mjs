#!/usr/bin/env node
/**
 * 把 runtime/ 打成"运行时资产"（用来放到分发源上，让别的机器下载）：
 *   hermes-runtime-<core版本>-<平台>.tar.gz      资产本体
 *   hermes-runtime-<core版本>-<平台>.tar.gz.sha256  校验值（下载端据此验证）
 *   runtime-manifest.json                        清单（版本/commit/平台/体积/sha256）
 *
 * 与 Ekko Studio 的做法一致（见 docs/PLAN.md §5.1）：壳可以随包带运行时，也可以从分发源下载，
 * 两者共用同一份"清单 + sha256"约定。sha256 让"http 明文下载"也是安全的（内容被改就校验不过）。
 *
 * 用法：
 *   node scripts/package-runtime.mjs                       # 打包 <repo>/runtime → dist-assets/
 *   node scripts/package-runtime.mjs --dir runtime.prev --out /tmp/assets
 *   node scripts/package-runtime.mjs --platform win-x64    # 覆盖平台标识（默认取清单里的）
 */
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback
}
const runtimeDir = path.resolve(root, flag('dir', 'runtime'))
const outDir = path.resolve(root, flag('out', 'dist-assets'))
const platformOverride = flag('platform')

if (!existsSync(runtimeDir)) {
  console.error(`找不到运行时目录：${runtimeDir}`)
  process.exit(1)
}

let manifest = {}
try {
  manifest = JSON.parse(readFileSync(path.join(runtimeDir, '.24h-os-runtime.json'), 'utf8'))
} catch {
  console.warn('⚠ 没有清单（先跑 npm run manifest）；资产仍会产出，但下载端无法核对版本')
}

const coreVersion = manifest.coreVersion ?? 'unknown'
const platform = platformOverride ?? manifest.platform ?? `${process.platform}-${process.arch}`
const name = `hermes-runtime-${coreVersion}-${platform}.tar.gz`
// 按平台分子目录：分发源上多平台并存（win-x64 / linux-x64 / mac-arm64 …），客户端只取自己那份
const platDir = path.join(outDir, platform)
mkdirSync(platDir, { recursive: true })
const archive = path.join(platDir, name)

// tar -czf（Linux/macOS 自带；Windows 10+ 自带 tar.exe）；排除 venv 里的 __pycache__ 省点体积
const excludes = ['--exclude=**/__pycache__', '--exclude=**/*.pyc', '--exclude=.git']
execFileSync('tar', ['-czf', archive, ...excludes, '-C', runtimeDir, '.'], { stdio: 'inherit' })

const sha256 = await new Promise((resolve, reject) => {
  const hash = createHash('sha256')
  createReadStream(archive).on('data', (c) => hash.update(c)).on('end', () => resolve(hash.digest('hex'))).on('error', reject)
})
writeFileSync(`${archive}.sha256`, `${sha256}  ${name}\n`, 'utf8')

const size = statSync(archive).size
const assetManifest = {
  schema: 1,
  name,
  size,
  sha256,
  coreVersion,
  coreCommit: manifest.coreCommit ?? null,
  coreTreeSha256: manifest.coreTreeSha256 ?? null,
  platform,
  builtAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  layout: manifest.layout ?? 'venv+core-source'
}
writeFileSync(path.join(platDir, 'runtime-manifest.json'), JSON.stringify(assetManifest, null, 2) + '\n', 'utf8')

console.log(`✓ ${path.relative(root, archive)}  ${(size / 1024 / 1024).toFixed(0)} MB`)
console.log(`  sha256=${sha256.slice(0, 16)}…  清单=${path.relative(root, path.join(platDir, 'runtime-manifest.json'))}`)
console.log(`  分发源上放到 <base>/${platform}/ 下：${name} / ${name}.sha256 / runtime-manifest.json`)
