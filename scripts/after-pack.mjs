/**
 * electron-builder 的 afterPack 钩子：**打包完立刻自检**，别等用户装完才发现缺东西。
 *
 * 为什么需要它：electron-builder 对 extraResources 是"有就带上、没有就当没写"——
 * `runtime/` 忘了构建、asar 里漏了 preload、图标没生效，打包都会"成功"。等你把 300MB
 * 的安装包发给用户、他装完打不开，才发现是这几种情况之一。
 * 所以这里在打包结束、产物还没被压进安装器之前，把该有的东西逐个点一遍。
 *
 * 校验项：
 *   ① app.asar 里必须有壳的入口：electron/main.js、electron/preload.cjs、src/index.html、src/renderer.js、package.json
 *   ② resources/runtime/ 必须有随包运行时：core（hermes_cli 源码树）+ venv 解释器 + 运行时清单
 *   ③ 运行时清单里的 coreVersion 要能和壳对上（对不上只是告警，因为契约版本才是在跑的时候校验的）
 *
 * 允许"还没构建运行时"的场景：设 SKIP_RUNTIME_CHECK=1（例如只验界面、或临时快速出包）。
 *
 * 注意：钩子路径必须落在工程目录内（electron-builder 会拒绝解析到工程外的路径）。
 */
import { closeSync, existsSync, openSync, readFileSync, readdirSync, readSync, statSync } from 'node:fs'
import path from 'node:path'

/** 读 asar 头部（8 字节前缀 + JSON 头），返回包内文件路径集合；解析不了就返回 null。 */
function readAsarEntries(asarPath) {
  let fd
  try {
    fd = openSync(asarPath, 'r')
    // asar 头：4 个 pickle 长度字段（共 16 字节）+ JSON 头。实测（electron-builder 26 产物）：
    //   偏移 0 = 4（常量）、偏移 4/8/12 = 长度字段，JSON 从偏移 16 开始，长度在偏移 12。
    // 为兼容别的打包器，这里两种布局都试一遍，能解析出 JSON 的就是对的。
    const prefix = Buffer.alloc(16)
    readSync(fd, prefix, 0, 16, 0)
    let tree = null
    for (const [lenOffset, jsonOffset] of [[12, 16], [4, 8]]) {
      const headerSize = prefix.readUInt32LE(lenOffset)
      if (!headerSize || headerSize > 64 * 1024 * 1024) continue
      const header = Buffer.alloc(headerSize)
      readSync(fd, header, 0, headerSize, jsonOffset)
      try {
        const parsed = JSON.parse(header.toString('utf8'))
        if (parsed && typeof parsed === 'object') {
          tree = parsed
          break
        }
      } catch {
        /* 换下一种布局再试 */
      }
    }
    if (!tree) return null
    const out = new Set()
    const walk = (node, base) => {
      for (const [name, value] of Object.entries(node.files ?? {})) {
        const p = base ? `${base}/${name}` : name
        if (value && value.files) walk(value, p)
        else out.add(p)
      }
    }
    walk(tree, '')
    return out
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

export default async function afterPack(context) {
  const appOutDir = context.appOutDir
  const problems = []
  const notes = []

  // ① asar 内容
  const asarPath = path.join(appOutDir, 'resources', 'app.asar')
  if (!existsSync(asarPath)) {
    problems.push(`缺 app.asar：${asarPath}`)
  } else {
    const entries = readAsarEntries(asarPath)
    const required = ['electron/main.js', 'electron/preload.cjs', 'src/index.html', 'src/renderer.js', 'package.json']
    if (entries) {
      for (const rel of required) if (!entries.has(rel)) problems.push(`app.asar 里少了 ${rel}`)
      notes.push(`app.asar 内 ${entries.size} 个文件`)
    } else {
      // 解析不了就退化成关键词扫描（asar 头的 JSON 里 key 是文件名）
      const head = readFileSync(asarPath).subarray(0, 4 * 1024 * 1024).toString('utf8')
      for (const base of ['main.js', 'preload.cjs', 'index.html', 'renderer.js']) {
        if (!head.includes(base)) problems.push(`app.asar 头里没找到 ${base}`)
      }
      notes.push('app.asar 头解析失败，已退化为关键词扫描')
    }
  }

  // ② 随包运行时
  const runtimeDir = path.join(appOutDir, 'resources', 'runtime')
  const skipRuntime = process.env.SKIP_RUNTIME_CHECK === '1'
  if (!existsSync(runtimeDir)) {
    const msg = `缺随包运行时：${runtimeDir}（先跑 scripts/build-runtime.ps1 / build-runtime.sh；确实要跳过就设 SKIP_RUNTIME_CHECK=1）`
    if (skipRuntime) notes.push('⚠ ' + msg)
    else problems.push(msg)
  } else {
    const manifestPath = path.join(runtimeDir, '.24h-os-runtime.json')
    const coreDir = path.join(runtimeDir, 'core', 'hermes_cli')
    const venvWin = path.join(runtimeDir, 'venv', 'Scripts', 'python.exe')
    const venvPosix = path.join(runtimeDir, 'venv', 'bin', 'python')
    if (!existsSync(coreDir)) problems.push(`运行时里没有核心源码树：${coreDir}`)
    if (!existsSync(venvWin) && !existsSync(venvPosix)) problems.push('运行时里没有 venv 解释器（venv/Scripts/python.exe 或 venv/bin/python）')
    if (!existsSync(manifestPath)) problems.push(`运行时清单缺失：${manifestPath}`)
    else {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
        // 只报事实：核心版本对不对，在运行时由 desktop_contract 校验（壳编译期期望值 vs 核心给的）
        notes.push(`运行时 coreVersion=${manifest.coreVersion ?? '?'} python=${manifest.python ?? '?'} ref=${manifest.coreRef ?? '?'} layout=${manifest.layout ?? '?'}`)
      } catch (err) {
        problems.push(`运行时清单读不动：${err.message}`)
      }
    }
    const size = Number(process.env.RUNTIME_MIN_MB ?? 80) * 1024 * 1024
    const bytes = dirSize(runtimeDir)
    notes.push(`运行时体积 ${(bytes / 1024 / 1024).toFixed(0)} MB`)
    if (bytes < size) problems.push(`运行时体积只有 ${(bytes / 1024 / 1024).toFixed(0)} MB，小于 ${process.env.RUNTIME_MIN_MB ?? 80} MB —— 多半是没构建全`)
  }

  // ③ 图标
  const iconPath = path.join(context.packager.info.projectDir, 'build', 'icon.ico')
  notes.push(existsSync(iconPath) ? 'build/icon.ico 存在' : '⚠ 没有 build/icon.ico，Windows 会显示 Electron 默认图标')

  console.log(`\n[after-pack 自检] ${path.basename(appOutDir)}`)
  for (const n of notes) console.log('  · ' + n)
  if (problems.length) {
    console.error('[after-pack 自检] 失败：')
    for (const p of problems) console.error('  ✗ ' + p)
    throw new Error(`打包自检未通过（${problems.length} 项）`)
  }
  console.log('  ✓ 打包自检通过\n')
}

function dirSize(dir) {
  let total = 0
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()
    let entries
    try {
      entries = readdirSync(cur, { withFileTypes: true })
    } catch {
      continue // 读不到的目录直接跳过，不让自检因为权限问题误报
    }
    for (const entry of entries) {
      const p = path.join(cur, entry.name)
      try {
        if (entry.isDirectory()) stack.push(p)
        else if (entry.isFile()) total += statSync(p).size
      } catch {
        /* 跳过 */
      }
    }
  }
  return total
}
