/**
 * LLM 助手 - 调用 LLM API 进行智能分析
 * 复用 cc-node 的 LLM 调用模式
 */

/**
 * 调用 LLM 分析 PR
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {Object} apiConfig - { apiKey, apiBase, model }
 */
export async function callLLM(systemPrompt, userPrompt, apiConfig = {}) {
  const {
    apiKey = process.env.LLM_API_KEY || process.env.DEEPSEEK_API_KEY,
    apiBase = process.env.LLM_API_BASE || 'https://api.deepseek.com/v1',
    model = process.env.LLM_MODEL || 'deepseek-chat'
  } = apiConfig

  if (!apiKey) {
    throw new Error('LLM API key required (set LLM_API_KEY or DEEPSEEK_API_KEY)')
  }

  const response = await fetch(`${apiBase}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.3,
      max_tokens: 2000
    })
  })

  if (!response.ok) {
    const error = await response.json().catch(() => ({}))
    throw new Error(`LLM API error: ${response.status} ${error.message || response.statusText}`)
  }

  const data = await response.json()
  return data.choices[0].message.content
}

/**
 * PR 智能审查 prompt
 * @param {Object} pr - PR 信息
 * @param {string} diff - diff 内容
 * @param {Array} findings - 已发现的规则检查问题
 */
export function buildPRReviewPrompt(pr, diff, findings) {
  const findingsText = findings.map(f => `- ${f.file}:${f.line} [${f.severity}] ${f.message}`).join('\n')

  return `
You are an experienced code reviewer. Analyze the following PR and provide a concise review summary.

## PR Information
- Title: ${pr.title}
- Author: ${pr.user?.login}
- Files changed: ${pr.changed_files}
- Additions: ${pr.additions}, Deletions: ${pr.deletions}

## Automated Findings
${findingsText || 'No issues found by automated checks.'}

## Diff
${diff.substring(0, 5000)}... (truncated)

## Instructions
Provide a review summary with:
1. Overall assessment (POSITIVE / NEEDS_WORK / REJECT)
2. Key strengths (if any)
3. Critical issues that must be fixed
4. Suggestions for improvement
5. Merging recommendation (YES / NO)

Keep it concise (3-5 bullet points).
`
}