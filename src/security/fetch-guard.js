/**
 * Fetch 安全管道 — 协议白名单 + 连接级 SSRF 防护 + 重定向逐跳校验 + 大小/超时/SSL
 *
 * 移植自 openclaw safe-jina-fetch 设计（DESIGN.md §4），零依赖，仅内置模块。
 *
 * 设计原则：直连优先、兜底不扰。
 *  - 直连能拿到的，不多花一跳；
 *  - 直连被拦（非 ok / 网络错误 / 超时）才由调用方走 Jina Reader 兜底（见 web-fetch.js）。
 *
 * 相比项目原 ssrf-guard.js 的增强：
 *  - 连接级校验：给 http/https.request 注入 lookup 钩子，在 TCP 连接建立时对
 *    全部解析地址逐一校验（防 DNS rebinding 的 TOCTOU 竞态）；
 *  - 重定向逐跳校验：默认最多 5 跳，每一跳重新走完整协议/SSRF/域名校验。
 */
import { lookup as dnsLookup } from 'dns'
import http from 'http'
import https from 'https'
import { isIP } from 'net'
import { isBlockedAddress } from './ssrf-guard.js'

/** 协议白名单 — 仅 http/https，file/ftp/data 等一律拒绝 */
const ALLOWED_PROTOCOLS = ['http:', 'https:']

/** 域名后缀黑名单 */
const BLOCKED_HOSTNAME_SUFFIXES = ['.local', '.internal', '.localdomain', '.localhost', '.home', '.lan']

/** 已知 SSRF 目标主机名（精确匹配，兜底） */
const BLOCKED_HOSTNAMES = [
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata.google.internal',
  'metadata.internal',
  'instance-data',
]

export const DEFAULT_FETCH_OPTIONS = {
  maxBytes: 10 * 1024 * 1024, // 响应大小上限 10MB
  timeoutMs: 30000,            // 超时 30s
  maxRedirects: 5,             // 重定向最多 5 跳
}

/**
 * 校验 URL 的协议是否在白名单内
 * @param {string} protocol — 如 'https:'
 * @returns {boolean}
 */
export function isAllowedProtocol(protocol) {
  return ALLOWED_PROTOCOLS.includes(protocol)
}

/**
 * 校验主机名是否在内网/SSRF 黑名单
 * @param {string} hostname
 * @returns {{blocked: boolean, reason?: string}}
 */
export function checkHostnameBlocked(hostname) {
  const lower = (hostname || '').toLowerCase()
  if (!lower) return { blocked: true, reason: '空主机名' }
  if (BLOCKED_HOSTNAMES.includes(lower)) {
    return { blocked: true, reason: `主机名 ${hostname} 为已知 SSRF 目标` }
  }
  for (const suffix of BLOCKED_HOSTNAME_SUFFIXES) {
    if (lower.endsWith(suffix)) {
      return { blocked: true, reason: `主机名 ${hostname} 为内网域名（后缀 ${suffix}）` }
    }
  }
  return { blocked: false }
}

/**
 * 校验单个 IP 地址是否安全（连接级，供 lookup 钩子逐地址调用）
 * @param {string} address
 * @returns {{blocked: boolean, reason?: string}}
 */
export function checkAddressBlocked(address) {
  if (isBlockedAddress(address)) {
    return { blocked: true, reason: `地址 ${address} 在私有/保留范围内，可能为 SSRF 目标` }
  }
  return { blocked: false }
}

/**
 * 安全 DNS lookup — 连接时逐地址校验（防 DNS rebinding）
 *
 * 兼容 Node 两种签名：
 *   - options.all = true  → (err, addresses[])
 *   - 否则                → (err, address, family)
 * 若任一解析地址命中私有/保留网段，立即报错阻断连接（而非放行让上层再查）。
 */
export function safeLookup(hostname, options, callback) {
  const all = !!(options && options.all)

  dnsLookup(hostname, { all: true }, (err, addresses) => {
    if (err) {
      // DNS 解析失败 — 交由上层处理（通常导致请求失败）
      if (typeof callback === 'function') {
        if (all) callback(err, [])
        else callback(err, undefined, undefined)
      }
      return
    }

    const list = Array.isArray(addresses) ? addresses : [{ address, family: 4 }]

    // 逐地址校验 — 任一命中即阻断（拒绝整条连接，防止 rebinding 切到私有地址）
    for (const a of list) {
      const addr = typeof a === 'string' ? a : a.address
      const { blocked, reason } = checkAddressBlocked(addr)
      if (blocked) {
        const e = new Error(`SSRF blocked: ${reason}`)
        e.code = 'SSRF_BLOCKED'
        if (typeof callback === 'function') {
          if (all) callback(e, [])
          else callback(e, undefined, undefined)
        }
        return
      }
    }

    // 全部安全 — 返回解析结果（保持签名兼容）
    if (typeof callback === 'function') {
      if (all) {
        callback(null, list)
      } else {
        const first = list[0]
        callback(null, typeof first === 'string' ? first : first.address, typeof first === 'string' ? 4 : first.family)
      }
    }
  })
}

/**
 * 构造带连接级 SSRF 防护的 http/https 客户端
 * 通过注入 lookup 钩子，在 TCP 连接建立时对全部解析地址逐一校验。
 * @returns {{http: import('http').Agent, https: import('https').Agent}}
 */
export function createSafeAgents() {
  const agentOptions = { lookup: safeLookup, keepAlive: false }
  return {
    http: new http.Agent(agentOptions),
    https: new https.Agent(agentOptions),
  }
}

/**
 * 解析并校验一个 URL（协议白名单 + 主机名黑名单）
 * @param {string} url
 * @returns {{ok: true, url: URL} | {ok: false, reason: string}}
 */
