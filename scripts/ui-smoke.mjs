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
  // 真实形状：全新安装时 include_unconfigured=1 会给出 54 项，其中 moa 是虚拟聚合器（不能填 key）
  modelsList: {
    providers: [
      { slug: 'moa', name: 'Mixture of Agents', auth_type: 'virtual', authenticated: true, models: ['default'], is_current: false },
      { slug: 'opencode-free', name: 'OpenCode Free', auth_type: 'hermes', authenticated: true, models: ['opencode-free'], is_current: false },
      { slug: 'deepseek', name: 'DeepSeek', auth_type: 'api_key', authenticated: false, models: [], is_current: false, key_env: 'DEEPSEEK_API_KEY' }
    ]
  },
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
  customEndpoints: [],
  uiInfo: {
    appVersion: '0.1.0',
    electronVersion: '40.10.2',
    platform: 'linux-x64',
    packaged: false,
    paths: { userData: '/tmp/24h-userdata', hermesHome: '/tmp/24h-hermes', runtime: '/repo/runtime' }
  },
  runtimeInfo: { manifest: { coreVersion: '0.21.3', python: '3.12', layout: 'venv+core-source', builtAt: '2026-09-16T07:31:11Z' } },
  health: { ok: true, version: '0.21.3' },
  skillsList: { skills: { creative: ['baoyu-infographic', 'p5js'], devops: ['tmux'] }, total: 3 },
  cronList: { jobs: [{ job_id: 'j1', name: '每日摘要', schedule: '0 9 * * *', deliver: 'chat' }], count: 1 },
  insights: { days: 30, sessions: 12, messages: 148 },
  usageBars: { ok: true, available: false },
  sessionUsage: { context_percent: 12, context_used: 3400, context_max: 28000, total: 3400, calls: 3 },
  runtimeCheck: { ok: true, provider: 'deepseek' }
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
check('启动时右侧面板是隐藏的', (await display('#panel')) === 'none', `display=${await display('#panel')}`)
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
check('没配 Key 时模型下拉给出明确下一步（不是空白）', modelOpts.some((t) => t.includes('设置')), modelOpts.join(' | '))
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

// 一级导航（技能 / 任务 / 用量 / 对话）
await page.click('#nav-skills')
await wait(250)
const skillsView = await page.evaluate(() => ({
  page: document.getElementById('page-skills').hidden,
  chat: document.getElementById('chat-view').hidden,
  rows: document.querySelectorAll('#skills-body .list-row').length,
  summary: document.getElementById('skills-summary').textContent
}))
check('一级导航能切到「技能」页并列出技能', skillsView.page === false && skillsView.chat === true && skillsView.rows > 0, JSON.stringify(skillsView))

await page.click('#nav-tasks')
await wait(250)
const tasksRows = await page.$$eval('#tasks-body .list-row', (n) => n.length)
check('「任务」页列出定时任务', tasksRows > 0, `行数=${tasksRows}`)

await page.click('#nav-usage')
await wait(300)
const usage = await page.evaluate(() => ({
  stats: document.querySelectorAll('#usage-body .stat').length,
  summary: document.getElementById('usage-summary').textContent
}))
check('「用量」页给出会话/消息统计', usage.stats >= 2, JSON.stringify(usage))

await page.click('#nav-chat')
await wait(200)
check('能切回对话页', await page.$eval('#chat-view', (el) => !el.hidden))

// 右侧面板：文件 / 预览 / 日志 三个标签
await page.click('#btn-panel')
await wait(250)
const panel1 = await page.evaluate(() => ({
  panel: !document.getElementById('panel').hidden,
  files: !document.getElementById('pane-files').hidden,
  logs: document.getElementById('pane-logs').hidden
}))
check('「面板」打开后默认在文件标签', panel1.panel && panel1.files && panel1.logs, JSON.stringify(panel1))
await page.click('#tab-logs')
await wait(150)
const panel2 = await page.evaluate(() => ({
  logs: !document.getElementById('pane-logs').hidden,
  files: document.getElementById('pane-files').hidden
}))
check('面板能切到日志标签', panel2.logs && panel2.files, JSON.stringify(panel2))
await page.click('#btn-panel-close')
await wait(150)
check('面板能收起', await page.$eval('#panel', (el) => el.hidden))

