/**
 * 预加载：只暴露这一组方法给渲染进程（contextIsolation 打开，渲染进程无 Node）。
 * 所有调用统一返回 {ok, data} | {ok, error}，渲染进程不用 try/catch。
 */
import { contextBridge, ipcRenderer } from 'electron'

const invoke = (channel) => (payload) => ipcRenderer.invoke(channel, payload)

const on = (channel) => (cb) => {
  const handler = (_event, payload) => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.off(channel, handler)
}

contextBridge.exposeInMainWorld('hermes', {
  // 运行时（核心进程）
  state: invoke('runtime:state'),
  restart: invoke('runtime:restart'),
  health: invoke('runtime:health'),
  status: invoke('runtime:status'),

  // 会话与对话（WS JSON-RPC）
  sessionsList: invoke('sessions:list'),
  sessionsCreate: invoke('sessions:create'),
  sessionActivate: invoke('session:activate'),
  sessionResume: invoke('session:resume'),
  sessionHistory: invoke('session:history'),
  sessionInterrupt: invoke('session:interrupt'),
  sessionCwdSet: invoke('session:cwdSet'),
  sessionStatus: invoke('session:status'),
  sessionTitle: invoke('session:title'),
  send: invoke('chat:send'),

  // 模型与配置
  modelsList: invoke('models:list'),
  modelSet: invoke('model:set'),
  modelSaveKey: invoke('model:saveKey'),
  configGet: invoke('config:get'),
  configSet: invoke('config:set'),
  capabilities: invoke('gateway:capabilities'),

  openExternal: invoke('open:external'),
  pickDirectory: invoke('dialog:pickDir'),

  // 事件流
  onReady: on('runtime:ready'),
  onRuntimeError: on('runtime:error'),
  onRuntimeExit: on('runtime:exit'),
  onLog: on('runtime:log'),
  onState: on('runtime:state'),
  onGatewayStatus: on('gateway:status'),
  onEvent: on('gateway:event')
})
