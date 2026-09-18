/**
 * 可配置的服务商白名单：从硬编码改为配置文件驱动。
 *
 * 优先级（从高到低）：
 *   1. 环境变量 HERMES_PROVIDER_ALLOWLIST（逗号分隔）
 *   2. 壳配置文件 userData/provider-allowlist.json
 *   3. 默认值 ['deepseek']
 *
 * 文件格式（userData/provider-allowlist.json）：
 * {
 *   "providers": ["deepseek", "alibaba", "moonshot"],
 *   "modelFallback": {
 *     "deepseek": ["deepseek-v4-pro", "deepseek-flash"],
 *     "alibaba": ["qwen-plus", "qwen-turbo"]
 *   }
 * }
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

/** 默认白名单 */
const DEFAULT_ALLOWLIST = ['deepseek']

/** 默认模型兜底（核心未返回模型列表时给用户看） */
const DEFAULT_MODEL_FALLBACK = {
  deepseek: ['deepseek-v4-pro', 'deepseek-flash']
}

/**
 * 加载服务商白名单配置。
 * @param {{ userDataDir?: string }} opts
 * @returns {{ providers: string[], modelFallback: Record<string, string[]> }}
 */
export function loadProviderConfig(opts = {}) {
  // 1. 环境变量优先
  const envList = process.env.HERMES_PROVIDER_ALLOWLIST
  if (envList) {
    const providers = envList.split(',').map(s => s.trim()).filter(Boolean)
    return { providers, modelFallback: DEFAULT_MODEL_FALLBACK }
  }

  // 2. 配置文件
  if (opts.userDataDir) {
    const configPath = path.join(opts.userDataDir, 'provider-allowlist.json')
    try {
      if (existsSync(configPath)) {
        const raw = JSON.parse(readFileSync(configPath, 'utf8'))
        const providers = Array.isArray(raw.providers) ? raw.providers : DEFAULT_ALLOWLIST
        const modelFallback = raw.modelFallback && typeof raw.modelFallback === 'object'
          ? raw.modelFallback
          : DEFAULT_MODEL_FALLBACK
        return { providers, modelFallback }
      }
    } catch {
      // 配置文件损坏，用默认值
    }
  }

  // 3. 默认值
  return { providers: DEFAULT_ALLOWLIST, modelFallback: DEFAULT_MODEL_FALLBACK }
}

/**
 * 判断服务商是否在白名单中。
 * 匹配 slug 或 name（核心不同版本对同一服务商的 name 可能不同）。
 */
export function providerMatchesAllowlist(provider, allowlist) {
  const slug = String(provider.slug ?? '').toLowerCase()
  const name = String(provider.name ?? '').toLowerCase()
  return allowlist.some(k => {
    const key = k.toLowerCase()
    return slug === key || name.includes(key)
  })
}

/**
 * 只有 api_key 类服务商能接受 save_key。
 */
export function canHoldApiKey(provider) {
  return provider.auth_type === 'api_key'
}

/**
 * 过滤出可填 Key 的服务商（按白名单收窄）。
 */
export function filterKeyProviders(providers, allowlist) {
  const keyable = providers.filter(canHoldApiKey)
  const allowed = keyable.filter(p => providerMatchesAllowlist(p, allowlist))
  return {
    keyProviders: allowed.length ? allowed : keyable,
    narrowed: allowed.length > 0 && allowed.length < keyable.length
  }
}
