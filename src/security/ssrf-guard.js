/**
 * SSRF 防护 — 阻止对内网/云元数据端点的请求
 * 对应原版: src/utils/hooks/ssrfGuard.ts
 */
import { lookup as dnsLookup } from 'dns'
import { isIP } from 'net'

/**
 * 检查 IPv4 地址是否在应被阻止的范围内
 *
 * 阻止列表:
 * - 0.0.0.0/8     — "this" 网络
 * - 10.0.0.0/8    — 私有网络
 * - 100.64.0.0/10 — CGNAT 共享地址（阿里云元数据 100.100.100.200）
 * - 169.254.0.0/16 — 链路本地（AWS/GCP 云元数据）
 * - 172.16.0.0/12 — 私有网络
 * - 192.168.0.0/16 — 私有网络
 * - 192.0.2.0/24  — TEST-NET-1 (RFC 5737)
 * - 198.51.100.0/24 — TEST-NET-2
 * - 203.0.113.0/24 — TEST-NET-3
 *
 * 允许:
 * - 127.0.0.0/8   — 回环（本地开发 hook 服务器）
 */
function isBlockedV4(address) {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some(n => Number.isNaN(n))) return false

  const [a, b] = parts

  // 回环 — 允许
  if (a === 127) return false

  // 0.0.0.0/8
  if (a === 0) return true

  // 10.0.0.0/8
  if (a === 10) return true

  // 100.64.0.0/10 — CGNAT (RFC 6598)
  if (a === 100 && b >= 64 && b <= 127) return true

  // 169.254.0.0/16 — 链路本地，云元数据
  if (a === 169 && b === 254) return true

  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true

  // 192.168.0.0/16
  if (a === 192 && b === 168) return true

  // 192.0.2.0/24 — TEST-NET-1
  if (a === 192 && b === 0 && parts[2] === 2) return true

  // 198.51.100.0/24 — TEST-NET-2
  if (a === 198 && b === 51 && parts[2] === 100) return true

  // 203.0.113.0/24 — TEST-NET-3
  if (a === 203 && b === 0 && parts[2] === 113) return true

  return false
}

/**
 * 检查 IPv6 地址是否在应被阻止的范围内
 *
 * 阻止:
 * - ::           — 未指定地址
 * - fc00::/7     — 唯一本地地址 (ULA)
 * - fe80::/10    — 链路本地
 * - ::ffff:<被阻止的v4> — IPv4 映射地址
 *
 * 允许:
 * - ::1          — 回环
 */
function isBlockedV6(address) {
  const normalized = address.toLowerCase()

  // ::1 回环 — 允许
  if (normalized === '::1') return false

  // :: 未指定
  if (normalized === '::' || normalized === '0:0:0:0:0:0:0:0') return true

  // fc00::/7 — 唯一本地 (fc00:: - fdff::)
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true

  // fe80::/10 — 链路本地
  if (normalized.startsWith('fe8')) return true

  // ::ffff:<IPv4> — IPv4 映射地址
  const v4Mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (v4Mapped) {
    return isBlockedV4(v4Mapped[1])
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
      return { allowed: false, reason: `不支持的协议: ${parsed.protocol}` }
    }

    // 检查主机名
    const hostResult = await checkHostSafety(parsed.hostname)
    if (!hostResult.allowed) {
      return { allowed: false, reason: hostResult.reason }
    }

    return { allowed: true }
  } catch {
    return { allowed: false, reason: '无效的 URL' }
  }
}
