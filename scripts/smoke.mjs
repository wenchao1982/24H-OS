#!/usr/bin/env node
/**
 * 无界面冒烟测试：走壳真正使用的两个模块（runtime.js + gateway.js），
 * 覆盖「启动核心 → 取 token → WS 连接 → 会话 → 发消息 → 事件流 → 关闭」。
 *
 *   HERMES_RUNTIME_PYTHON=/path/to/venv/bin/python npm run smoke
 *
 * 说明：本机没有图形环境，所以 GUI 部分测不了；这个脚本保证"壳与核心的协议层"是通的。
 * 没有配置模型 key 时，prompt.submit 会以 message.complete(status=error) 结束 —— 这属预期，
 * 说明通路正常（能收到完整事件序列）。
 */
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Gateway } from '../electron/gateway.js'
import { Runtime } from '../electron/runtime.js'

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const runtime = new Runtime({
  appRoot: path.resolve(import.meta.dirname, '..'),
  hermesHome: process.env.HERMES_HOME,
  onLog: () => {}
})

let gateway = null
try {
  const port = await runtime.start()
  check('核心启动并就绪（解析 HERMES_BACKEND_READY）', Number.isInteger(port), `port=${port}`)

  const health = await runtime.health()
  check('健康检查 /api/health', health?.ok === true, `version=${health?.version} auth_required=${health?.auth_required}`)

  const token = await runtime.sessionToken()
  check('取到会话 token（/ 的内联注入）', typeof token === 'string' && token.length > 0, token ? `${token.slice(0, 8)}…` : '无')

  gateway = new Gateway({ baseUrl: runtime.baseUrl, token, log: () => {} })
  const events = []
  gateway.on('event', (e) => events.push(e))
  await gateway.connect()
  check('WS /api/ws 已连接', true)

  const caps = await gateway.call('gateway.capabilities')
  check('gateway.capabilities', typeof caps === 'object', JSON.stringify(caps).slice(0, 60))

  const created = await gateway.call('session.create', { cols: 100, title: 'smoke' })
  const sid = created?.session_id
  check('session.create 返回 session_id', Boolean(sid), `sid=${sid} model=${created?.info?.model}`)

  const list = await gateway.call('session.list', {})
  check('session.list', Array.isArray(list?.sessions), `${list?.sessions?.length ?? 0} 个会话`)

  const hist = await gateway.call('session.history', { session_id: sid })
  check('session.history 结构 {count,messages}', Array.isArray(hist?.messages), `count=${hist?.count}`)

  const models = await gateway.call('model.options')
  check('model.options 返回服务商列表', Array.isArray(models?.providers), `${models?.providers?.length ?? 0} 个服务商`)

  // 发一条消息：观察完整事件序列。未配模型时，0.21.0 以 message.complete(status=error) 收尾，
  // 0.21.3 直接发 error 帧 —— 对壳而言"turn 结束"的信号是两者之一（UI 两条都处理）。
  const submit = await gateway.call('prompt.submit', { session_id: sid, text: 'smoke test' })
  check('prompt.submit 被接受', submit?.status === 'streaming', JSON.stringify(submit))
  await sleep(6000)

  const types = events.map((e) => e.type)
  const closed = types.includes('message.complete') || types.includes('error')
  check('收到 turn 结束信号（message.complete 或 error）', closed, types.join(', ').slice(0, 140))

  const readable = events.some(
    (e) =>
      (e.type === 'error' && typeof e.payload?.message === 'string' && e.payload.message.length > 0) ||
      (e.type === 'message.complete' && typeof e.payload?.text === 'string' && e.payload.text.length > 0)
  )
  check('未配模型时给出可读错误（而非静默失败）', readable)

  // interrupt 走的是"需要 provider"的路径：未配置模型时核心回 5032 —— 这属于环境未就绪，
  // 不是参数错误（能拿到带码的答复本身说明 RPC 形状被接受）。配置好模型后这里会真正成功。
  const NO_PROVIDER = 5032
  const interrupted = await gateway
    .call('session.interrupt', { session_id: sid })
    .then(() => ({ ok: true }))
    .catch((e) => ({ ok: false, code: e.code, message: e.message }))
  check(
    'session.interrupt 参数被接受（5032 = 本机未配模型，跳过）',
    interrupted.ok || interrupted.code === NO_PROVIDER,
    interrupted.ok ? 'done' : `code=${interrupted.code}`
  )

  // 恢复路径：运行时不再持有该 id 时，核心要求客户端用 stored id 走 session.resume
  const bogus = await gateway
    .call('session.history', { session_id: 'deadbeef-not-in-memory' })
    .then(() => ({ ok: true }))
    .catch((e) => ({ ok: false, code: e.code }))
  check('未知 session_id 返回 4001（可识别的错误码）', bogus.ok === false && bogus.code === 4001, `code=${bogus.code}`)

  const stored = (await gateway.call('session.list', {}))?.sessions?.[0]?.id
  if (stored) {
    const resumed = await gateway
      .call('session.resume', { session_id: stored, cols: 100 })
      .then((r) => ({ ok: true, id: r?.session_id }))
      .catch((e) => ({ ok: false, message: e.message }))
    check('session.resume 用 stored id 恢复运行时会话', resumed.ok && Boolean(resumed.id), resumed.id ?? resumed.message)
    if (resumed.id) {
      const after = await gateway
        .call('session.interrupt', { session_id: resumed.id })
        .then(() => ({ ok: true }))
        .catch((e) => ({ ok: false, code: e.code, message: e.message }))
      check(
        '恢复后 interrupt 参数被接受',
        after.ok || after.code === NO_PROVIDER,
        after.ok ? 'done' : `code=${after.code}`
      )
    }
  }
} catch (err) {
  check('异常中断', false, err.message)
} finally {
  gateway?.close()
  await runtime.stop()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length) {
  console.error('失败项：', failed.map((f) => f.name).join('、'))
  process.exitCode = 1
}
