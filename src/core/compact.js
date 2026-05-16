/**
 * 上下文压缩 (Compact) — 长对话自动摘要
 * 
 * 当对话 token 数接近预算上限时，自动将早期对话压缩为摘要，
 * 保留最近 N 轮完整对话 + 工具结果的关键信息。
 * 
 * 对应原版: src/query/compact.ts
 */

import { estimateTokens } from './token-budget.js'

/**
 * 压缩策略：保留最近 N 轮完整对话，早期部分压缩为摘要
 * 
 * @param {Array} messages — 完整消息列表
 * @param {object} options — 配置
 * @param {number} options.maxTokens — token 预算上限
 * @param {number} options.keepRecentTurns — 保留最近 N 轮（默认 4）
 * @param {number} options.maxToolResultChars — 工具结果截断长度（默认 2000）
 * @returns {Array} 压缩后的消息列表
 */
export function compactMessages(messages, options = {}) {
  const maxTokens = options.maxTokens || 160_000
  const keepRecentTurns = options.keepRecentTurns || 4
  const maxToolResultChars = options.maxToolResultChars || 2000

  // 1. 先截断过长的工具结果
  const trimmed = messages.map(msg => {
    if (msg.role === 'tool' && msg.content && msg.content.length > maxToolResultChars) {
      return {
        ...msg,
        content: msg.content.slice(0, maxToolResultChars) + '\n[...compact: truncated]'
      }
    }
    return msg
  })

  // 2. 估算总 token 数
  const totalTokens = estimateTokens(
    trimmed.map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('')
  )

  if (totalTokens <= maxTokens) {
    return trimmed // 不需要压缩
  }

  // 3. 找到分界点：保留最近 keepRecentTurns 轮
  // 一轮 = user + assistant(+tool_calls) + tool 结果们 + assistant 最终回复
  let turnCount = 0
  let splitIndex = trimmed.length

  for (let i = trimmed.length - 1; i >= 0; i--) {
    if (trimmed[i].role === 'user') {
      turnCount++
      if (turnCount > keepRecentTurns) {
        splitIndex = i
        break
      }
    }
  }

  if (splitIndex === 0 || splitIndex >= trimmed.length) {
    return trimmed // 无法压缩，全部保留
  }

  // 4. 将早期消息压缩为摘要
  const earlyMessages = trimmed.slice(0, splitIndex)
  const recentMessages = trimmed.slice(splitIndex)

  const summary = generateSummary(earlyMessages)

  // 5. 构建压缩后的消息列表
  const compacted = []

  // 如果第一条是 system，保留
  if (recentMessages[0]?.role === 'system') {
    compacted.push(recentMessages.shift())
  }

  // 插入摘要作为 system 上下文
  compacted.push({
    role: 'system',
    content: `[Context Summary — ${new Date().toISOString()}]\n${summary}\n[End of Summary — recent conversation follows]`
  })

  // 追加最近对话
  compacted.push(...recentMessages)

  return compacted
}

/**
 * 从消息列表生成摘要
 */
function generateSummary(messages) {
  const topics = new Set()
  const toolsUsed = new Set()
  const keyResults = []
  let lastUserIntent = ''

  for (const msg of messages) {
    if (msg.role === 'user' && msg.content) {
      // 提取用户意图（取第一行或前 80 字符）
      const intent = typeof msg.content === 'string'
        ? msg.content.split('\n')[0].slice(0, 80)
        : ''
      if (intent) lastUserIntent = intent
      topics.add(intent)
    }

    if (msg.role === 'assistant') {
      // 收集使用的工具
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          toolsUsed.add(tc.name)
        }
      }
      // 收集关键文本结果（取最后一条重要的 assistant 回复）
      if (msg.content && typeof msg.content === 'string' && msg.content.length > 20) {
        keyResults.push(msg.content.slice(0, 300))
      }
    }

    if (msg.role === 'tool' && msg.content) {
      // 记录工具结果摘要
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
      if (content.length > 100) {
        keyResults.push(`[tool result]: ${content.slice(0, 150)}...`)
      }
    }
  }

  // 组装摘要
  const parts = []
  if (topics.size > 0) {
    const topicList = [...topics].slice(-5).map(t => `- ${t}`).join('\n')
    parts.push(`User intents:\n${topicList}`)
  }
  if (toolsUsed.size > 0) {
    parts.push(`Tools used: ${[...toolsUsed].join(', ')}`)
  }
  if (keyResults.length > 0) {
    const lastResult = keyResults[keyResults.length - 1]
    parts.push(`Last key result: ${lastResult}`)
  }

  return parts.join('\n\n') || 'Previous conversation context was compacted.'
}

/**
 * 自动检查是否需要压缩，需要时执行
 * 
 * @param {Array} messages — 当前消息列表
 * @param {object} tokenBudget — TokenBudget 实例
 * @param {object} options — 压缩选项
 * @returns {{ compacted: boolean, messages: Array }} 是否压缩了 + 结果消息列表
 */
export function autoCompact(messages, tokenBudget, options = {}) {
  const threshold = options.threshold || 0.8 // 80% 时触发
  const usagePercent = tokenBudget.usagePercent / 100

  if (usagePercent >= threshold) {
    const compacted = compactMessages(messages, {
      maxTokens: Math.floor(tokenBudget.maxTokens * 0.6), // 压缩到 60%
      ...options,
    })
    return { compacted: true, messages: compacted }
  }

  return { compacted: false, messages }
}
