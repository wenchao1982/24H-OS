#!/usr/bin/env node
/**
 * 出 Windows 安装包的包装脚本：把国内网络下必踩的"下载 electron-builder 二进制"这一步指到镜像。
 *
 * 为什么需要它：electron-builder 首次打 Windows 包时会去 GitHub Releases 下载
 * `winCodeSign`（签名工具）和 `nsis`（安装器）两个二进制包，国内直连基本会卡死或失败。
 * 官方留了环境变量 `ELECTRON_BUILDER_BINARIES_MIRROR`，指向 npmmirror 即可（实测该镜像有这两个包）。
 *
 * 用法：npm run dist（= 本脚本）
 *   ARGS='--dir' npm run dist        # 只出解包目录
 *   SKIP_MIRROR=1 npm run dist       # 需要走官方源时
 */
import { spawn } from 'node:child_process'

const MIRROR = 'https://registry.npmmirror.com/-/binary/electron-builder-binaries/'
const env = { ...process.env }
if (!process.env.SKIP_MIRROR) {
  env.ELECTRON_BUILDER_BINARIES_MIRROR ||= MIRROR
  env.ELECTRON_MIRROR ||= 'https://registry.npmmirror.com/-/binary/electron/'
}
// 参数：命令行优先，其次 ARGS 环境变量，最后默认"Windows NSIS 安装包"
const cliArgs = process.argv.slice(2)
const envArgs = process.env.ARGS ? process.env.ARGS.split(' ').filter(Boolean) : []
const extra = cliArgs.length ? [...cliArgs] : envArgs.length ? [...envArgs] : ['--win', 'nsis']

// `--dir`（只出解包目录）不加平台参数时，按当前平台来：Linux 上不能打 NSIS，Windows 上也不用瞎指定
if (extra.includes('--dir') && !extra.some((a) => a === '--win' || a === '--linux' || a === '--mac' || a.startsWith('--win') === true)) {
  extra.push(process.platform === 'win32' ? '--win' : process.platform === 'darwin' ? '--mac' : '--linux')
}
// 在非 Windows 机器上打 NSIS 需要 wine —— 直接说清楚，别让用户看一屏堆栈
if (process.platform !== 'win32' && extra.includes('--win') && !extra.includes('--dir')) {
  console.error('提示：Windows 安装包（NSIS）必须在 Windows 上打包（Linux 需要 wine，本机没有）。')
  console.error('      只想验证打包流程：npm run dist:dir（会打当前平台的解包目录 + 自检）。')
  console.error('      真要在 Linux 出 exe，请先装 wine，或改用 CI/Windows 机器。')
  process.exit(2)
}
const args = ['electron-builder', ...extra, '--publish', 'never']
console.log(`electron-builder ${args.slice(1).join(' ')}`)
console.log(`  ELECTRON_BUILDER_BINARIES_MIRROR=${env.ELECTRON_BUILDER_BINARIES_MIRROR ?? '(未设置)'}`)

const child = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', args, { stdio: 'inherit', env })
child.on('exit', (code) => process.exit(code ?? 1))
