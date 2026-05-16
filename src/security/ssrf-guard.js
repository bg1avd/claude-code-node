/**
 * SSRF 防护 — 阻止对内网/云元数据端点的请求
 * 对应原版：src/utils/hooks/ssrfGuard.ts
 * 
 * v1.2 修复:
 * - H4: 完整检测 fe80::/10 范围（fe80:: - febf::），而非仅 fe8 前缀
 * - H3: 导出 dnsLookup 函数供 query-engine 使用自定义 DNS resolver
 */
import { lookup as dnsLookup } from 'dns'
import { isIP } from 'net'

/**
 * 检查 IPv4 地址是否在应被阻止的范围内
 */
function isBlockedV4(address) {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some(n => Number.isNaN(n))) return false
  const [a, b, c, d] = parts

  // 0.0.0.0/8 — "this" 网络
  if (a === 0) return true
  // 127.0.0.0/8 — 回环/localhost（SSRF 核心目标，必须阻止）
  if (a === 127) return true
  // 10.0.0.0/8 — 私有网络
  if (a === 10) return true
  // 100.64.0.0/10 — CGNAT (RFC 6598)
  if (a === 100 && b >= 64 && b <= 127) return true
  // 100.100.100.200 — 阿里云元数据（精确匹配）
  if (a === 100 && b === 100 && c === 100 && d === 200) return true
  // 169.254.0.0/16 — 链路本地，云元数据
  if (a === 169 && b === 254) return true
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true
  // 192.0.2.0/24 — TEST-NET-1
  if (a === 192 && b === 0 && c === 2) return true
  // 198.51.100.0/24 — TEST-NET-2
  if (a === 198 && b === 51 && c === 100) return true
  // 203.0.113.0/24 — TEST-NET-3
  if (a === 203 && b === 0 && c === 113) return true

  return false
}

/**
 * 检查 IPv6 地址是否在应被阻止的范围内
 * 
 * 修复 H4: 完整检测 fe80::/10 范围（fe80:: - febf::）
 */
function isBlockedV6(address) {
  const normalized = address.toLowerCase()

  // ::1 回环 — 阻止（SSRF 核心目标）
  if (normalized === '::1') return true
  // :: 未指定
  if (normalized === '::' || normalized === '0:0:0:0:0:0:0:0') return true

  // fc00::/7 — 唯一本地 (fc00:: - fdff::)
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true

  // fe80::/10 — 链路本地 (fe80:: - febf::)
  // 修复 H4: 使用数值比较而非前缀匹配
  const firstTwoBytes = normalized.split(':')[0]
  if (firstTwoBytes) {
    const firstByte = parseInt(firstTwoBytes, 16)
    if (!isNaN(firstByte) && firstByte >= 0xfe80 && firstByte <= 0xfebf) {
      return true
    }
  }

  // ::ffff:<IPv4> — 短格式 IPv4 映射地址
  const v4Mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (v4Mapped) {
    return isBlockedV4(v4Mapped[1])
  }

  // 0:0:0:0:0:ffff:<IPv4> — 完整格式 IPv4 映射地址
  const v4MappedFull = normalized.match(/^0:0:0:0:0:ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (v4MappedFull) {
    return isBlockedV4(v4MappedFull[1])
  }

  // 64:ff9b::<IPv4> — NAT64 映射地址 (RFC 6052)
  const nat64Match = normalized.match(/^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/)
  if (nat64Match) {
    return isBlockedV4(nat64Match[1])
  }

  return false
}

/**
 * 检查 IP 地址是否在阻止列表中
 * @param {string} address — IP 地址字符串
 * @returns {boolean} true = 应阻止
 */
export function isBlockedAddress(address) {
  const v = isIP(address)
  if (v === 4) return isBlockedV4(address)
  if (v === 6) return isBlockedV6(address)
  // 不是合法 IP 字面量 — 交给 DNS 解析路径处理
  return false
}

/**
 * 解析主机名并检查解析结果是否安全
 * @param {string} hostname — 主机名
 * @returns {Promise<{allowed: boolean, addresses: string[], reason?: string}>}
 */
export async function checkHostSafety(hostname) {
  // 如果是 IP 字面量，直接检查
  if (isIP(hostname)) {
    const blocked = isBlockedAddress(hostname)
    return {
      allowed: !blocked,
      addresses: [hostname],
      reason: blocked ? `IP ${hostname} 在私有/保留地址范围内，可能为 SSRF 目标` : undefined,
    }
  }

  // 常见 SSRF 绕过主机名黑名单
  const blockedHostnames = [
    'localhost',
    'localhost.localdomain',
    'ip6-localhost',
    'ip6-loopback',
    'metadata.google.internal', // GCP 元数据
    'metadata.internal', // AWS 元数据
    'instance-data', // CloudStack 元数据
  ]
  const lowerHost = hostname.toLowerCase()
  if (blockedHostnames.includes(lowerHost)) {
    return { allowed: false, addresses: [], reason: `主机名 ${hostname} 为已知 SSRF 目标` }
  }

  // 阻止 *.internal / *.local / *.localhost 域名模式
  if (lowerHost.endsWith('.internal') || lowerHost.endsWith('.local') || lowerHost.endsWith('.localhost')) {
    return { allowed: false, addresses: [], reason: `主机名 ${hostname} 为内网域名` }
  }

  // DNS 解析后检查
  return new Promise((resolve) => {
    dnsLookup(hostname, (err, address) => {
      if (err) {
        // DNS 解析失败 — 允许（让 fetch 自己报错）
        resolve({ allowed: true, addresses: [], reason: undefined })
        return
      }

      const addresses = Array.isArray(address) ? address.map(a => a.address) : [address]
      const blockedAddrs = addresses.filter(a => isBlockedAddress(a))

      if (blockedAddrs.length > 0) {
        resolve({
          allowed: false,
          addresses,
          reason: `主机 ${hostname} 解析到私有地址 ${blockedAddrs.join(', ')}，可能为 SSRF 目标`,
        })
      } else {
        resolve({ allowed: true, addresses, reason: undefined })
      }
    })
  })
}

/**
 * 检查 URL 是否安全（SSRF 防护）
 * @param {string} url — 完整 URL
 * @returns {Promise<{allowed: boolean, reason?: string}>}
 */
export async function checkUrlSafety(url) {
  try {
    const parsed = new URL(url)

    // 只允许 HTTP/HTTPS
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { allowed: false, reason: `不支持的协议：${parsed.protocol}` }
    }

    // 检查主机名（含主机名黑名单 + DNS 解析）
    const hostResult = await checkHostSafety(parsed.hostname)
    if (!hostResult.allowed) {
      return { allowed: false, reason: hostResult.reason }
    }

    return { allowed: true }
  } catch {
    return { allowed: false, reason: '无效的 URL' }
  }
}

