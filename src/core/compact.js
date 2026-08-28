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
 *
 * 摘要策略（v2.8.7 改进）：
 *   - **Main goal**：显式标注对话【最早】的明确用户意图（通常就是核心任务/主线），
 *     避免早期核心指令被后续例行内容挤掉；
 *   - 其余用户意图按出现顺序去重保留（前 10 条），不再用 slice(-5) 丢弃早期；
 *   - **Key results**：保留【最早】的关键发现 + 【最新】的关键结果（首尾各一），
 *     兼顾"任务进展"与"最终结论"。
 */
/**
 * 压缩连续重复字符（去掉无意义的填充，如 "xxx...xxx" → "x"）。
 * 用于意图/结果去重归一化，避免"例行检查 10 xxx..." 与 "例行检查 100 xxx..." 因
 * 填充长度不同而被误判为不同意图。
 */
function squashRepeats(str) {
  let out = ''
  let last = ''
  for (const ch of str) {
    if (ch !== last) {
      out += ch
      last = ch
    }
  }
  return out
}

/**
 * 判断一条文本是否"有实质内容"（去掉填充后仍有意义）。
 */
function hasSubstance(content) {
  if (!content) return false
  const squashed = squashRepeats(String(content))
  // 去掉空白后仍有足够的信息量（至少 6 个非重复字符，或含中文/冒号等结构化标记）
  const meaningful = squashed.replace(/\s+/g, '')
  return meaningful.length >= 6
}

// 结论性关键词：用于挑选 Key results 里"有价值"的结论，而非过渡性话术
// （注意避开"定位中/正在/好的/让我"等过渡词）
const CONCLUSION_HINTS = [
  '关键', '发现', '错误', '原因', '结论', '问题', '修复',
  '成功', '失败', '是因为', '在于', '导致', '需要', '找到', '定位到',
]

/**
 * 判断一条文本是否像"结论"（含结论性关键词）。
 */
function isConclusionLike(text) {
  const s = String(text)
  return CONCLUSION_HINTS.some(k => s.includes(k))
}

/**
 * 发送前常驻工具结果截断 — 不依赖是否超窗
 *
 * 背景：长对话中工具结果（命令回显、git 输出等）会不断累积，即便单条不长，
 * 条数一多也会让模型（尤其本地小模型）"迷失"在过程噪音里。旧逻辑只在 token
 * 超窗时才截断，导致 token 未超窗（如 37%）但 200+ 条消息让模型变傻。
 *
 * 本函数在【每次发送前】都对工具结果做上限截断（默认 6000 字符），
 * 阈值比压缩时的 maxToolResultChars（2000）宽松，避免频繁误截，
 * 同时把"超长噪音"从源头上压住。
 *
 * @param {Array} messages — 消息列表
 * @param {number} [maxChars=6000] — 工具结果保留的最大字符数
 * @returns {Array} 截断后的消息列表（原列表被浅拷贝修改，不影响调用方原始引用结构）
 */
export function trimToolResults(messages, maxChars = 6000) {
  return messages.map(msg => {
    if (msg.role === 'tool' && typeof msg.content === 'string' && msg.content.length > maxChars) {
      return {
        ...msg,
        content: msg.content.slice(0, maxChars) + `\n[...tool result truncated: kept ${maxChars} chars]`,
      }
    }
    return msg
  })
}

/**
 * 按消息条数折叠历史 — 解决"条数过多、token 不高却变傻"
 *
 * 背景：27B 等本地小模型对"消息条数"比"token 数"更敏感。一个 session 塞进
 * 200+ 条消息（113 条工具结果 + 84 条 assistant + 多个 user），即便 token 只占
 * 窗口 37%，模型也会因为角色切换频繁、工具结果噪音堆积而"迷失"当前指令。
 *
 * 本函数在消息条数超过 maxMessages 时，把早期历史折叠成一条摘要
 * （保留 Main goal + 工具使用 + 关键结果），仅保留最近 keepRecentTurns 轮的
 * 完整对话，把消息条数压到可管理范围，同时不丢主线。
 *
 * @param {Array} messages — 完整消息列表
 * @param {object} options
 * @param {number} [options.maxMessages=80] — 超过此条数即触发折叠
 * @param {number} [options.keepRecentTurns=4] — 保留最近 N 轮完整对话
 * @param {number} [options.maxToolResultChars=2000] — 折叠时工具结果截断长度
 * @returns {{ folded: boolean, messages: Array, removed: number, summary: string|null }}
 */
