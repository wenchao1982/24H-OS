#!/usr/bin/env node
/**
 * 运行时体检：确认 runtime/ 里的东西和清单（.24h-os-runtime.json）说的是同一回事。
 *
 * 为什么需要：清单是"这份运行时到底是什么"的身份证（commit / 源码树指纹 / 平台），
 * 打包自检与诊断页都读它。若目录被替换过、构建中断过、或从别处拷来，清单就会说谎。
 * 发版前跑一次这个，比"应该没问题"可靠。
 *
 * 用法：
 *   node scripts/verify-runtime.mjs                 # 检查 <repo>/runtime
 *   node scripts/verify-runtime.mjs runtime.prev    # 检查指定目录
 *   node scripts/verify-runtime.mjs --rehash        # 源码树指纹对不上时，重新写入清单
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { treeFingerprint } from './lib/runtime-tree.mjs'

const root = path.resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)
const rehash = args.includes('--rehash')
const dirArg = args.find((a) => !a.startsWith('--'))
const runtimeDir = path.resolve(root, dirArg || 'runtime')

const ok = []
const warn = []
const fail = []
const say = (list, msg) => list.push(msg)

if (!existsSync(runtimeDir)) {
  console.log(`✗ 没有这个目录：${runtimeDir}`)
  process.exit(1)
}

// 1) 关键结构
const venvCandidates = ['venv/bin/python', 'venv/Scripts/python.exe', 'bin/python', 'Scripts/python.exe']
const py = venvCandidates.map((p) => path.join(runtimeDir, p)).find((p) => existsSync(p))
py ? say(ok, `解释器：${path.relative(root, py)}`) : say(fail, '缺 venv 解释器（venv/bin/python 或 venv/Scripts/python.exe）')

const coreDir = path.join(runtimeDir, 'core')
const hasCore = existsSync(path.join(coreDir, 'hermes_cli'))
hasCore ? say(ok, `核心源码树：${path.relative(root, coreDir)}`) : say(warn, '没有 core/ 源码树（单 venv 布局可以没有；随包布局必须有）')
if (hasCore) {
  const contracts = existsSync(path.join(coreDir, 'tui_gateway', 'contracts', 'registry.py'))
  contracts ? say(ok, '契约定义在（tui_gateway/contracts）') : say(warn, '找不到 tui_gateway/contracts/registry.py —— 这份源码树可能被裁剪过')
}

// 2) 清单
const manifestPath = path.join(runtimeDir, '.24h-os-runtime.json')
if (!existsSync(manifestPath)) {
  say(warn, '没有清单 .24h-os-runtime.json（旧脚本构建的产物；重跑 build-runtime 会补上）')
} else {
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (err) {
    say(fail, `清单解析失败：${err.message}`)
  }
  if (manifest) {
    say(ok, `清单：coreVersion=${manifest.coreVersion ?? '?'} commit=${(manifest.coreCommit ?? '缺').slice(0, 8)} python=${manifest.python ?? '?'} platform=${manifest.platform ?? '?'} layout=${manifest.layout ?? '?'}`)
    if (!manifest.coreCommit) say(warn, '清单缺 coreCommit（升级核心后无法确认跑的是哪一版上游代码）')

    // 3) 源码树指纹：与清单里的 coreTreeSha256 比对
    if (hasCore && manifest.coreTreeSha256) {
      // 与写入清单时用的是同一个函数（scripts/lib/runtime-tree.mjs），否则永远对不上
      const treeSha = treeFingerprint(coreDir).sha256
      const same = treeSha === manifest.coreTreeSha256
      if (same) say(ok, `源码树指纹一致（${treeSha.slice(0, 12)}…）`)
      else if (rehash) {
        manifest.coreTreeSha256 = treeSha
        manifest.rehashedAt = new Date().toISOString()
        writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
        say(ok, `源码树指纹不一致，已按当前目录重写清单：${treeSha.slice(0, 12)}…（清单里原来写的是 ${manifest.coreTreeSha256.slice(0, 12)}…）`)
      } else say(fail, `源码树指纹对不上：清单 ${manifest.coreTreeSha256.slice(0, 12)}… vs 实际 ${treeSha.slice(0, 12)}…（确认没问题就 --rehash 重写）`)
    } else if (hasCore) say(warn, '清单里没有 coreTreeSha256（旧脚本构建的产物），无法核对源码树')
  }
}

const total = (dir) => {
  let bytes = 0
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()
    for (const entry of readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.isFile()) bytes += statSync(full).size
    }
  }
  return bytes
}
say(ok, `体积：${(total(runtimeDir) / 1024 / 1024).toFixed(0)} MB`)

console.log(`\n运行时体检：${path.relative(root, runtimeDir) || runtimeDir}`)
for (const m of ok) console.log('  ✓ ' + m)
for (const m of warn) console.log('  ⚠ ' + m)
for (const m of fail) console.log('  ✗ ' + m)
console.log(`\n${fail.length ? '不通过' : '通过'}（${ok.length} 项通过 / ${warn.length} 项提示 / ${fail.length} 项失败）`)
process.exit(fail.length ? 1 : 0)
