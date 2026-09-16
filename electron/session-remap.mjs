/**
 * 会话 id 的"重映射"：核心有两套 id —— 列表里的 **stored id**（磁盘会话）与运行时的 session_id。
 * 运行时把会话回收（LRU/重启）后，用 stored id 调任何方法都会得到 4001 session not found，
 * 正确做法是 `session.resume` 把它装回运行时，**然后用 resume 返回的新 id 重试**。
 *
 * 为什么单独一个文件：这一段逻辑既要在壳里用（gwCall），又要能被冒烟测试直接打到真核心上验证
 * （曾经只写"用旧 id 重试"，等于白重试 —— 用户实机上表现为"读取历史失败: session not found"）。
 */
export async function callWithSessionRemap(call, method, payload = {}, { onRemap } = {}) {
  try {
    return await call(method, payload ?? {})
  } catch (err) {
    const sid = payload?.session_id
    const recoverable = err?.code === 4001 && sid && method !== 'session.resume' && method !== 'session.list'
    if (!recoverable) throw err
    const resumed = await call('session.resume', { session_id: sid, cols: 100 })
    const newId = resumed?.session_id ?? resumed?.id ?? sid
    if (onRemap) onRemap(sid, newId)
    // 关键：重试要用**新** id，否则还是 4001
    return call(method, { ...payload, session_id: newId })
  }
}