// 命令面板（Ctrl/Cmd + K）
await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })))
await wait(250)
const pal = await page.evaluate(() => ({
  open: !document.getElementById('palette').hidden,
  items: document.querySelectorAll('#palette-list .palette-item').length
}))
check('Ctrl+K 能打开命令面板并列命令', pal.open && pal.items > 5, JSON.stringify(pal))
await page.type('#palette-input', '主题')
await wait(200)
const palFiltered = await page.$$eval('#palette-list .palette-item .t', (n) => n.map((x) => x.textContent))
check('命令面板能按关键词过滤', palFiltered.length > 0 && palFiltered.length < pal.items && palFiltered.every((t) => t.includes('主题')), palFiltered.join(' | '))
await page.keyboard.press('Escape')
await wait(150)
check('Esc 能关掉命令面板', await page.$eval('#palette', (el) => el.hidden))

// 设置分节
await page.click('#btn-settings')
await wait(300)
const sec1 = await page.evaluate(() => {
  const active = document.querySelector('#settings-nav button.active')
  return { sec: active?.dataset.sec, panes: [...document.querySelectorAll('.settings-pane')].filter((p) => !p.hidden).map((p) => p.dataset.sec) }
})
check('设置默认停在「服务商与模型」分节', sec1.sec === 'model' && sec1.panes.length === 1, JSON.stringify(sec1))
await page.click('#settings-nav button[data-sec="diagnostics"]')
await wait(300)
const sec2 = await page.evaluate(() => ({
  panes: [...document.querySelectorAll('.settings-pane')].filter((p) => !p.hidden).map((p) => p.dataset.sec),
  rows: document.querySelectorAll('#diag-list .kv').length,
  text: document.getElementById('diag-list').textContent
}))
check('「诊断」分节列出核心版本 / 契约 / 运行时', sec2.panes[0] === 'diagnostics' && sec2.rows >= 6 && /0\.21\.3/.test(sec2.text), JSON.stringify(sec2).slice(0, 200))
await page.click('#settings-nav button[data-sec="appearance"]')
await wait(200)
const sec3 = await page.evaluate(() => ({
  panes: [...document.querySelectorAll('.settings-pane')].filter((p) => !p.hidden).map((p) => p.dataset.sec),
  segs: document.querySelectorAll('#theme-seg button').length
}))
check('「外观」分节有三个主题选项', sec3.panes[0] === 'appearance' && sec3.segs === 3, JSON.stringify(sec3))
await page.evaluate(() => document.getElementById('btn-close-settings-x').click())
await wait(200)

// 设置弹层的几何：滚到最后一个分节时，底部「完成」栏不能被内容压住/裁掉
await page.click('#btn-settings')
await wait(300)
await page.click('#settings-nav button[data-sec="advanced"]')
await wait(250)
const geo = await page.evaluate(() => {
  const foot = document.querySelector('.settings-foot').getBoundingClientRect()
  const panes = document.querySelector('.settings-panes').getBoundingClientRect()
  const card = document.querySelector('.settings-card').getBoundingClientRect()
  const last = document.querySelector('.settings-panes section:not([hidden]) :last-child').getBoundingClientRect()
  return { footTop: foot.top, panesBottom: panes.bottom, cardBottom: card.bottom, lastBottom: last.bottom }
})
check(
  '设置弹层不裁内容：底部「完成」栏在滚动区之下、卡片之内',
  geo.footTop >= geo.panesBottom - 1 && geo.footTop <= geo.cardBottom + 1,
  JSON.stringify(geo)
)
await page.evaluate(() => document.getElementById('btn-close-settings-x').click())
await wait(150)

// IPC 返回值是 {ok,data}，忘了拆包就会显示 undefined（曾把「核心就绪」判成没就绪）
const header = await page.$eval('#core-state', (el) => el.textContent)
check('顶部核心状态有真值（不是 undefined）', /ready/.test(header) && !/undefined/.test(header), `“${header}”`)
const diag = await page.$eval('#diag-list', (el) => el.textContent)
check('诊断面板有真值（不是 undefined）', diag.length > 20 && !/undefined/.test(diag), `“${diag.slice(0, 60)}…”`)

// 打开设置 → 关闭的四个入口
await page.click('#btn-settings')
await wait(300)
check('点「设置」能打开', (await display('#settings')) === 'flex', `display=${await display('#settings')}`)
const provOpts = await page.$$eval('#set-provider option', (o) => o.map((x) => x.textContent))
check('设置里服务商下拉框有内容且只列可填 Key 的', provOpts.length === 1 && provOpts[0].includes('DeepSeek'), provOpts.join(' | '))
const provVals = await page.$$eval('#set-provider option', (o) => o.map((x) => x.value))
check('虚拟/内置服务商（moa、opencode-free）不出现在可填 Key 的列表里', !provVals.includes('moa') && !provVals.includes('opencode-free'), provVals.join(' | '))
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
