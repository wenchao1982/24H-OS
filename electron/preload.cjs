/**
 * 预加载：向渲染进程暴露最小、明确的 API 面。
 *
 * ⚠️ 必须是 **CommonJS**，所以文件后缀是 `.cjs`：
 * Electron 的 preload 脚本按 CJS 加载（`sandbox: true` 下更不允许 ESM），而本仓库
 * package.json 是 `"type": "module"` —— 如果把 preload 写成 ESM 的 `preload.js`，
 * 加载时直接抛错、`window.hermes` 不会被注入，界面就会停在静态 HTML 上（启动中…），
 * 而控制台/主进程都不一定报得明显。踩过一次。
 *
 * 所有调用统一返回 {ok, data} | {ok, error}，渲染进程不用 try/catch。
 */
const { contextBridge, ipcRenderer } = require('electron')

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
  sessionStatus: invoke('session:status'),
  sessionDelete: invoke('session:delete'),
  sessionClose: invoke('session:close'),
  sessionCwdSet: invoke('session:cwdSet'),
  sessionTitle: invoke('session:title'),
  sessionsSearch: invoke('sessions:search'),
  send: invoke('chat:send'),

  // 文件面板
  fsList: invoke('fs:list'),
  fsRead: invoke('fs:read'),

  // 模型与配置
  modelsList: invoke('models:list'),
  modelSet: invoke('model:set'),
  modelSaveKey: invoke('model:saveKey'),
  customEndpoints: invoke('providers:customEndpoints'),
  customEndpointUpsert: invoke('providers:customEndpointUpsert'),
  configGet: invoke('config:get'),
  configSet: invoke('config:set'),
  capabilities: invoke('gateway:capabilities'),

  openExternal: invoke('open:external'),
  pickDirectory: invoke('dialog:pickDir'),

  // 壳自己的 UI 偏好（主题…），存在 userData 里
  prefsGet: invoke('ui:prefs:get'),
  prefsSet: invoke('ui:prefs:set'),

  // 事件流
  onReady: on('runtime:ready'),
  onRuntimeError: on('runtime:error'),
  onRuntimeExit: on('runtime:exit'),
  onLog: on('runtime:log'),
  onState: on('runtime:state'),
  onGatewayStatus: on('gateway:status'),
  onEvent: on('gateway:event')
})
