/**
 * 界面层冒烟（真浏览器，不需要图形界面）：用 chrome-headless-shell 打开 src/index.html，
 * 用假的 window.hermes 顶掉 IPC，验证「协议层测不到、但用户一眼就能看到」的那类问题：
 *   ① 带 hidden 的弹层/面板到底藏没藏住、点「关闭」关不关得掉
 *   ② 窗口比核心先就绪时（常态），模型/会话列表会不会永远停在「读取中…」
 *   ③ IPC 返回值忘了拆 {ok,data} 导致界面显示 undefined
 *
 * 用法：
 *   CHROME=/path/to/chrome-headless-shell node scripts/ui-smoke.mjs          # 测当前工作区
 *   CHROME=... node scripts/ui-smoke.mjs --before                            # 测 git HEAD（对照用）
 * 依赖 puppeteer-core（可选，缺了就跳过，不算失败）：
 *   npm i -D puppeteer-core --registry=https://registry.npmmirror.com
 * chrome-headless-shell 从镜像取（≈118MB，无需图形环境、无需 root）：
 *   https://cdn.npmmirror.com/binaries/chrome-for-testing/<版本>/linux64/chrome-headless-shell-linux64.zip
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const REPO = process.env.REPO || path.resolve(import.meta.dirname, '..')
const BEFORE = process.argv.includes('--before')

const candidates = [
  process.env.CHROME,
  path.join(REPO, 'node_modules', 'chrome-headless-shell', 'chrome-headless-shell-linux64', 'chrome-headless-shell'),
  '/tmp/chrome/chrome-headless-shell-linux64/chrome-headless-shell'
]
const CHROME = candidates.find((p) => p && fs.existsSync(p))
if (!CHROME) {
  console.log('跳过界面层冒烟：没找到 chrome-headless-shell（设 CHROME= 指向它，见文件头注释）')
  process.exit(0)
}

let puppeteer
try {
  puppeteer = (await import('puppeteer-core')).default
} catch {
  console.log('跳过界面层冒烟：没装 puppeteer-core（npm i -D puppeteer-core --registry=https://registry.npmmirror.com）')
  process.exit(0)
}

let pageDir = path.join(REPO, 'src')
if (BEFORE) {
  // 从 git HEAD 取出修复前的 src/（用户机器上就是这份）
  const dir = '/tmp/guitest/before-src'
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  for (const f of ['index.html', 'styles.css', 'renderer.js']) {
    fs.writeFileSync(path.join(dir, f), execFileSync('git', ['-C', REPO, 'show', `HEAD:src/${f}`]))
  }
  pageDir = dir
}

const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const RESP = {
  state: { phase: 'starting', logs: [] },
  modelsList: { providers: [{ slug: 'deepseek', name: 'DeepSeek', models: ['deepseek-chat', 'deepseek-reasoner'], is_current: true }] },
  sessionsList: { sessions: [{ id: 's1', title: '冒烟会话', message_count: 2 }] },
  sessionsCreate: { session_id: 's-new', info: { model: 'deepseek-chat' } },
  sessionHistory: {
    count: 2,
    messages: [
      { role: 'user', content: '把关键数字整理成表格' },
      {
        role: 'assistant',
        content: '好的：\n\n| 项目 | Q2 | Q3 |\n| --- | --- | --- |\n| 营收 | 1.24 亿 | 1.51 亿 |\n\n脚本如下：\n\n```python\nprint("ok")\n```\n\n已导出 `exports/Q3.xlsx`，营收 **1.51 亿**。'
      }
    ]
  },
  configGet: { model: 'deepseek-chat' },
  customEndpoints: []
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  args: ['--no-sandbox', '--disable-gpu', '--force-device-scale-factor=1', '--hide-scrollbars'],
  defaultViewport: { width: 1180, height: 780 }
})
const page = await browser.newPage()
page.on('pageerror', (e) => console.log('  [pageerror]', e.message))
await page.evaluateOnNewDocument((RESP) => {
  window.__calls = []
  window.__handlers = {}
  window.hermes = new Proxy({}, {
    get(_t, key) {
      const name = String(key)
      if (name.startsWith('on')) return (cb) => { window.__handlers[name] = cb; return () => {} }
      return (...args) => {
        window.__calls.push(name)
        return Promise.resolve({ ok: true, data: RESP[name] ?? {} })
      }
    }
  })
}, RESP)

const display = (id) => page.$eval(id, (el) => getComputedStyle(el).display)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

await page.goto('file://' + path.join(pageDir, 'index.html'))
await wait(300)

console.log(`\n== ${BEFORE ? '修复前（git HEAD）' : '修复后（工作区）'} ==`)
check('启动时设置弹层是隐藏的', (await display('#settings')) === 'none', `display=${await display('#settings')}`)
check('启动时文件面板是隐藏的', (await display('#files-panel')) === 'none', `display=${await display('#files-panel')}`)
check('启动时告警条是隐藏的', (await display('#banner')) === 'none', `display=${await display('#banner')}`)

if (!BEFORE) {
  await page.screenshot({ path: '/tmp/guitest/after-boot.png' })
} else {
  await page.screenshot({ path: '/tmp/guitest/before-boot.png' })
}

// 核心晚就绪：模拟 runtime ready 事件（用户的窗口通常比核心先出现）
const hasReady = await page.evaluate(() => typeof window.__handlers.onReady === 'function')
check('渲染进程挂上了核心就绪回调', hasReady)
await page.evaluate(() => window.__handlers.onReady({ port: 12345 }))
await wait(500)
const calls = await page.evaluate(() => window.__calls)
check('核心就绪后补拉了模型列表', calls.includes('modelsList'), calls.join(','))
check('核心就绪后补拉了会话列表', calls.includes('sessionsList'))
const modelOpts = await page.$$eval('#model-select option', (o) => o.map((x) => x.textContent))
check('模型下拉框里有服务商模型（不再是「读取中…」）', modelOpts.some((t) => t.includes('deepseek-chat')), modelOpts.join(' | '))
const sessRows = await page.$$eval('#sessions > *', (n) => n.length)
check('会话列表渲染出 1 条', sessRows === 1, `行数=${sessRows}`)

// 界面外观（协议层测不出来，但用户第一眼就是它）
const themeBefore = await page.evaluate(() => {
  document.documentElement.dataset.theme = 'dark'
  return document.documentElement.dataset.theme
})
await page.evaluate(() => document.getElementById('btn-theme').click())
await wait(150)
const themeAfter = await page.evaluate(() => document.documentElement.dataset.theme)
check('点「外观」能真的切主题', themeBefore === 'dark' && themeAfter === 'light', `${themeBefore} → ${themeAfter}`)
await page.evaluate(() => document.getElementById('btn-theme').click())
await wait(100)

const md = await page.evaluate(() => ({
  table: document.querySelectorAll('.bubble .md-table td').length,
  fence: document.querySelectorAll('.bubble .md-fence code').length,
  code: document.querySelectorAll('.bubble .md-code').length,
  strong: document.querySelectorAll('.bubble strong').length
}))
check(
  '助手回复的 Markdown 渲染成真元素（表格/代码块/行内码/粗体）',
  md.table > 0 && md.fence > 0 && md.code > 0 && md.strong > 0,
  JSON.stringify(md)
)

// IPC 返回值是 {ok,data}，忘了拆包就会显示 undefined（曾把「核心就绪」判成没就绪）
const header = await page.$eval('#core-state', (el) => el.textContent)
check('顶部核心状态有真值（不是 undefined）', /ready/.test(header) && !/undefined/.test(header), `“${header}”`)
const runInfo = await page.$eval('#run-info', (el) => el.textContent)
check('运行信息面板有真值（不是 undefined）', !/undefined/.test(runInfo), `“${runInfo}”`)

// 打开设置 → 关闭的四个入口
await page.click('#btn-settings')
await wait(300)
check('点「设置」能打开', (await display('#settings')) === 'flex', `display=${await display('#settings')}`)
const provOpts = await page.$$eval('#set-provider option', (o) => o.map((x) => x.textContent))
check('设置里服务商下拉框有内容', provOpts.length > 0 && provOpts[0].includes('DeepSeek'), provOpts.join(' | '))
await page.screenshot({ path: '/tmp/guitest/settings-open.png' })

await page.click('#btn-close-settings-x')
await wait(150)
check('右上 ✕ 能关', (await display('#settings')) === 'none', `display=${await display('#settings')}`)
// 弹层关掉后必须真的不占布局（offsetParent=null），顶部按钮可点
const layout = await page.evaluate(() => ({
  modal: document.getElementById('settings').offsetParent === null,
  topBtn: document.getElementById('btn-settings').offsetParent !== null
}))
check('关掉后弹层不占布局、顶部按钮可点', layout.modal && layout.topBtn, JSON.stringify(layout))

await page.click('#btn-settings')
await wait(200)
await page.keyboard.press('Escape')
await wait(150)
check('Esc 能关', (await display('#settings')) === 'none', `display=${await display('#settings')}`)

await page.click('#btn-settings')
await wait(200)
await page.click('#btn-close-settings')
await wait(150)
check('底部「关闭」按钮能关', (await display('#settings')) === 'none', `display=${await display('#settings')}`)

await page.click('#btn-settings')
await wait(200)
await page.mouse.click(30, 400) // 点卡片外的底色
await wait(150)
check('点弹层底色能关', (await display('#settings')) === 'none', `display=${await display('#settings')}`)

await browser.close()
const failed = results.filter((r) => !r).length
console.log(`\n${results.length - failed}/${results.length} 通过`)
process.exit(failed ? 1 : 0)