export function foldHistoryByCount(messages, options = {}) {
  const maxMessages = options.maxMessages || 80
  const keepRecentTurns = options.keepRecentTurns ?? 4
  const maxToolResultChars = options.maxToolResultChars || 2000

  // 未超过条数阈值 → 不折叠
  if (messages.length <= maxMessages) {
    return { folded: false, messages, removed: 0, summary: null }
  }

  // 分离 system 提示与普通消息
  const systemMsgs = []
  const body = []
  for (const m of messages) {
    if (m.role === 'system') {
      systemMsgs.push(m)
    } else {
      body.push(m)
    }
  }

  // 找到分界点。
  // 核心原则：**绝不能破坏"当前正在进行的任务链"的完整性**。
  // 小模型"工作到一半变傻"的根因，就是折叠把正在进行的任务（最近的 user 指令
  // 及其后的 tool 调用链）折叠成模糊摘要，模型丢失了"当前任务状态"（在做什么、
  // 做到哪、下一步干什么）而停止调用工具。
  // 因此：
  //   1. 优先只折叠【最近 user 指令之前】的早期历史——当前任务（最近 user 指令
  //      之后所有消息，含进行中的工具调用链）完整保留，永不折叠。
  //   2. 若当前任务本身消息仍过多（单个任务几十轮），再从当前任务内部按
  //      【完整 user 轮次】为单位折叠（保留最近 keepRecentTurns 个 user 任务），
  //      绝不从 tool/assistant 消息中间截断工具链。
  let splitIndex = -1
  // 找最近的 user 指令位置
  let lastUserIdx = -1
  for (let i = body.length - 1; i >= 0; i--) {
    if (body[i].role === 'user') {
      lastUserIdx = i
      break
    }
  }
  // 最近的 user 之后的消息数（当前任务的大小）
  const currentTaskSize = lastUserIdx === -1 ? body.length : body.length - lastUserIdx
  if (lastUserIdx > 0 && currentTaskSize <= maxMessages) {
    // 当前任务本身未超限 → 折叠当前任务之前的历史（保留最近 user 指令起全部）
    splitIndex = lastUserIdx
  } else if (lastUserIdx >= 0) {
    // 当前任务本身也超限 → 从当前任务内部按完整 user 轮次折叠
    let turnCount = 0
    splitIndex = lastUserIdx
    for (let i = body.length - 1; i >= lastUserIdx; i--) {
      if (body[i].role === 'user') {
        turnCount++
        if (turnCount >= keepRecentTurns) {
          splitIndex = i
          break
        }
      }
    }
  } else {
    // 没有 user 消息（异常）→ 用 keepRecentTurns 兜底
    let turnCount = 0
    splitIndex = body.length
    for (let i = body.length - 1; i >= 0; i--) {
      if (body[i].role === 'user') {
        turnCount++
        if (turnCount >= keepRecentTurns) {
          splitIndex = i
          break
        }
      }
    }
  }

  // 没有可折叠的早期消息（全都要保留）→ 不折叠
  if (splitIndex <= 0 || splitIndex >= body.length) {
    return { folded: false, messages, removed: 0, summary: null }
  }

  const earlyMessages = body.slice(0, splitIndex)
  const recentMessages = body.slice(splitIndex)

  // 对折叠掉的历史生成摘要（保留 Main goal / 工具 / 关键结果）
  const summary = generateSummary(earlyMessages)

  // 构建折叠后的消息列表：system + (摘要 system) + 当前任务完整对话
  const folded = [...systemMsgs]
  folded.push({
    role: 'system',
    content: `[Context Summary — ${new Date().toISOString()}]\n${summary}\n[End of Summary — recent conversation follows]`,
  })
  folded.push(...recentMessages)

  return {
    folded: true,
    messages: folded,
    removed: earlyMessages.length,
    summary,
  }
}

