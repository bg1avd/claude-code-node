/**
 * Token 预算管理
 * 对应原版: src/query/tokenBudget.ts
 */

/**
 * 简单的 token 估算器
 * 规则：英文 ~4 字符/token，中文 ~1.5 字符/token
 */
export function estimateTokens(text) {
  if (!text) return 0
  // 统计中文字符
  const cjkCount = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length
  const nonCjk = text.length - cjkCount
  return Math.ceil(cjkCount / 1.5 + nonCjk / 4)
}

export class TokenBudget {
  constructor(options = {}) {
    this.maxTokens = options.maxTokens || 200_000
    this.maxOutputTokens = options.maxOutputTokens || 8192
    this.reservedForSystem = options.reservedForSystem || 20_000
    this.reservedForOutput = options.reservedForOutput || 8192
    this.used = 0
    this.inputTokens = 0
    this.outputTokens = 0
  }

  /** 可用于上下文的最大 token 数 */
  get availableForContext() {
    return this.maxTokens - this.reservedForSystem - this.reservedForOutput - this.inputTokens
  }

  /** 是否还有预算 */
  get hasBudget() {
    return this.availableForContext > 1000
  }

  /** 使用率百分比 */
  get usagePercent() {
    return Math.round((this.inputTokens / this.maxTokens) * 100)
  }

  /** 记录一次 API 调用的 token 使用 */
  recordUsage(usage) {
    if (usage.input_tokens) this.inputTokens += usage.input_tokens
    if (usage.output_tokens) this.outputTokens += usage.output_tokens
    if (usage.cache_read_input_tokens) this.inputTokens += usage.cache_read_input_tokens
    this.used = this.inputTokens + this.outputTokens
  }

  /** 估算消息列表的 token 数 */
  estimateMessages(messages) {
    let total = 0
    for (const msg of messages) {
      if (typeof msg.content === 'string') {
        total += estimateTokens(msg.content)
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'text') total += estimateTokens(block.text)
          else if (block.type === 'tool_result') total += estimateTokens(block.content)
          else if (block.type === 'tool_use') total += estimateTokens(JSON.stringify(block.input))
        }
      }
      // 每条消息有固定开销
      total += 10
    }
    return total
  }

  /** 检查是否可以在预算内发送这些消息 */
  canAfford(messages) {
    const estimated = this.estimateMessages(messages)
    return (this.inputTokens + estimated) < (this.maxTokens - this.reservedForOutput)
  }

  /** 格式化 token 使用情况 */
  format() {
    return `Token Budget: ${this.inputTokens.toLocaleString()}/${this.maxTokens.toLocaleString()} (${this.usagePercent}% used) | Output: ${this.outputTokens.toLocaleString()}`
  }

  /** 重置 */
  reset() {
    this.used = 0
    this.inputTokens = 0
    this.outputTokens = 0
  }
}
