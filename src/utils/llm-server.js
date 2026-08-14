/**
 * LLM 服务器识别工具
 *
 * 用于判断一个 `--api-base` 是否是「自建本地 LLM 服务」。
 * 自建服务（Ollama / llama.cpp / vLLM 等）通常运行在 localhost 或内网，
 * 且默认【不需要 apiKey】（认证是可选配置）。
 *
 * 用途：当 apiBase 指向自建服务时，允许缺省 apiKey 运行，
 *      并将旧的 `Authorization: Bearer undefined` 替换为不附带该头。
 *      这解决了公共项目接入 Ollama / llama.cpp / vLLM 时被强制要求
 *      假 apiKey 的问题。
 */

// RFC1918 私有段 + 回环
const PRIVATE_PATTERNS = [
  /^127\./,        // 127.0.0.0/8 回环
  /^10\./,         // 10.0.0.0/8
  /^192\.168\./,   // 192.168.0.0/16
  /^172\.(1[6-9]|2\d|3[01])\./, // 172.16.0.0/12
  /^169\.254\./,   // 链路本地
  /^::1$/,         // IPv6 回环
  /^fc[0-9a-f]{2}:/i, // IPv6 ULA fc00::/7
  /^fe[89ab][0-9a-f]:/i, // IPv6 link-local fe80::/10
]

// 明确视为「本地自建」的主机名关键词
const LOCAL_HOSTNAME_KEYWORDS = [
  'localhost',
  '127.0.0.1',
  '::1',
  '.local',
  '.lan',
  '.localdomain',
]

let cachedHost = null

/**
 * 从 URL 中提取 host（含端口），便于可读性判断
 */
function parseUrl(apiBase) {
  try {
    return new URL(apiBase)
  } catch {
    // 非标准 URL（可能缺 scheme），尝试补 http:// 再解析
    try {
      return new URL(apiBase.startsWith('http') ? apiBase : `http://${apiBase}`)
    } catch {
      return null
    }
  }
}

/**
 * 判断主机是否为「本地/内网/回环」地址
 * @param {string} hostname - 无端口的主机名或 IP
 */
export function isLocalHostname(hostname) {
  if (!hostname) return false
  const h = hostname.toLowerCase()

  // 主机名关键词
  for (const kw of LOCAL_HOSTNAME_KEYWORDS) {
    if (kw.startsWith('.') ? h.endsWith(kw) : (h === kw || h.startsWith(kw + '.'))) {
      return true
    }
  }

  // IPv4 / IPv6 私有段
  for (const re of PRIVATE_PATTERNS) {
    if (re.test(h)) return true
  }

  return false
}

/**
 * 判断一个 apiBase 是否指向「自建本地 LLM 服务」（无需强制 apiKey）
 * @param {string} apiBase - 如 http://127.0.0.1:11434/v1
 */
export function isLocalLlmServer(apiBase) {
  if (!apiBase) return false
  const url = parseUrl(apiBase)
  if (!url || !url.hostname) return false
  return isLocalHostname(url.hostname)
}

/**
 * 计算请求应携带的 Authorization 头。
 * - 若提供了 apiKey → 正常 Bearer
 * - 若未提供 apiKey 且目标是【自建本地服务】 → 不附带该头（返回 null/undefined）
 * - 若未提供 apiKey 且目标是【云端服务】 → 返回 null（由上层决定是否报错）
 * @param {string} apiBase
 * @param {string} apiKey
 * @returns {{ Authorization: string } | undefined} 返回 undefined 表示不附带 Authorization 头
 */
export function buildAuthHeaders(apiBase, apiKey) {
  if (apiKey) {
    return { 'Authorization': `Bearer ${apiKey}` }
  }
  // 无 key：本地自建服务返回空对象（不带 Authorization），云端返回 undefined（保持不变，交由上层判断）
  if (isLocalLlmServer(apiBase)) {
    return {}
  }
  return undefined
}