/**
 * 从消息列表生成摘要
 *
 * 摘要策略（v2.8.7 改进）：
 *   - **Main goal**：显式标注对话【最早】的明确用户意图（通常就是核心任务/主线），
 *     避免早期核心指令被后续例行内容挤掉；
 *   - 其余用户意图按出现顺序去重保留（前 10 条），数字归一化 + 去填充，
 *     让"例行检查 0/1/2"归并为一条，不占满摘要；
 *   - **Key results**：优先保留【最早的一条结论性内容】+【最新的一条结果】，
 *     过滤纯填充/过渡性话术，避免例行内容淹没核心结论。
 */
function generateSummary(messages) {
  const topics = [] // 保留出现顺序，不丢早期
  const seenIntents = new Set() // 归一化去重
  const toolsUsed = new Set()
  const keyResults = [] // 有实质内容的结果（保留顺序）
  let firstIntent = ''

  for (const msg of messages) {
    if (msg.role === 'user' && msg.content) {
      // 提取用户意图（取第一行或前 80 字符）
      const intent = typeof msg.content === 'string'
        ? msg.content.split('\n')[0].slice(0, 80)
        : ''
      if (intent) {
        if (!firstIntent) firstIntent = intent
        // 数字归一化 + 去填充去重："例行检查 10 xxx..." 与 "例行检查 100 xxx..." → 同一条
        const norm = squashRepeats(intent.replace(/\d+/g, 'N'))
        if (!seenIntents.has(norm)) {
          seenIntents.add(norm)
          topics.push(intent)
        }
      }
    }

    if (msg.role === 'assistant') {
      // 收集使用的工具
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          toolsUsed.add(tc.name)
        }
      }
      // 收集有实质内容的关键文本结果
      if (typeof msg.content === 'string' && hasSubstance(msg.content)) {
        keyResults.push(msg.content.slice(0, 300))
      }
    }

    if (msg.role === 'tool' && msg.content) {
      // 记录工具结果摘要（去填充后判断）
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
      if (hasSubstance(content)) {
        keyResults.push(`[tool result]: ${content.slice(0, 150)}...`)
      }
    }
  }

  // 组装摘要
  const parts = []
  if (firstIntent) {
    parts.push(`Main goal: ${firstIntent}`)
  }
  const restTopics = topics.filter(t => t !== firstIntent).slice(0, 10)
  if (restTopics.length > 0) {
    parts.push(`User intents:\n${restTopics.map(t => `- ${t}`).join('\n')}`)
  }
  if (toolsUsed.size > 0) {
    parts.push(`Tools used: ${[...toolsUsed].join(', ')}`)
  }
  if (keyResults.length > 0) {
    // 优先取【最早的结论性内容】；若无结论性内容，退回最早一条
    const firstConclusion = keyResults.find(k => isConclusionLike(k)) || keyResults[0]
    const last = keyResults[keyResults.length - 1]
    const kr = firstConclusion === last ? [firstConclusion] : [firstConclusion, last]
    parts.push(`Key results:\n${kr.map(k => `- ${k}`).join('\n')}`)
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
  // 可直接指定裁剪上限（覆盖 maxTokens - reservedForOutput），用于保守触发场景
  const limit = options.limitOverride != null
    ? options.limitOverride
    : maxTokens - reservedForOutput

  const estimate = (msgs) => budget
    ? budget.estimateMessages(msgs)
    : estimateTokens(msgs.map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join(''))

  // 先计算总 token
  let total = estimate(messages)
  if (total <= limit) {
    return { trimmed: false, messages, removed: 0, summary: null }
  }

  // 分离 system 提示与普通消息
  // 注意：收集【所有】 system（不只第一条），避免多次裁剪后旧的摘要 system
  // 残留在 body 里、被挤到对话中间，触发 llama.cpp "System message must be at the beginning" (500)。
  const systemMsgs = []
  const body = []
  for (const m of messages) {
    if (m.role === 'system') {
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
