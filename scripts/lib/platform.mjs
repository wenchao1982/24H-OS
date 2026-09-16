/**
 * 平台标识：全仓统一的一套（资产命名、平台目录、下载器的护栏都用它）。
 *
 * 为什么单独抽出来：PowerShell 构建脚本里写的 manifest.platform 是 "win32"，
 * 而资产/目录需要 "win-x64" —— 两边各写一套就会出现"产出的目录名和下载器找的目录名不一致"
 * （Windows 上就会表现为"检查更新成功、下载时 404"）。所以只留一个实现 + 一个宽容的比较函数。
 */
export function platformKey(platformName = process.platform, arch = process.arch) {
  if (platformName === 'win32') return 'win-x64'
  if (platformName === 'darwin') return `darwin-${arch}`
  return `${platformName}-${arch}`
}

/** 把历史/别处的写法（win32、mac-arm64…）归一化 */
export function normalizePlatform(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/^win32/, 'win')
    .replace(/^windows/, 'win')
    .replace(/^mac(os)?/, 'darwin')
}

/**
 * 两个平台标识是否"兼容"。规则：
 *   · 操作系统部分必须一致（win / linux / darwin）——不同就拒绝（装上也跑不起来）
 *   · 两边都写了架构时，架构也必须一致（x64 vs arm64 的 Python 二进制不通用）
 */
export function platformCompatible(a, b) {
  const na = normalizePlatform(a)
  const nb = normalizePlatform(b)
  if (!na || !nb) return true
  const [osA, archA] = na.split('-')
  const [osB, archB] = nb.split('-')
  if (osA !== osB) return false
  const archOf = (x) => (x === 'amd64' ? 'x64' : x)
  if (archA && archB && archOf(archA) !== archOf(archB)) return false
  return true
}
