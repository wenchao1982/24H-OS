/**
 * HermesTransport 抽象层：为将来"同一套 UI 能当网页版/远程版"留口。
 *
 * 当前实现：IPC（Electron preload → 主进程 → 核心）
 * 将来可替换为：HTTP/WS 直连核心（Studio 已证明可行）
 *
 * 使用方式（渲染层）：
 *   import { createTransport } from './transport.js'
 *   const hermes = createTransport('ipc')  // 或 'http'（将来）
 *   await hermes.sessionsList({})
 *
 * 契约：
 *   所有方法返回 Promise<{ ok: boolean, data?: any, error?: string, code?: number }>
 */
export class HermesTransport {
  /** @type {'ipc' | 'http' | 'ws'} */
  type

  constructor(type) {
    this.type = type
  }

  /** 创建一个代理方法：调用 transport 的 call(channel, payload) */
  _proxy(channel) {
    return (payload) => this.call(channel, payload)
  }

  /** 核心调用（由子类实现） */
  async call(_channel, _payload) {
    throw new Error('Not implemented')
  }

  /** 事件订阅（由子类实现） */
  on(_event, _handler) {
    throw new Error('Not implemented')
  }

  /** 取消订阅（由子类实现） */
  off(_event, _handler) {
    throw new Error('Not implemented')
  }

  // ── 便捷方法（按功能分组）───────────────────────────────────────────────

  // 运行时
  get state() { return this._proxy('runtime:state') }
  get restart() { return this._proxy('runtime:restart') }
  get health() { return this._proxy('runtime:health') }
  get status() { return this._proxy('runtime:status') }

  // 会话
  get sessionsList() { return this._proxy('sessions:list') }
  get sessionsCreate() { return this._proxy('sessions:create') }
  get sessionActivate() { return this._proxy('session:activate') }
  get sessionResume() { return this._proxy('session:resume') }
  get sessionHistory() { return this._proxy('session:history') }
  get sessionInterrupt() { return this._proxy('session:interrupt') }
  get sessionStatus() { return this._proxy('session:status') }
  get sessionDelete() { return this._proxy('session:delete') }
  get sessionClose() { return this._proxy('session:close') }
  get sessionCwdSet() { return this._proxy('session:cwdSet') }
  get sessionTitle() { return this._proxy('session:title') }
  get sessionsSearch() { return this._proxy('sessions:search') }
  get send() { return this._proxy('chat:send') }

  // 文件
  get fsList() { return this._proxy('fs:list') }
  get fsRead() { return this._proxy('fs:read') }

  // 模型与配置
  get modelsList() { return this._proxy('models:list') }
  get modelSet() { return this._proxy('model:set') }
  get modelSaveKey() { return this._proxy('model:saveKey') }
  get customEndpoints() { return this._proxy('providers:customEndpoints') }
  get customEndpointUpsert() { return this._proxy('providers:customEndpointUpsert') }
  get configGet() { return this._proxy('config:get') }
  get configSet() { return this._proxy('config:set') }
  get capabilities() { return this._proxy('gateway:capabilities') }

  // 壳偏好
  get prefsGet() { return this._proxy('ui:prefs:get') }
  get prefsSet() { return this._proxy('ui:prefs:set') }

  // 向导
  get wizardState() { return this._proxy('wizard:state') }
  get wizardSelfCheck() { return this._proxy('wizard:selfcheck') }
  get wizardTestConnection() { return this._proxy('wizard:testConnection') }
  get wizardComplete() { return this._proxy('wizard:complete') }
  get wizardReset() { return this._proxy('wizard:reset') }

  // 草稿
  get draftsGet() { return this._proxy('drafts:get') }
  get draftsSet() { return this._proxy('drafts:set') }
  get draftsClear() { return this._proxy('drafts:clear') }
  get draftsFlush() { return this._proxy('drafts:flush') }

  // 关窗
  get closeGuardSet() { return this._proxy('app:closeGuardSet') }
  get closeDecision() { return this._proxy('app:closeDecision') }

  // 技能 / 任务 / 用量
  get skillsList() { return this._proxy('skills:list') }
  get cronList() { return this._proxy('cron:list') }
  get insights() { return this._proxy('insights:get') }
  get usageBars() { return this._proxy('usage:bars') }
  get runtimeCheck() { return this._proxy('setup:runtimeCheck') }
  get sessionUsage() { return this._proxy('session:usage') }
  get sessionUndo() { return this._proxy('session:undo') }
  get sessionBranch() { return this._proxy('session:branch') }

  // 原生能力
  get openExternal() { return this._proxy('open:external') }
  get pickDirectory() { return this._proxy('dialog:pickDir') }
  get uiInfo() { return this._proxy('ui:info') }
  get runtimeInfo() { return this._proxy('runtime:info') }
  get runtimeList() { return this._proxy('runtime:list') }
  get runtimeActivate() { return this._proxy('runtime:activate') }
  get runtimeDist() { return this._proxy('runtime:dist') }
  get runtimeCheckUpdate() { return this._proxy('runtime:checkUpdate') }
  get runtimeInstall() { return this._proxy('runtime:install') }
  get openPath() { return this._proxy('ui:openPath') }
  get copyText() { return this._proxy('ui:copyText') }
  get saveTextFile() { return this._proxy('ui:saveText') }
  get showContextMenu() { return this._proxy('ui:contextMenu') }
  get updateCheck() { return this._proxy('ui:updateCheck') }
}

