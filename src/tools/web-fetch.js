/**
 * WebFetch 工具 — 抓取网页内容（安全管道 + Jina 兜底）
 *
 * 安全特性（移植自 safe-jina-fetch 设计）：
 *  - 协议白名单：仅 http/https，file/ftp/data 拒绝
 *  - 连接级 SSRF 防护：TCP 连接时逐地址校验（防 DNS rebinding）
 *  - 重定向逐跳校验：最多 5 跳，每跳重新校验
 *  - 响应大小上限（10MB）、超时（30s）、强制 SSL
 *  - 敏感数据自动脱敏
 *
 * 兜底机制：
 *  - 直连成功（2xx）→ 返回清洗后的文本/JSON
 *  - 直连失败（非 2xx / 网络错误 / 超时）→ 自动经 Jina Reader 清洗后返回 Markdown
 *  - 直连 200 但正文过短（< 200 字符，疑似 JS 挑战页）→ 也触发 Jina 兜底
 *
 * extractMode 参数：
 *  - auto   （默认）直连优先，失败/异常走 Jina 兜底
 *  - direct 强制直连，不兜底
 *  - jina   强制直接走 Jina Reader（最干净，永远清洗）
 */
import { ToolDef } from '../types/index.js'
import { safeFetchWithRedirects, DEFAULT_FETCH_OPTIONS } from '../security/fetch-guard.js'
import { redactSensitiveData } from '../security/redact.js'
import { safeJinaFetch, resolveJinaApiKey } from './web-fetch-providers.js'

const DEFAULT_MAX_CHARS = 100000
// 正文过短阈值：低于此字符数视为疑似 JS 挑战页，触发 Jina 兜底（对齐 DESIGN.md §8 增强）
const MIN_BODY_CHARS = 200

/**
 * 简单的 HTML → 纯文本转换
 */
function htmlToText(html) {
  let text = html
  // 移除 script/style
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '')
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '')
  text = text.replace(/<nav[\s\S]*?<\/nav>/gi, '')
  // 保留一些有用的标签语义
  text = text.replace(/<h[1-6][^>]*>/gi, '\n## ')
  text = text.replace(/<\/h[1-6]>/gi, '\n')
  text = text.replace(/<p[^>]*>/gi, '\n')
  text = text.replace(/<br\s*\/?>/gi, '\n')
  text = text.replace(/<li[^>]*>/gi, '\n- ')
  text = text.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
  text = text.replace(/<img[^>]*alt="([^"]*)"[^>]*>/gi, '[image: $1]')
  // 移除所有剩余 HTML 标签
  text = text.replace(/<[^>]+>/g, '')
  // 解码常见 HTML 实体
  text = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  text = text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
  // 清理多余空白
  text = text.replace(/\n{3,}/g, '\n\n').trim()

  return text
}

const VERSION = '2.1.0'

