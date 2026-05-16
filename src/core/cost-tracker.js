/**
 * 费用追踪 (Cost Tracking) — API 调用费用计算和报告
 * 
 * 支持主流模型的价格表，自动根据 model 名称匹配价格。
 * 对应原版: src/utils/costTracker.ts
 */

// ============================================================
// 模型价格表（美元 / 1M tokens）
// ============================================================

const PRICING = {
  // DeepSeek
  'deepseek-chat':           { input: 0.27,  output: 1.10,  cache_read: 0.07 },
  'deepseek-reasoner':       { input: 0.55,  output: 2.19,  cache_read: 0.14 },

  // OpenAI
  'gpt-4o':                  { input: 2.50,  output: 10.00 },
  'gpt-4o-mini':             { input: 0.15,  output: 0.60 },
  'gpt-4.1':                 { input: 2.00,  output: 8.00 },
  'gpt-4.1-mini':            { input: 0.40,  output: 1.60 },
  'gpt-4.1-nano':            { input: 0.10,  output: 0.40 },
  'o3':                      { input: 2.00,  output: 8.00 },
  'o3-mini':                 { input: 1.10,  output: 4.40 },
  'o4-mini':                 { input: 1.10,  output: 4.40 },

  // 通义千问 (Qwen)
  'qwen-plus':               { input: 0.50,  output: 2.00 },
  'qwen-turbo':              { input: 0.05,  output: 0.20 },
  'qwen-max':                { input: 2.00,  output: 6.00 },
  'qwen-long':               { input: 0.07,  output: 0.28 },

  // 智谱 GLM
  'glm-4-flash':             { input: 0.10,  output: 0.10 },
  'glm-4-plus':              { input: 0.50,  output: 0.50 },
  'glm-4':                   { input: 1.00,  output: 1.00 },
  'glm-4-long':              { input: 0.10,  output: 0.10 },

  // Moonshot Kimi
  'moonshot-v1-8k':          { input: 0.50,  output: 2.00 },
  'moonshot-v1-32k':         { input: 1.00,  output: 4.00 },
  'moonshot-v1-128k':        { input: 2.00,  output: 8.00 },

  // Ollama (本地免费)
  'ollama':                  { input: 0,     output: 0 },
}

// 默认价格（未匹配到的模型）
const DEFAULT_PRICING = { input: 0.50, output: 2.00 }

/**
 * 根据模型名查找价格
 */
function findPricing(model) {
  if (!model) return DEFAULT_PRICING

  // 精确匹配
  if (PRICING[model]) return PRICING[model]

  // 前缀匹配 (e.g. "deepseek-chat-v3" → "deepseek-chat")
  for (const [key, price] of Object.entries(PRICING)) {
    if (model.startsWith(key) || model.includes(key)) return price
  }

  // Ollama 系列全部免费
  if (model.includes('ollama') || model.includes('local') || model.includes('localhost')) {
    return PRICING.ollama
  }

  return DEFAULT_PRICING
}

/**
 * 费用追踪器
 */
export class CostTracker {
  constructor(options = {}) {
    this.model = options.model || ''
    this.pricing = findPricing(this.model)
    this.totalInputTokens = 0
    this.totalOutputTokens = 0
    this.totalCacheReadTokens = 0
    this.totalApiCalls = 0
    this.history = []  // 每次 API 调用的记录
  }

  /** 切换模型（更新价格表） */
  setModel(model) {
    this.model = model
    this.pricing = findPricing(model)
  }

  /** 记录一次 API 调用 */
  recordUsage(usage) {
    const inputTokens = usage.input_tokens || usage.prompt_tokens || 0
    const outputTokens = usage.output_tokens || usage.completion_tokens || 0
    const cacheReadTokens = usage.cache_read_input_tokens || 0

    const cost = this.calculateCost(inputTokens, outputTokens, cacheReadTokens)

    this.totalInputTokens += inputTokens
    this.totalOutputTokens += outputTokens
    this.totalCacheReadTokens += cacheReadTokens
    this.totalApiCalls++

    this.history.push({
      timestamp: Date.now(),
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cost,
    })

    return cost
  }

  /** 计算单次费用 */
  calculateCost(inputTokens, outputTokens, cacheReadTokens = 0) {
    const cost = {
      input: (inputTokens / 1_000_000) * this.pricing.input,
      output: (outputTokens / 1_000_000) * this.pricing.output,
      cacheRead: (cacheReadTokens / 1_000_000) * (this.pricing.cache_read || 0),
    }
    cost.total = cost.input + cost.output + cost.cacheRead
    return cost
  }

  /** 获取总费用 */
  getTotalCost() {
    const cost = this.calculateCost(
      this.totalInputTokens,
      this.totalOutputTokens,
      this.totalCacheReadTokens
    )
    return cost
  }

  /** 格式化费用报告 */
  formatReport() {
    const cost = this.getTotalCost()
    const lines = [
      `💰 Cost Report — ${this.model}`,
      `   API Calls:     ${this.totalApiCalls}`,
      `   Input Tokens:  ${this.totalInputTokens.toLocaleString()} → $${cost.input.toFixed(4)}`,
      `   Output Tokens: ${this.totalOutputTokens.toLocaleString()} → $${cost.output.toFixed(4)}`,
    ]
    if (this.totalCacheReadTokens > 0) {
      lines.push(`   Cache Read:    ${this.totalCacheReadTokens.toLocaleString()} → $${cost.cacheRead.toFixed(4)}`)
    }
    lines.push(`   ───────────────────────────────`)
    lines.push(`   Total:         $${cost.total.toFixed(4)}`)
    return lines.join('\n')
  }

  /** 简短格式（单行） */
  formatShort() {
    const cost = this.getTotalCost()
    return `$${cost.total.toFixed(4)} (${this.totalApiCalls} calls, ${this.totalInputTokens.toLocaleString()}+${this.totalOutputTokens.toLocaleString()} tok)`
  }

  /** 重置 */
  reset() {
    this.totalInputTokens = 0
    this.totalOutputTokens = 0
    this.totalCacheReadTokens = 0
    this.totalApiCalls = 0
    this.history = []
  }
}

export { PRICING, findPricing }