/**
 * IPC 传输实现（Electron preload 环境）。
 * 通过 contextBridge 暴露的 window.hermes 调用主进程。
 */
export class IpcTransport extends HermesTransport {
  constructor() {
    super('ipc')
  }

  async call(channel, payload) {
    return window.hermes?.[channelToMethod(channel)]?.(payload) ?? { ok: false, error: 'Transport not available' }
  }

  on(event, handler) {
    const unsub = window.hermes?.[eventToMethod(event)]?.(handler)
    return unsub ?? (() => {})
  }

  off(_event, _handler) {
    // IPC 的 off 由返回的 unsub 函数处理
  }
}

/** channel 名 → window.hermes 方法名的映射 */
function channelToMethod(channel) {
  const map = {
    'runtime:state': 'state',
    'runtime:restart': 'restart',
    'runtime:health': 'health',
    'runtime:status': 'status',
    'sessions:list': 'sessionsList',
    'sessions:create': 'sessionsCreate',
    'session:activate': 'sessionActivate',
    'session:resume': 'sessionResume',
    'session:history': 'sessionHistory',
    'session:interrupt': 'sessionInterrupt',
    'session:status': 'sessionStatus',
    'session:delete': 'sessionDelete',
    'session:close': 'sessionClose',
    'session:cwdSet': 'sessionCwdSet',
    'session:title': 'sessionTitle',
    'sessions:search': 'sessionsSearch',
    'chat:send': 'send',
    'fs:list': 'fsList',
    'fs:read': 'fsRead',
    'models:list': 'modelsList',
    'model:set': 'modelSet',
    'model:saveKey': 'modelSaveKey',
    'providers:customEndpoints': 'customEndpoints',
    'providers:customEndpointUpsert': 'customEndpointUpsert',
    'config:get': 'configGet',
    'config:set': 'configSet',
    'gateway:capabilities': 'capabilities',
    'ui:prefs:get': 'prefsGet',
    'ui:prefs:set': 'prefsSet',
    'wizard:state': 'wizardState',
    'wizard:selfcheck': 'wizardSelfCheck',
    'wizard:testConnection': 'wizardTestConnection',
    'wizard:complete': 'wizardComplete',
    'wizard:reset': 'wizardReset',
    'drafts:get': 'draftsGet',
    'drafts:set': 'draftsSet',
    'drafts:clear': 'draftsClear',
    'drafts:flush': 'draftsFlush',
    'app:closeGuardSet': 'closeGuardSet',
    'app:closeDecision': 'closeDecision',
    'skills:list': 'skillsList',
    'cron:list': 'cronList',
    'insights:get': 'insights',
    'usage:bars': 'usageBars',
    'setup:runtimeCheck': 'runtimeCheck',
    'session:usage': 'sessionUsage',
    'session:undo': 'sessionUndo',
    'session:branch': 'sessionBranch',
    'open:external': 'openExternal',
    'dialog:pickDir': 'pickDirectory',
    'ui:info': 'uiInfo',
    'runtime:info': 'runtimeInfo',
    'runtime:list': 'runtimeList',
    'runtime:activate': 'runtimeActivate',
    'runtime:dist': 'runtimeDist',
    'runtime:checkUpdate': 'runtimeCheckUpdate',
    'runtime:install': 'runtimeInstall',
    'ui:openPath': 'openPath',
    'ui:copyText': 'copyText',
    'ui:saveText': 'saveTextFile',
    'ui:contextMenu': 'showContextMenu',
    'ui:updateCheck': 'updateCheck'
  }
  return map[channel] || channel
}

/** 事件名 → window.hermes 订阅方法名的映射 */
function eventToMethod(event) {
  const map = {
    'runtime:ready': 'onReady',
    'runtime:error': 'onRuntimeError',
    'runtime:exit': 'onRuntimeExit',
    'runtime:log': 'onLog',
    'runtime:state': 'onState',
    'gateway:status': 'onGatewayStatus',
    'gateway:event': 'onEvent',
    'boot:progress': 'onBootProgress',
    'session:remapped': 'onSessionRemapped',
    'runtime:download': 'onRuntimeDownload',
    'core:reconnected': 'onCoreReconnected',
    'wizard:required': 'onWizardRequired',
    'events:overflow': 'onEventsOverflow',
    'app:close-request': 'onCloseRequest'
  }
  return map[event] || event
}

/** HTTP/WS 传输实现（将来做网页版/远程版时用）。 */
export class HttpTransport extends HermesTransport {
  constructor({ baseUrl, token }) {
    super('http')
    this.baseUrl = baseUrl
    this.token = token
  }

  async call(channel, payload) {
    // 将来实现：把 channel 映射到 HTTP/WS 调用
    throw new Error(`HttpTransport.call(${channel}) not implemented yet`)
  }

  on(_event, _handler) {
    // 将来实现：WebSocket 事件订阅
    return () => {}
  }

  off() {}
}

/**
 * 工厂方法：根据环境创建合适的 transport。
 * @param {'ipc' | 'http'} type
 * @param {{ baseUrl?: string, token?: string }} [opts]
 */
export function createTransport(type = 'ipc', opts = {}) {
  switch (type) {
    case 'ipc':
      return new IpcTransport()
    case 'http':
      return new HttpTransport(opts)
    default:
      throw new Error(`Unknown transport type: ${type}`)
  }
}
