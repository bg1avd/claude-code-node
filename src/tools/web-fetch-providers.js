/**
 * WebFetch 兜底 Provider — Safe Jina Reader
 *
 * 移植自 openclaw safe-jina-fetch 设计（DESIGN.md §5）。
 *
 * 作用：当 WebFetch 直连目标 URL 失败（非 ok / 网络错误 / 超时）时，
 * 自动经 Jina Reader（https://r.jina.ai/<url>）清洗后返回 Markdown，
 * 专门对付反爬 / 403 / 动态渲染站点。
 *
 * Jina 请求模式（对齐 DESIGN.md §5.3）：
 *   - CLI / 默认: text/plain + X-Return-Format: markdown → 首行 Title: xxx 提取标题
 *   - json:        application/json → {title, url, content} 更稳健
 *
 * 凭据（三选一，可选——匿名约 20 RPM）：
 *   1. 环境变量 JINA_API_KEY / JINA_READER_KEY
 *   2. 配置 web.fetch.jinaApiKey
 *   3. 匿名
 */

const JINA_READER_BASE = 'https://r.jina.ai'

/**
 * 从 Jina Reader 返回的 markdown 文本中提取标题（首行 "Title: xxx"）
 * @param {string} markdown
 * @returns {string}
 */
export function extractTitleFromMarkdown(markdown) {
  const lines = (markdown || '').split('\n')
  for (const line of lines) {
    const m = line.match(/^\s*Title:\s*(.+)$/i)
    if (m) return m[1].trim()
  }
  return ''
}

/**
 * 解析 Jina 返回的 markdown，提取正文（去掉 Title/URL 元信息行）
 * @param {string} markdown
 * @returns {string}
 */
export function cleanJinaMarkdown(markdown) {
  if (typeof markdown !== 'string') return ''
  const lines = markdown.split('\n')

  // 优先找 "Markdown Content:" 标记，从其后开始
  const mcIdx = lines.findIndex(l => /^Markdown Content:/i.test(l.trim()))
  if (mcIdx >= 0) return lines.slice(mcIdx + 1).join('\n').trim()

  // 否则去掉开头的 Title: / URL Source: 元信息行
  const bodyStart = lines.findIndex(l => !/^(Title:|URL Source:)/i.test(l.trim()))
  if (bodyStart > 0) return lines.slice(bodyStart).join('\n').trim()

  return markdown.trim()
}

/**
 * 调用 Jina Reader 抓取 URL
 * @param {string} url — 目标 URL
 * @param {object} [options]
 * @param {string} [options.apiKey] — Jina 凭据（可选，匿名可用）
 * @param {'markdown'|'json'} [options.format] — 返回格式
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{ok: boolean, text: string, title: string, finalUrl: string, status?: number, error?: string}>}
 */
export async function safeJinaFetch(url, options = {}) {
  const { apiKey = '', format = 'markdown', timeoutMs = 30000 } = options

  // 校验目标 URL 基本合法性（协议必须是 http/https）
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, text: '', title: '', finalUrl: url, error: `无效的 URL: ${url}` }
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { ok: false, text: '', title: '', finalUrl: url, error: `不支持的协议：${parsed.protocol}` }
  }

  const jinaUrl = `${JINA_READER_BASE}/${url}`
  const headers = {
    'User-Agent': 'cc-node/2.8.2',
    'Accept': format === 'json' ? 'application/json' : 'text/plain',
  }
  if (format === 'markdown') headers['X-Return-Format'] = 'markdown'
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`

  try {
    const response = await fetch(jinaUrl, { headers, signal: AbortSignal.timeout(timeoutMs) })

    if (!response.ok) {
      return {
        ok: false,
        text: '',
        title: '',
        finalUrl: jinaUrl,
        status: response.status,
        error: `Jina Reader HTTP ${response.status}`,
      }
    }

    if (format === 'json') {
      const data = await response.json()
      return {
        ok: true,
        text: typeof data.content === 'string' ? data.content : '',
        title: typeof data.title === 'string' ? data.title : '',
        finalUrl: jinaUrl,
        status: 200,
      }
    }

    const markdown = await response.text()
    return {
      ok: true,
      text: cleanJinaMarkdown(markdown),
      title: extractTitleFromMarkdown(markdown),
      finalUrl: jinaUrl,
      status: 200,
    }
  } catch (err) {
    if (err.name === 'TimeoutError') {
      return { ok: false, text: '', title: '', finalUrl: jinaUrl, error: 'Jina Reader 请求超时' }
    }
    return { ok: false, text: '', title: '', finalUrl: jinaUrl, error: `Jina Reader 错误: ${err.message}` }
  }
}

/**
 * 解析 Jina 凭据（三选一：环境变量 > 配置 > 匿名）
 * @param {object} [config] — Config 实例（可选）
 * @returns {string} apiKey（可能为空 = 匿名）
 */
export function resolveJinaApiKey(config = null) {
  return (
    process.env.JINA_API_KEY ||
    process.env.JINA_READER_KEY ||
    (config ? config.get('web.fetch.jinaApiKey') || '' : '') ||
    ''
  )
}