export function parseAndValidateUrl(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, reason: `无效的 URL: ${url}` }
  }

  if (!isAllowedProtocol(parsed.protocol)) {
    return { ok: false, reason: `不支持的协议：${parsed.protocol}（仅允许 http/https）` }
  }

  const hostBlock = checkHostnameBlocked(parsed.hostname)
  if (hostBlock.blocked) {
    return { ok: false, reason: hostBlock.reason }
  }

  // IP 字面量：直接校验是否在私有/保留网段（Node 对 IP 字面量不走 DNS lookup，
  // 连接级 lookup 钩子不会触发，必须在发起请求前显式校验，否则 SSRF 被绕过）
  if (isIP(parsed.hostname)) {
    const addrBlock = checkAddressBlocked(parsed.hostname)
    if (addrBlock.blocked) {
      return { ok: false, reason: addrBlock.reason }
    }
  }

  return { ok: true, url: parsed }
}

/**
 * 读取响应体，限制大小（超限截断并在 warnings 标记）
 * @param {import('http').IncomingMessage} res
 * @param {number} maxBytes
 * @returns {Promise<{body: string, truncated: boolean}>}
 */
export async function readBodyLimited(res, maxBytes) {
  const chunks = []
  let total = 0
  let truncated = false
  for await (const chunk of res) {
    total += chunk.length
    if (total > maxBytes) {
      truncated = true
      chunks.push(chunk.slice(0, maxBytes - (total - chunk.length)))
      break
    }
    chunks.push(chunk)
  }
  return { body: Buffer.concat(chunks).toString('utf-8'), truncated }
}

/**
 * 带安全管道的 HTTP 抓取函数（单次请求，含协议/SSRF/大小/超时/SSL）
 *
 * 注意：本函数只发一次请求，不自动跟随重定向——重定向由 safeFetchWithRedirects
 * 逐跳处理（每跳重新校验）。返回 { status, headers, body, truncated, finalUrl }。
 *
 * @param {string} url
 * @param {object} [options]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.maxBytes]
 * @param {object} [options.headers]
 * @returns {Promise<{ok: boolean, status: number, headers: object, body: string, truncated: boolean, finalUrl: string, error?: string}>}
 */
export function safeRequest(url, options = {}) {
  const { timeoutMs = DEFAULT_FETCH_OPTIONS.timeoutMs, maxBytes = DEFAULT_FETCH_OPTIONS.maxBytes, headers = {} } = options

  const validated = parseAndValidateUrl(url)
  if (!validated.ok) {
    return Promise.resolve({ ok: false, status: 0, headers: {}, body: '', truncated: false, finalUrl: url, error: validated.reason })
  }
  const parsed = validated.url

  return new Promise((resolve) => {
    const client = parsed.protocol === 'https:' ? https : http
    const req = client.request(
      parsed,
      {
        method: 'GET',
        headers: { 'User-Agent': 'cc-node', 'Accept': 'text/html,application/json,text/plain,*/*', ...headers },
        // 连接级 SSRF 防护（TCP 连接时逐地址校验，防 DNS rebinding）
        lookup: safeLookup,
        // 强制校验证书，不提供跳过选项
        rejectUnauthorized: true,
      },
      async (res) => {
        // 读响应体（限制大小）
        try {
          const { body, truncated } = await readBodyLimited(res, maxBytes)
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode || 0,
            headers: res.headers || {},
            body,
            truncated,
            finalUrl: res.responseUrl || parsed.href,
          })
        } catch (err) {
          resolve({ ok: false, status: res.statusCode || 0, headers: res.headers || {}, body: '', truncated: false, finalUrl: parsed.href, error: err.message })
        }
      }
    )

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('请求超时'))
    })

    req.on('error', (err) => {
      resolve({ ok: false, status: 0, headers: {}, body: '', truncated: false, finalUrl: parsed.href, error: err.message })
    })

    req.end()
  })
}

/**
 * 带重定向逐跳校验的安全抓取
 * 每一跳都重新执行协议/SSRF/域名校验，防止 302 → 内网 的重定向绕过。
 *
 * @param {string} url
 * @param {object} [options]
 * @param {number} [options.maxRedirects] — 最大跳数（默认 5）
 * @returns {Promise<{ok: boolean, status: number, headers: object, body: string, truncated: boolean, finalUrl: string, redirects: string[], error?: string, warning?: string}>}
 */
export async function safeFetchWithRedirects(url, options = {}) {
  const { maxRedirects = DEFAULT_FETCH_OPTIONS.maxRedirects, ...reqOptions } = options
  let currentUrl = url
  const redirects = []

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const result = await safeRequest(currentUrl, reqOptions)

    // 3xx 重定向 — 逐跳校验下一目标
    if (result.status >= 300 && result.status < 400 && result.headers.location) {
      // 校验下一跳 URL（相对路径需拼接到当前 URL）
      let nextUrl
      try {
        nextUrl = new URL(result.headers.location, currentUrl).href
      } catch {
        return { ...result, redirects, error: `无效的重定向目标: ${result.headers.location}` }
      }

      // 重定向目标重新走协议/SSRF 校验（防止跳到内网）
      const v = parseAndValidateUrl(nextUrl)
      if (!v.ok) {
        return { ...result, redirects, error: `重定向目标被安全策略阻止: ${v.reason}` }
      }

      redirects.push(`${result.status} → ${nextUrl}`)
      currentUrl = nextUrl
      continue
    }

    // 非重定向 — 返回最终结果（含重定向链）
    return { ...result, redirects, finalUrl: currentUrl }
  }

  // 超过最大跳数
  return { ok: false, status: 0, headers: {}, body: '', truncated: false, finalUrl: currentUrl, redirects, error: `重定向次数超过上限 (${maxRedirects})` }
}
