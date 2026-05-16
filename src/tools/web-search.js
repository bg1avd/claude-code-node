/**
 * WebSearch 工具 — 网页搜索（占位符）
 * 对应原版: src/tools/WebSearchTool/
 */
import { ToolDef } from '../types/index.js'

export const webSearchTool = new ToolDef(
  'WebSearch',
  `Search the web for information.
NOTE: This tool requires a search API key to be configured.
Set BRAVE_SEARCH_API_KEY or GOOGLE_SEARCH_API_KEY in environment variables.`,
  {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query',
      },
      count: {
        type: 'number',
        description: 'Number of results to return (default: 10)',
      },
    },
    required: ['query'],
  },
  async (input, ctx) => {
    const braveKey = process.env.BRAVE_SEARCH_API_KEY
    const googleKey = process.env.GOOGLE_SEARCH_API_KEY
    const googleCx = process.env.GOOGLE_SEARCH_CX

    // 尝试 Brave Search
    if (braveKey) {
      try {
        const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(input.query)}&count=${input.count || 10}`
        const response = await fetch(url, {
          headers: { 'X-Subscription-Token': braveKey, 'Accept': 'application/json' },
          signal: AbortSignal.timeout(15000),
        })
        if (response.ok) {
          const data = await response.json()
          const results = (data.web?.results || []).map((r, i) =>
            `${i + 1}. [${r.title}](${r.url})\n   ${r.description || ''}`
          ).join('\n\n')
          return results || `[No results found for: ${input.query}]`
        }
      } catch (err) {
        return `[Brave Search error: ${err.message}]`
      }
    }

    // 尝试 Google Custom Search
    if (googleKey && googleCx) {
      try {
        const url = `https://www.googleapis.com/customsearch/v1?key=${googleKey}&cx=${googleCx}&q=${encodeURIComponent(input.query)}&num=${input.count || 10}`
        const response = await fetch(url, { signal: AbortSignal.timeout(15000) })
        if (response.ok) {
          const data = await response.json()
          const results = (data.items || []).map((r, i) =>
            `${i + 1}. [${r.title}](${r.link})\n   ${r.snippet || ''}`
          ).join('\n\n')
          return results || `[No results found for: ${input.query}]`
        }
      } catch (err) {
        return `[Google Search error: ${err.message}]`
      }
    }

    return `[WebSearch requires an API key. Set one of:
- BRAVE_SEARCH_API_KEY (Brave Search API)
- GOOGLE_SEARCH_API_KEY + GOOGLE_SEARCH_CX (Google Custom Search)

Query was: "${input.query}"]`
  },
  'ask'
)
