/**
 * WebFetch 工具 — 抓取网页内容
 * 对应原版: src/tools/WebFetchTool/
 */
import { ToolDef } from '../types/index.js'
import { checkUrlSafety } from '../security/ssrf-guard.js'

const MAX_FETCH_CHARS = 100000

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

const VERSION = '2.0.0'

export const webFetchTool = new ToolDef(
  'WebFetch',
  `Fetch and extract content from a URL.
Usage:
- url must be a valid HTTP/HTTPS URL
- Returns the page content as cleaned text/markdown
- Supports HTML pages, plain text, and JSON APIs`,
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
    },
    required: ['url'],
  },
  async (input, ctx) => {
    const { url, format = 'text' } = input

    // SSRF 安全检查
    const urlSafety = await checkUrlSafety(url)
    if (!urlSafety.allowed) {
      return `[🚫 URL 被安全策略阻止]\n${urlSafety.reason}`
    }

    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': `ClaudeCode-Node/${VERSION}`,
          'Accept': 'text/html,application/json,text/plain,*/*',
        },
        signal: AbortSignal.timeout(30000),
      })

      if (!response.ok) {
        return `[HTTP ${response.status} ${response.statusText}]`
      }

      const contentType = response.headers.get('content-type') || ''
      const body = await response.text()

      // JSON 格式
      if (format === 'json' || contentType.includes('application/json')) {
        try {
          const data = JSON.parse(body)
          const formatted = JSON.stringify(data, null, 2)
          return formatted.length > MAX_FETCH_CHARS
            ? formatted.slice(0, MAX_FETCH_CHARS) + '\n[...truncated]'
            : formatted
        } catch {
          return body.slice(0, MAX_FETCH_CHARS)
        }
      }

      // 原始格式
      if (format === 'raw') {
        return body.length > MAX_FETCH_CHARS
          ? body.slice(0, MAX_FETCH_CHARS) + '\n[...truncated]'
          : body
      }

      // HTML → 文本
      if (contentType.includes('text/html')) {
        const text = htmlToText(body)
        return text.length > MAX_FETCH_CHARS
          ? text.slice(0, MAX_FETCH_CHARS) + '\n[...truncated]'
          : text
      }

      // 纯文本
      return body.length > MAX_FETCH_CHARS
        ? body.slice(0, MAX_FETCH_CHARS) + '\n[...truncated]'
        : body
    } catch (err) {
      if (err.name === 'TimeoutError') {
        return `[Error: Request timed out after 30s]`
      }
      return `[Error fetching URL: ${err.message}]`
    }
  },
  'ask'
)
