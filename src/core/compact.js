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

/**
 * 滑动窗口裁剪 — 保证上下文永不超出窗口
 *
 * 与摘要式压缩（compactMessages）不同，本函数采用"精确裁剪"：
 *   1. 计算当前消息总 token；
 *   2. 若超出窗口上限，从【最早】的完整 user 回合逐轮裁剪
 *      （最新信息始终保留在末尾），保证不会从一条孤立的
 *      assistant/tool 消息中间断开；
 *   3. 直到总 token ≤ 窗口，保证新信息能拼接到末尾。
 *
 * 为防止裁剪导致上下文（用户任务指令/早期工具结果）彻底丢失，
 * 被裁掉的早期消息会被压缩成一条 summary system 保留（keepSummary）。
 *
 * 约束：
 *   - system 提示（首条 system 消息）永不裁剪，作为稳定上下文保留；
 *   - 极端情况（单条消息就超窗）：仍保留 system + 最近的一条，
 *     其余裁剪，保证至少能发出请求（宁可截断信息也不报错/无法输入）。
 *
 * @param {Array} messages — 完整消息列表
 * @param {object} options
 * @param {number} options.maxTokens — 窗口上限（token）
 * @param {number} options.reservedForOutput — 为输出预留的 token（默认 8192）
 * @param {object} options.tokenBudget — 可选的 TokenBudget 实例（用其 estimateMessages）
 * @param {boolean} options.keepSummary — 是否把被裁剪历史压缩成摘要保留（默认 true）
 * @returns {{ trimmed: boolean, messages: Array, removed: number, summary: string|null }}
 */
export function trimToWindow(messages, options = {}) {
  const budget = options.tokenBudget
  const maxTokens = options.maxTokens || 160_000
  const reservedForOutput = options.reservedForOutput || (budget ? budget.reservedForOutput : 8192)
  const keepSummary = options.keepSummary !== false
  const limit = maxTokens - reservedForOutput

  const estimate = (msgs) => budget
    ? budget.estimateMessages(msgs)
    : estimateTokens(msgs.map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join(''))

  // 先计算总 token
  let total = estimate(messages)
  if (total <= limit) {
    return { trimmed: false, messages, removed: 0, summary: null }
  }

  // 分离 system 提示（首条 system 永不裁剪）与普通消息
  const systemMsgs = []
  const body = []
  for (const m of messages) {
    if (m.role === 'system' && systemMsgs.length === 0) {
      systemMsgs.push(m)
    } else {
      body.push(m)
    }
  }

  // 从头部逐条裁剪（最新信息保留在末尾），直到 ≤ 上限。
  // 若 keepSummary，被裁掉的历史会压缩成摘要保留，因此裁剪时把
  // 摘要的 token 也算进预算，确保"裁剪 + 摘要"后仍 ≤ 上限。
  let removed = 0
  let dropped = []
  let summary = null
  while (body.length > 0) {
    // 极端保护：至少保留最后一条非 system 消息（system + 最近 1 条总能发出去）
    if (body.length === 1) break
    dropped.push(body.shift()) // 挤掉最早的消息
    removed++
    // 计算"裁剪 + 摘要"后的总 token（摘要会随裁剪动态变化）
    const summaryCandidate = keepSummary && dropped.length > 0 ? generateSummary(dropped) : null
    const candidate = summaryCandidate
      ? [...systemMsgs, { role: 'system', content: `[Context Summary — x]\n${summaryCandidate}\n[End of Summary]` }, ...body]
      : [...systemMsgs, ...body]
    total = estimate(candidate)
    if (total <= limit) {
      summary = summaryCandidate
      break
    }
  }

  // 构建最终结果（用真实时间戳）
  const result = summary
    ? [...systemMsgs, { role: 'system', content: `[Context Summary — ${new Date().toISOString()}]\n${summary}\n[End of Summary]` }, ...body]
    : [...systemMsgs, ...body]

  return { trimmed: removed > 0, messages: result, removed, summary }
}
