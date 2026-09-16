#!/usr/bin/env node
/**
 * 打包产物体检（发版前跑一遍）：`npm run dist` 之后执行。
 *
 * 它回答三个问题：
 *   ① 解包出来的应用里，壳的代码与随包运行时都在不在、运行时清单里写的是什么版本；
 *   ② 安装包（NSIS）有没有真的产出、名字里的版本号跟 package.json 对不对得上；
 *   ③ 产物指纹（大小 + sha256），留档用 —— 发版记录里应该写这个，而不是"应该打好了"。
 *
 * 用法：
 *   node scripts/verify-package.mjs                 # 体检 release/（没出安装包只提示，不算失败）
 *   node scripts/verify-package.mjs --expect-installer   # 发版流程用：必须有安装包
 *   node scripts/verify-package.mjs --dir release/win-unpacked
 *   node scripts/verify-package.mjs --json           # 机器可读（CI）
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const args = process.argv.slice(2)
const asJson = args.includes('--json')
const expectInstaller = args.includes('--expect-installer')
const dirArg = args.includes('--dir') ? args[args.indexOf('--dir') + 1] : null
const releaseDir = path.join(root, 'release')

const results = { ok: [], warn: [], fail: [] }
const ok = (m) => results.ok.push(m)
const warn = (m) => results.warn.push(m)
const fail = (m) => results.fail.push(m)

function sha256(file) {
  const hash = createHash('sha256')
  hash.update(readFileSync(file))
  return hash.digest('hex')
}

function findUnpackedDir() {
  if (dirArg) return path.isAbsolute(dirArg) ? dirArg : path.join(root, dirArg)
  if (!existsSync(releaseDir)) return null
  const hit = readdirSync(releaseDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.endsWith('-unpacked'))
    .map((e) => path.join(releaseDir, e.name))
  return hit[0] ?? null
}

const unpacked = findUnpackedDir()
if (!unpacked || !existsSync(unpacked)) {
  fail(`没找到解包目录（先在 release/ 里跑 npm run pack:dir，或传 --dir <路径>）`)
} else {
  ok(`解包目录：${path.relative(root, unpacked)}`)
  const asar = path.join(unpacked, 'resources', 'app.asar')
  if (existsSync(asar)) ok(`app.asar ${(statSync(asar).size / 1024).toFixed(0)} KB`)
  else fail(`缺 resources/app.asar（打包 files 白名单有问题？）`)

  const runtimeDir = path.join(unpacked, 'resources', 'runtime')
  if (!existsSync(runtimeDir)) {
    fail(`缺 resources/runtime（ext raResources 没生效，或 runtime/ 没构建）`)
  } else {
    const manifestPath = path.join(runtimeDir, '.24h-os-runtime.json')
    let manifest = null
    if (existsSync(manifestPath)) {
      try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      } catch (err) {
        fail(`运行时清单解析失败：${err.message}`)
      }
    } else {
      warn('运行时清单 .24h-os-runtime.json 不在包里')
    }
    const core = path.join(runtimeDir, 'core', 'hermes_cli')
    if (!existsSync(core)) fail(`运行时里缺核心源码树：resources/runtime/core/hermes_cli`)
    const py = [path.join(runtimeDir, 'venv', 'Scripts', 'python.exe'), path.join(runtimeDir, 'venv', 'bin', 'python')].find(existsSync)
    if (!py) fail('运行时里缺 venv 解释器（venv/Scripts/python.exe 或 venv/bin/python）')
    if (manifest) ok(`运行时清单：coreVersion=${manifest.coreVersion ?? '?'} python=${manifest.python ?? '?'} ref=${manifest.coreRef ?? '?'} layout=${manifest.layout ?? '?'}`)

    // 运行时光"文件在"还不够：venv 是可搬迁的（Windows 上 pyvenv.cfg 的 home 会指向构建机，
    // 搬了机器/目录就可能解释器起不来）。这里真的拉起来 import 一次核心包。
    const platformMatches =
      (process.platform === 'win32' && py?.includes('Scripts')) ||
      (process.platform !== 'win32' && py?.includes(`${path.sep}bin${path.sep}`))
    if (py && core && platformMatches) {
      const probe = spawnSync(py, ['-c', 'import hermes_cli, sys; print(sys.version.split()[0])'], {
        env: { ...process.env, PYTHONPATH: path.join(runtimeDir, 'core') },
        encoding: 'utf8',
        timeout: 120000
      })
      if (probe.status === 0) ok(`随包运行时可执行：python ${String(probe.stdout).trim()} 能 import 核心包`)
      else fail(`随包运行时跑不起来（venv 是不是没跟着搬？）：${String(probe.stderr || probe.error?.message || '').split('\n').slice(-3).join(' | ')}`)
    } else if (py) {
      warn(`跳过"运行时可执行"检查：包的平台与当前机器不同（${process.platform}）`)
    }
  }
}

// 安装包
const installers = existsSync(releaseDir)
  ? readdirSync(releaseDir).filter((f) => /\.(exe|dmg|AppImage|deb|msi|zip)$/i.test(f))
  : []
if (!installers.length) {
  const msg = `release/ 里还没有安装包（npm run dist 才会产出；Windows 上才是 NSIS）`
  expectInstaller ? fail(msg) : warn(msg)
} else {
  const expected = `${pkg.build?.productName ?? pkg.productName}-${pkg.version}-`
  for (const f of installers) {
    const full = path.join(releaseDir, f)
    const size = statSync(full).size
    ok(`安装包 ${f} · ${(size / 1024 / 1024).toFixed(1)} MB · sha256=${sha256(full).slice(0, 16)}…`)
    if (f.toLowerCase().endsWith('.exe') && !f.startsWith(expected)) {
      fail(`安装包名字不符合 artifactName 约定（期望以 ${expected} 开头）：${f}`)
    }
    if (size < 20 * 1024 * 1024) warn(`${f} 只有 ${(size / 1024 / 1024).toFixed(1)} MB —— 随包运行时是不是没进去？`)
  }
}

if (asJson) {
  console.log(JSON.stringify({ package: `${pkg.productName} ${pkg.version}`, ...results }, null, 2))
} else {
  console.log(`\n打包产物体检：${pkg.productName} ${pkg.version}`)
  for (const m of results.ok) console.log('  ✓ ' + m)
  for (const m of results.warn) console.log('  ⚠ ' + m)
  for (const m of results.fail) console.log('  ✗ ' + m)
  console.log(
    `\n${results.fail.length ? '不通过' : '通过'}（${results.ok.length} 项通过 / ${results.warn.length} 项提示 / ${results.fail.length} 项失败）`
  )
}
process.exit(results.fail.length ? 1 : 0)
