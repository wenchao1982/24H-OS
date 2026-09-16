/**
 * 运行时源码树指纹：把 core/ 下所有文件的 "相对路径 大小" 按**字节序**排序后取 sha256。
 *
 * 为什么是这一套：不是要加密强度，而是要一个"这份代码是不是同一份"的稳定指纹 ——
 * 换核心版本、补丁、或目录被换过，指纹都会变。写入清单（build 时）与校验清单（发版前）
 * 必须用**同一个函数**，否则两边各算一套，永远对不上（踩过：bash 与 JS 各写一份，排序与行尾不同）。
 *
 * 约定（改动任一细节都会让历史清单失效，改前先想清楚）：
 *   · 路径统一用 "/"，不带前导 "./"（例如 `hermes_cli/main.py 12345`）
 *   · 按字节序（LC_ALL=C 等价）排序，而不是本地化排序
 *   · 以 "\n" 连接，且**末尾带一个换行**
 */
import { createHash } from 'node:crypto'
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'

export function listTreeFiles(rootDir) {
  const out = []
  const walk = (dir, base) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = base ? `${base}/${entry.name}` : entry.name
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full, rel)
      else if (entry.isFile()) out.push(`${rel} ${statSync(full).size}`)
    }
  }
  walk(rootDir, '')
  return out
}

export function treeFingerprint(rootDir) {
  const lines = listTreeFiles(rootDir)
  lines.sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')))
  const text = lines.join('\n') + '\n'
  return { sha256: createHash('sha256').update(text, 'utf8').digest('hex'), files: lines.length }
}
