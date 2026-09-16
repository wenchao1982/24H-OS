#!/usr/bin/env node
/**
 * 从核心生成契约快照（electron/contract.generated.json）。
 *
 * 为什么要这个：壳调用核心走的是字符串方法名（`gwCall('session.usage')`），名字写错、
 * 或在核心升级后方法被改名/删掉，都是"运行时才炸"的错。把核心自己声明的契约抓下来存进仓库，
 * 就能在冒烟里静态比对："我们调用的每个方法/事件，核心都声明过"。
 * （踩过两次：`model.save_key` 参数名、以及服务商列表 API 变了导致 4002。）
 *
 * 用法：
 *   node scripts/gen-contract.mjs                     # 用 runtime/core（随包运行时源码树）
 *   CORE_DIR=/path/to/hermes-agent node scripts/gen-contract.mjs
 *   PYTHON=/path/to/venv/bin/python node scripts/gen-contract.mjs
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const coreDir = process.env.CORE_DIR || path.join(root, 'runtime', 'core')
const outFile = path.join(root, 'electron', 'contract.generated.json')

if (!existsSync(path.join(coreDir, 'tui_gateway', 'contracts', 'registry.py'))) {
  console.error(`找不到核心源码树：${coreDir}（先跑 scripts/build-runtime.sh / build-runtime.ps1，或用 CORE_DIR= 指定）`)
  process.exit(2)
}

const candidates = [
  process.env.PYTHON,
  path.join(root, 'runtime', 'venv', 'bin', 'python'),
  path.join(root, 'runtime', 'venv', 'Scripts', 'python.exe')
].filter(Boolean)
const python = candidates.find((p) => existsSync(p))
if (!python) {
  console.error('找不到可用的 python（设 PYTHON= 指向随包 venv 的解释器）')
  process.exit(2)
}

const dump = `
import json
from tui_gateway.contracts.registry import EVENTS, METHODS, SERVER_REQUESTS
def params_of(spec):
    p = getattr(spec, "params", None)
    if p is None:
        return []
    try:
        return sorted(p.model_json_schema().get("properties", {}).keys())
    except Exception:
        return []
print(json.dumps({
    "methods": {name: {"params": params_of(METHODS[name])} for name in sorted(METHODS)},
    "events": sorted(EVENTS),
    "serverRequests": sorted(SERVER_REQUESTS),
}, ensure_ascii=False))
`
const raw = execFileSync(python, ['-c', dump], {
  cwd: coreDir,
  env: { ...process.env, PYTHONPATH: coreDir },
  encoding: 'utf8',
  maxBuffer: 32 * 1024 * 1024
})
const parsed = JSON.parse(raw)

let coreVersion = null
try {
  const manifest = JSON.parse(readFileSync(path.join(root, 'runtime', '.24h-os-runtime.json'), 'utf8'))
  coreVersion = manifest.coreVersion ?? null
} catch {
  /* 没有清单也能生成，只是记不下版本 */
}

const payload = {
  generatedAt: new Date().toISOString(),
  coreVersion,
  coreDir: path.relative(root, coreDir) || coreDir,
  counts: {
    methods: Object.keys(parsed.methods).length,
    events: parsed.events.length,
    serverRequests: parsed.serverRequests.length
  },
  methods: parsed.methods,
  events: parsed.events,
  serverRequests: parsed.serverRequests
}
writeFileSync(outFile, JSON.stringify(payload, null, 2) + '\n', 'utf8')
console.log(
  `✓ ${path.relative(root, outFile)}（核心 ${coreVersion ?? '?'}：${payload.counts.methods} 方法 / ${payload.counts.events} 事件 / ${payload.counts.serverRequests} 服务端请求）`
)
