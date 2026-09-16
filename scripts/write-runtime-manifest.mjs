#!/usr/bin/env node
/**
 * 写运行时清单（runtime/.24h-os-runtime.json）—— build-runtime.sh / .ps1 都调用它。
 * 与 scripts/verify-runtime.mjs 共用同一个指纹函数（scripts/lib/runtime-tree.mjs），
 * 保证"写入"和"校验"算的是同一个值（之前 bash/JS 各写一份，永远对不上）。
 *
 * 用法：
 *   node scripts/write-runtime-manifest.mjs --dir runtime --ref main --core-version 0.21.3 \
 *        --python 3.12 --mirror https://mirrors.aliyun.com/pypi/simple/
 *   （--platform 默认取 process.platform-process.arch；--no-network 跳过取上游 commit）
 */
import { existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { treeFingerprint } from './lib/runtime-tree.mjs'

const args = process.argv.slice(2)
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback
}
const dir = path.resolve(flag('dir', 'runtime'))
const ref = flag('ref', 'main')
const coreVersion = flag('core-version', 'unknown')
const pythonVersion = flag('python', 'unknown')
const mirror = flag('mirror', '')
const platform = flag('platform', `${process.platform === 'win32' ? 'win32' : process.platform}-${process.arch}`)
const allowNetwork = !args.includes('--no-network')

if (!existsSync(dir)) {
  console.error(`找不到运行时目录：${dir}（先构建，或用 --dir 指定）`)
  process.exit(1)
}

// 上游 commit：能连 api.github.com 就记下（连不上不阻塞构建，只是这一格留空）
let coreCommit = ''
if (allowNetwork) {
  try {
    const res = await fetch(`https://api.github.com/repos/NousResearch/hermes-agent/commits/${encodeURIComponent(ref)}`, {
      headers: { 'User-Agent': '24h-os-build', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(20000)
    })
    if (res.ok) coreCommit = (await res.json())?.sha ?? ''
  } catch {
    console.log('    （取上游 commit 失败，清单里留空）')
  }
}

let treeSha = ''
let fileCount = 0
const coreDir = path.join(dir, 'core')
if (existsSync(path.join(coreDir, 'hermes_cli'))) {
  const fp = treeFingerprint(coreDir)
  treeSha = fp.sha256
  fileCount = fp.files
}

const manifest = {
  schema: 1,
  coreRef: ref,
  coreVersion,
  coreCommit,
  coreTreeSha256: treeSha,
  coreFileCount: fileCount,
  builtAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  python: pythonVersion,
  platform,
  pipMirror: mirror,
  layout: 'venv+core-source'
}
writeFileSync(path.join(dir, '.24h-os-runtime.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
console.log(`    清单: coreVersion=${coreVersion} commit=${coreCommit.slice(0, 8) || '(空)'} tree=${treeSha.slice(0, 8) || '(空)'} files=${fileCount} platform=${platform}`)