export const webFetchTool = new ToolDef(
  'WebFetch',
  `Fetch and extract content from a URL.
Usage:
- url must be a valid HTTP/HTTPS URL
- Returns the page content as cleaned text/markdown
- Supports HTML pages, plain text, and JSON APIs
- If direct fetch fails (403/anti-crawl/network error), automatically falls back to Jina Reader for a clean Markdown version
- extractMode: auto (direct first, fallback on failure) | direct (force direct only) | jina (always use Jina Reader)`,
  {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to fetch',
      },
      format: {
        type: 'string',
        enum: ['text', 'json', 'raw'],
        description: 'Output format: text (cleaned HTML), json (parse as JSON), raw (raw response)',
      },
      extractMode: {
        type: 'string',
        enum: ['auto', 'direct', 'jina'],
        description: 'Extraction mode: auto (default, direct first + Jina fallback), direct (force direct), jina (always Jina Reader)',
      },
    },
    required: ['url'],
  },
  async (input, ctx) => {
    const { url, format = 'text', extractMode = 'auto' } = input

    const config = ctx?.engine?.config?.configStore || null
    const maxChars = config?.get?.('web.fetch.maxChars') || DEFAULT_MAX_CHARS
    const maxBytes = config?.get?.('web.fetch.maxBytes') || DEFAULT_FETCH_OPTIONS.maxBytes
    const timeoutMs = config?.get?.('web.fetch.timeoutMs') || DEFAULT_FETCH_OPTIONS.timeoutMs
    const maxRedirects = config?.get?.('web.fetch.maxRedirects') || DEFAULT_FETCH_OPTIONS.maxRedirects
    const jinaApiKey = resolveJinaApiKey(config)

    // extractMode=jina：强制直接走 Jina（永远清洗）
    if (extractMode === 'jina') {
      const jr = await safeJinaFetch(url, { apiKey: jinaApiKey, format: 'markdown', timeoutMs })
      if (!jr.ok) return `[Error: ${jr.error}]`
      const { text, redacted } = redactSensitiveData(jr.text)
      const out = (jr.title ? `# ${jr.title}\n\n` : '') + text
      const warning = redacted.length ? `\n\n[⚠️ 已脱敏: ${redacted.join(', ')}]` : ''
      return (out + warning).slice(0, maxChars)
    }

    // 直连（安全管道：协议 + 连接级 SSRF + 重定向逐跳校验 + 大小/超时/SSL）
    const result = await safeFetchWithRedirects(url, { timeoutMs, maxBytes, maxRedirects })

    // extractMode=direct：不兜底，直接返回直连结果（无论成败）
    if (extractMode === 'direct') {
      return formatDirectResult(result, format, maxChars)
    }

    // auto 模式：直连失败或内容过短 → 走 Jina 兜底
    const failed = !result.ok || result.error
    const tooShort = result.ok && result.body.trim().length < MIN_BODY_CHARS
    if (failed || tooShort) {
      if (config?.get?.('verbose')) {
        console.error(`[web-fetch] direct ${failed ? `failed (${result.error || result.status})` : 'content too short'}, falling back to Jina Reader`)
      }
      const jr = await safeJinaFetch(url, { apiKey: jinaApiKey, format: 'markdown', timeoutMs })
      if (jr.ok) {
        const { text, redacted } = redactSensitiveData(jr.text)
        const out = (jr.title ? `# ${jr.title}\n\n` : '') + text
        const warning = redacted.length ? `\n\n[⚠️ 已脱敏: ${redacted.join(', ')}]` : ''
        return (out + warning).slice(0, maxChars)
      }
      // Jina 也失败 — 返回直连结果 + Jina 错误说明
      return formatDirectResult(result, format, maxChars) +
        `\n\n[Jina fallback also failed: ${jr.error}]`
    }

    // 直连成功 — 返回直连结果
    return formatDirectResult(result, format, maxChars)
  },
  'ask'
)

/**
 * 格式化直连结果（含脱敏）
 * @param {object} result — safeFetchWithRedirects 返回值
 * @param {string} format
 * @param {number} maxChars
 */
function formatDirectResult(result, format, maxChars) {
  if (!result.ok) {
    if (result.error) return `[Error: ${result.error}]`
    return `[HTTP ${result.status} ${result.statusText || ''}]`.trim()
  }

  const contentType = result.headers['content-type'] || ''
  const body = result.body

  let out
  if (format === 'json' || contentType.includes('application/json')) {
    try {
      const data = JSON.parse(body)
      out = JSON.stringify(data, null, 2)
    } catch {
      out = body
    }
  } else if (format === 'raw') {
    out = body
  } else if (contentType.includes('text/html')) {
    out = htmlToText(body)
  } else {
    out = body
  }

  // 敏感数据脱敏
  const { text, redacted } = redactSensitiveData(out)
  let final = text
  if (result.truncated) final += '\n[...truncated]'
  if (redacted.length) final += `\n[⚠️ 已脱敏: ${redacted.join(', ')}]`
  if (result.redirects?.length) final += `\n[重定向: ${result.redirects.join(' → ')}]`

  return final.length > maxChars ? final.slice(0, maxChars) + '\n[...truncated]' : final
}
