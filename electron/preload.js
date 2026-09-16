/**
 * 预加载脚本：向渲染进程暴露一个最小、明确的 API 面（contextIsolation 打开，
 * 渲染进程拿不到 Node，只能调这些方法）。
 */
import { contextBridge, ipcRenderer } from 'electron'

const on = (channel) => (cb) => {
  const handler = (_event, payload) => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.off(channel, handler)
}

contextBridge.exposeInMainWorld('hermes', {
  /** 当前状态快照（含最近的核心日志） */
  state: () => ipcRenderer.invoke('runtime:state'),
  /** 健康检查 + /api/status（需要核心就绪） */
  info: () => ipcRenderer.invoke('runtime:info'),
  /** 重启核心 */
  restart: () => ipcRenderer.invoke('runtime:restart'),
  /** 用系统浏览器打开（例如核心的 /docs） */
  openExternal: (url) => ipcRenderer.invoke('open:external', url),
  /** 事件订阅；返回取消订阅函数 */
  onReady: on('runtime:ready'),
  onError: on('runtime:error'),
  onExit: on('runtime:exit'),
  onLog: on('runtime:log'),
  onState: on('runtime:state')
})