/**
 * 安全 DNS 解析器 — 用于防止 DNS Rebinding 攻击
 * 返回解析后的 IP 地址列表，可直接用于 fetch 的 DNS 查找
 * @param {string} hostname — 主机名
 * @returns {Promise<{addresses: string[], blocked: boolean, reason?: string}>}
 */
export async function safeDnsLookup(hostname) {
  return new Promise((resolve) => {
    dnsLookup(hostname, (err, address) => {
      if (err) {
        resolve({ addresses: [], blocked: false, reason: undefined })
        return
      }

      const addresses = Array.isArray(address) ? address.map(a => a.address) : [address]
      const blockedAddrs = addresses.filter(a => isBlockedAddress(a))

      if (blockedAddrs.length > 0) {
        resolve({
          addresses,
          blocked: true,
          reason: `主机 ${hostname} 解析到私有地址 ${blockedAddrs.join(', ')}`,
        })
      } else {
        resolve({ addresses, blocked: false, reason: undefined })
      }
    })
  })
}

/**
 * 创建安全 fetch 函数 — 防止 DNS Rebinding
 * 使用预先解析的 IP 地址，避免二次 DNS 查询
 * @param {Function} nativeFetch — 原生 fetch
 * @returns {Function} 安全 fetch
 */
export function createSafeFetch(nativeFetch) {
  return async function safeFetch(url, options = {}) {
    const parsed = new URL(url)
    
    // 只处理 HTTP/HTTPS
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return nativeFetch(url, options)
    }

    // 检查主机名安全性
    const hostResult = await checkHostSafety(parsed.hostname)
    if (!hostResult.allowed) {
      throw new Error(`SSRF blocked: ${hostResult.reason}`)
    }

    // 如果主机名是 IP 地址，直接使用
    if (isIP(parsed.hostname)) {
      return nativeFetch(url, options)
    }

    // 对于域名，使用预先解析的 IP 地址
    // 通过设置 Host header 和直接连接 IP 来防止 DNS Rebinding
    const lookupResult = await safeDnsLookup(parsed.hostname)
    if (lookupResult.blocked) {
      throw new Error(`SSRF blocked: ${lookupResult.reason}`)
    }

    // 使用第一个非阻止的 IP 地址
    if (lookupResult.addresses.length > 0) {
      // 创建一个自定义 Agent 来覆盖 DNS 解析
      // 注意：这需要 Node.js 的 http/https 模块支持
      // 简单方案：直接修改 URL 为主机名 + IP
      const originalHost = parsed.hostname
      const ip = lookupResult.addresses[0]
      
      // 创建新 URL 使用 IP 地址
      const safeUrl = url.replace(originalHost, ip)
      
      // 设置 Host header 为原始主机名
      const safeOptions = {
        ...options,
        headers: {
          ...options.headers,
          'Host': originalHost,
        },
      }
      
      return nativeFetch(safeUrl, safeOptions)
    }

    return nativeFetch(url, options)
  }
}
