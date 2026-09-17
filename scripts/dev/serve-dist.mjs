#!/usr/bin/env node
/**
 * 极简静态分发源（只读，无依赖）：把 dist-assets/（或任意目录）用 HTTP 暴露出去。
 *
 * 用途：作为运行时分发源。两种用法：
 *   · 本机验证：node scripts/dev/serve-dist.mjs --dir dist-assets --port 8899
 *   · 挂在公网：配合 frp/frp 应用把本机 8899 映射到公网端口，公网地址就是
 *       http://<你的服务器IP>:<远程端口>/   ← 填进「设置 → 高级 → 运行时分发源」
 *
 * 安全：只读、只服务指定目录（拒绝路径穿越），不做上传；资产本身带 sha256，被改动会在客户端校验失败。
 */
import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const ROOT = path.resolve(flag('dir', process.env.DIST_DIR || 'dist-assets'))
const PORT = Number(flag('port', process.env.DIST_PORT || 8899))
const HOST = flag('host', process.env.DIST_HOST || '127.0.0.1')
// 上传口令（可选）：设了它才接受 PUT /upload/<相对路径>，用来从别的机器把资产传上来
const UPLOAD_TOKEN = flag('upload-token', process.env.DIST_UPLOAD_TOKEN || '')

const TYPES = { '.gz': 'application/gzip', '.json': 'application/json', '.sha256': 'text/plain', '.exe': 'application/octet-stream', '.zip': 'application/zip' }

const SAFE_NAME = /^[A-Za-z0-9._\/-]+$/

const server = http.createServer(async (req, res) => {
  // ── 上传（可选）：PUT /upload/<平台>/<文件名>，需带 x-upload-token ──────────
  if (req.method === 'PUT' && (req.url || '').startsWith('/upload/')) {
    if (!UPLOAD_TOKEN) {
      res.writeHead(403, { 'content-type': 'text/plain' }).end('upload disabled')
      return
    }
    if (String(req.headers['x-upload-token'] || '') !== UPLOAD_TOKEN) {
      res.writeHead(401, { 'content-type': 'text/plain' }).end('bad token')
      return
    }
    const rel = decodeURIComponent((req.url || '').slice('/upload/'.length)).replace(/^([/\\])+/, '')
    if (!SAFE_NAME.test(rel) || rel.includes('..')) {
      res.writeHead(400, { 'content-type': 'text/plain' }).end('bad path')
      return
    }
    const target = path.join(ROOT, rel)
    if (!target.startsWith(ROOT)) {
      res.writeHead(403, { 'content-type': 'text/plain' }).end('forbidden')
      return
    }
    mkdirSync(path.dirname(target), { recursive: true })
    try {
      await pipeline(req, createWriteStream(target))
      console.log(`${new Date().toISOString()} PUT  ${rel} (${(statSync(target).size / 1024 / 1024).toFixed(1)} MB)`)
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, path: rel, size: statSync(target).size }))
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain' }).end(`write failed: ${err.message}`)
    }
    return
  }
  const url = decodeURIComponent((req.url || '/').split('?')[0])
  const rel = path.normalize(url).replace(/^([/\\])+/, '')
  const file = path.join(ROOT, rel)
  // 反路径穿越：目标必须落在 ROOT 内
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden')
    return
  }
  if (!existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
    return
  }
  const size = statSync(file).size
  res.writeHead(200, {
    'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
    'content-length': size,
    'accept-ranges': 'bytes'
  })
  createReadStream(file).pipe(res)
  console.log(`${new Date().toISOString()} 200 ${rel} (${(size / 1024 / 1024).toFixed(1)} MB)`)
})

server.listen(PORT, HOST, () => {
  console.log(`分发源已启动：http://${HOST}:${PORT}/  目录=${ROOT}`)
})
