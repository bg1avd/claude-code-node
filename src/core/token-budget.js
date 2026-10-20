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

// 单张图片的 token 估算（视觉模型）。
// 图片以 data URL(超长 base64) 或 image_url 形式存在，无法按字符数估算——
// 按 base64 长度算会严重高估，忽略又会低估。这里按【张数 × 保守常数】估算。
const IMAGE_TOKENS = 1600

/**
 * 估算单条消息的 token —— 与实际发送请求体(_buildRequestBody)口径保持一致。
 *
 * ⚠️ 关键修复(2026-09-22)：旧实现只统计 msg.content，**完全漏算
 * tool_calls 的参数(arguments) 与 reasoning_content**。而发请求时这些都会
 * 序列化进 body —— 于是长对话里工具参数(Write 整个文件内容 / Edit 大段替换 /
 * Bash 长命令)累积数十万 token 却估成 0，压缩判定严重低估
 * (实测 308k 估 vs 986k 实际,3.2 倍)，误判"无需压缩" → API 400 超窗。
 *
 * @param {object} msg — 消息(支持 camelCase toolCalls 与 OpenAI snake_case tool_calls)
 * @returns {number}
 */
export function estimateMessageTokens(msg) {
  if (!msg) return 0
  let total = 0

  // 1) content：字符串 / 多模态块数组 / 其他(对象等一律 JSON 序列化后估算)
  const content = msg.content
  if (typeof content === 'string') {
    total += estimateTokens(content)
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (!block) continue
      if (block.type === 'text' || block.type === 'input_text') {
        total += estimateTokens(block.text)
      } else if (block.type === 'tool_result') {
        total += estimateTokens(typeof block.content === 'string' ? block.content : JSON.stringify(block.content))
      } else if (block.type === 'tool_use') {
        total += estimateTokens(JSON.stringify(block.input))
      } else if (block.type === 'image_url' || block.type === 'image') {
        total += IMAGE_TOKENS
      } else {
        total += estimateTokens(JSON.stringify(block))
      }
    }
  } else if (content != null) {
    total += estimateTokens(JSON.stringify(content))
  }

  // 2) ★ 工具调用参数(修复漏算核心) —— assistant 消息的 tool_calls
  const toolCalls = msg.toolCalls || msg.tool_calls
  if (Array.isArray(toolCalls)) {
    for (const tc of toolCalls) {
      if (!tc) continue
      const input = tc.input ?? tc.function?.arguments
      if (input != null) {
        total += estimateTokens(typeof input === 'string' ? input : JSON.stringify(input))
      }
    }
  }

  // 3) 推理内容(DeepSeek thinking mode 会回传 reasoning_content,同样占用输入 token)
  if (msg.reasoningContent) total += estimateTokens(msg.reasoningContent)

  // 4) 图片(user 消息的 images 字段,data URL 按张数估算而非长度)
  if (Array.isArray(msg.images) && msg.images.length) {
    total += msg.images.length * IMAGE_TOKENS
  }

  // 每条消息的固定协议开销
  total += 10
  return total
}

/** 估算消息列表的 token 数(与请求体口径一致,见 estimateMessageTokens) */
export function estimateMessages(messages) {
  let total = 0
  for (const msg of messages || []) total += estimateMessageTokens(msg)
  return total
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
    // 当前窗口来源：'manual' | 'probe' | 'table' | 'fallback'（见 context-window.js）
    this.windowSource = options.windowSource || 'fallback'
    // ★ 服务端反馈校准系数（v3.6.20）
    // estimateMessages 是启发式估算（英文 4 字符/token、中文 1.5 字符/token），
    // 与各家真实 tokenizer 存在系统性偏差。实测一次事故：
    //   本地估算 719,483 ↔ 服务端实测 986,796（低估 27%）→ 压缩判定失效 → API 400 超窗。
    // 偏差来源：中文分词比例、JSON 转义膨胀（\n → \\n）、每条消息结构开销等。
    // 任何"猜比例"的修法都只能对某一家/某种语料有效，因此改为**用服务端真值反向校准**：
    // 每次收到 usage.prompt_tokens，就与发送前的本地估算求比值，EMA 平滑后作用于后续估算。
    // 这样无论换模型、换语言、换厂商，估算都会自动收敛到真实值。
    this.calibrationFactor = Number.isFinite(options.calibrationFactor) && options.calibrationFactor > 0
      ? options.calibrationFactor
      : 1
    this.calibrationSamples = 0
  }

  /**
   * 用服务端返回的真实 prompt_tokens 校准本地估算。
   *
   * @param {number} actualTokens — 服务端实测（usage.prompt_tokens）
   * @param {number} estimatedTokens — 发送前本地估算（必须与服务端口径一致：含 system + tools）
   * @returns {number} 更新后的校准系数
   */
  calibrate(actualTokens, estimatedTokens) {
    if (!(actualTokens > 0) || !(estimatedTokens > 0)) return this.calibrationFactor
    const ratio = actualTokens / estimatedTokens
    // 拒绝离谱样本（服务端统计异常 / 估算分母过小），避免把系数带偏。
    // 上限取 8：强制压缩后分母会变小（messages 只剩几条），此时比值天然偏大——
    // 若卡在 4 会把**最需要校准的那一次**丢掉（实测 2600/640 ≈ 4.06 被误拒）。
    // 下限 0.4：服务端一般不会比本地估算小太多，过小说明样本异常。
    if (!Number.isFinite(ratio) || ratio < 0.5 || ratio > 6) return this.calibrationFactor
    // 首次直接采用，之后 EMA 平滑（alpha=0.5），避免单次抖动
    const alpha = this.calibrationSamples === 0 ? 1 : 0.5
    const next = this.calibrationFactor * (1 - alpha) + ratio * alpha
    // 夹紧到 [0.5, 3]：真实 tokenizer 与启发式估算的偏差极少超过 2 倍；
    // 上限留 3 是给「压缩后分母变小」的场景留余量，同时避免过度压缩历史。
    this.calibrationFactor = Math.min(3, Math.max(0.5, next))
    this.calibrationSamples++
    return this.calibrationFactor
  }

  /**
   * 应用校准系数后的消息估算（用于压缩判定 / 展示）。
   * @param {Array} messages
   * @returns {number}
   */
  estimateMessagesCalibrated(messages) {
    return Math.ceil(this.estimateMessages(messages) * this.calibrationFactor)
  }

  /**
   * 更新上下文窗口上限（运行时生效，立即反映到 usagePercent）
   * @param {number} maxTokens
   * @param {string} [source] — 窗口来源标签
   */
  setWindow(maxTokens, source) {
    if (Number.isFinite(maxTokens) && maxTokens > 0) {
      this.maxTokens = maxTokens
    }
    if (source) this.windowSource = source
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

  /** 估算消息列表的 token 数(与请求体口径一致,见 estimateMessageTokens) */
  estimateMessages(messages) {
    let total = 0
    for (const msg of messages || []) total += estimateMessageTokens(msg)
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
