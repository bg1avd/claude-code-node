/**
 * QueryEngine — Claude Code 核心引擎的 Node.js 重构
 *
 * 原版: src/QueryEngine.ts (46K 行)
 * 职责: LLM API 调用 → 工具调用循环 → 流式响应 → 重试逻辑
 *
 * 核心循环:
 * 用户输入 → 构建消息列表 → 调用 LLM → 解析工具调用 →
 * 执行工具 → 把结果喂回 LLM → 循环直到无工具调用 → 输出
 *
 * API 协议: OpenAI 兼容（全行业通用）
 * 适用于: OpenAI / DeepSeek / Qwen / GLM / Kimi / Ollama / vLLM / LM Studio / 任何兼容接口
 */
import crypto from 'crypto'
import { UserMessage, AssistantMessage, ToolCall, ToolResult, SessionState } from '../types/index.js'
import { parseStream, parseNonStreamResponse } from './streaming.js'
import { compactMessages, trimToWindow, foldHistoryByCount, trimToolResults } from './compact.js'
import { estimateTokens } from './token-budget.js'
import { CostTracker } from './cost-tracker.js'
import { EnhancedPermissionChecker } from '../security/enhanced-permission.js'
import { isLocalLlmServer, buildAuthHeaders } from '../utils/index.js'
import { buildThinkingParams } from './thinking-adapter.js'
import { EventBus, newReqId, summarizeToolResult } from './event-bus.js'

/**
 * 收尾引导（v3.6.14）—— 工具循环接近上限时注入的 system 指令。
 *
 * 为什么需要它：工具循环真正的痛点是「模型一直调工具、就是不总结」，最后硬撞到
 * maxTurns 上限被强制打断（100 轮 × 每轮一次 LLM 调用 = 几十分钟白等）。
 * 只在最后给一句报错没有意义 —— 应该**提前提醒模型收尾**，让它自己停下来。
 * （v2.8.19 给「小模型模式」做过同样的事，常规模式一直没有。）
 */
const TOOL_LOOP_WRAP_UP_HINT =
  '【收尾指令】你已经连续调用了多轮工具，接近本轮的工具调用上限。\n' +
  '请**立即停止调用任何新工具**，用简洁的文字直接给出：\n' +
  '1) 已经完成的内容与关键结果；2) 尚未完成的部分与原因（如果有）；3) 下一步建议。\n' +
  '不要再调用工具，直接用文字回答。'

/**
 * 无进展检测（v3.6.16）—— 替代"拍脑袋的固定轮数上限"。
 *
 * 为什么：固定轮数（100）既拦不住真正的死循环（轮数多 ≠ 卡住），
 * 又会误伤正常的长任务，还分不清"在干活"和"在原地打转"。
 * **真正的信号是「无进展」**：
 *   - 连续 N 轮用**完全相同的参数**调用同样的工具（说明这一步根本推不动）
 *   - 连续 N 轮的**工具返回内容一模一样**（说明世界没有变化）
 * 检测到 → 先注入提示让模型换策略（先礼），仍不改 → 强制停止（后兵）。
 */
const NO_PROGRESS_WARN_STREAK = 3    // 连续 3 轮无变化 → 提醒模型换策略
const NO_PROGRESS_BREAK_STREAK = 5   // 连续 5 轮仍无变化 → 强制停止
/** maxTurns <= 0（不限）时的极端兜底，避免真·死循环把账单一路烧穿 */
const HARD_TURN_CAP = 1000

function buildNoProgressHint(toolNames, reason) {
  return (
    '【重复检测】你最近几轮' + reason + '（' + toolNames + '），看起来没有取得任何进展。\n' +
    '请**立即改变策略**：换参数、换工具、跳过这一步，或者承认此路不通。\n' +
    '如果确实无法继续，请直接用文字说明现状与卡点，不要再重复同样的调用。'
  )
}
import { stripAnsiCodes } from '../utils/ansi.js'

/**
 * 配置选项
 */
export class QueryEngineConfig {
  constructor(options = {}) {
    this.cwd = options.cwd || process.cwd()
    this.tools = options.tools || []
    this.commands = options.commands || []
    this.systemPrompt = options.systemPrompt || ''
    // 默认模型 — 不绑定任何厂商，用户必须通过 --model 或配置指定
    this.model = options.model || ''
    // 工具循环轮数上限：**默认 0 = 不限制**（v3.6.16 起）。
    // 固定轮数上限是给弱模型打的应急补丁，它拦不住真循环、还误伤正常长任务；
    // 真正的刹车改为「无进展检测 + /stop + 收尾引导」。
    // >0 时才作为硬上限生效（并启用收尾引导）；<=0 时仅保留 HARD_TURN_CAP 极端兜底。
    this.maxTurns = options.maxTurns != null ? options.maxTurns : 0
    this.maxBudgetTokens = options.maxBudgetTokens || 1_000_000
    // 压缩触发保守系数（0~1）：估算到可用窗口的该比例即触发压缩，留出 tokenization 差异余量
    this.compressSafetyFactor = options.compressSafetyFactor ?? 0.85
    // 消息条数上限：超过则强制折叠早期历史（解决本地小模型"条数过多、token不高却变傻"）
    // 0 表示不启用条数折叠（仅按 token）
    this.maxMessages = options.maxMessages || 0
    // 收尾引导触发比例（0~1，默认 0.8）：工具循环跑到 maxTurns 的该比例时，
    // 注入「停止调工具、直接总结」指令，避免模型硬撞上限后白等几十轮。
    this.wrapUpRatio = options.wrapUpRatio != null ? options.wrapUpRatio : 0.8
    // 发送前常驻工具结果截断长度（字符），防止超长工具结果堆积（0 表示不截断）
    this.maxToolResultChars = options.maxToolResultChars || 6000
    // 自动压缩总开关（默认开）：到窗口阈值自动「截断工具结果 + 折叠条数 + 摘要压缩 + 滑窗裁剪」。
    // 置 false 则整条压缩链关闭（长对话可能触发 API 超窗，仅在你确知窗口足够时关闭）。
    this.autoCompact = options.autoCompact !== false
    // 小模型适配模式（让弱模型可靠工作）：
    //   - 强化 system prompt（强制工具调用）
    //   - 敷衍输出检测 + 重试
    //   - 工具数量精简 + 意图引导
    // 默认关闭，通过 config.smallModel=true 或 --small-model 开启
    this.smallModel = options.smallModel || false
    // 小模型模式下的工具循环轮数上限（默认 8）：
    // 小模型常陷入"写一个又写一个"的无限工具循环，需更小的上限 + 收尾引导
    this.smallModelMaxTurns = options.smallModelMaxTurns || 8
    // 单次输出上限动态计算：
    //   outputRatio — 输出占窗口比例（默认 1/16），窗口越大输出越大
    //   maxOutputTokens — 输出下限（默认 4096），也可作为硬性覆盖
    this.outputRatio = options.outputRatio != null ? options.outputRatio : 1 / 16
    this.maxOutputTokens = options.maxOutputTokens || 0
    this.permissionMode = options.permissionMode || 'ask'
    this.verbose = options.verbose || false
    // API 配置 — 通用 OpenAI 兼容协议
    // 优先级: 构造参数 > LLM_API_KEY > 厂商专用 Key
    this.apiKey = options.apiKey || process.env.LLM_API_KEY || process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || process.env.QWEN_API_KEY || process.env.GLM_API_KEY || process.env.KIMI_API_KEY || ''
    // API Base — DeepSeek 为默认
    this.apiBase = options.apiBase || process.env.LLM_API_BASE || 'https://api.deepseek.com/v1'
    this.noStream = options.noStream || false
    this.costTracker = options.costTracker || null
    this.tokenBudget = options.tokenBudget || null
    this.initialMessages = options.initialMessages || []
    this.onConfirmTool = options.onConfirmTool || null  // ask 模式确认回调
    this.onAskUser = options.onAskUser || null            // AskUserQuestion 工具回调（宿主按来源分流，避免远程死锁）
    this.readline = options.readline || null              // 用于 AskUserQuestion 工具
    this.onDelta = options.onDelta || null                // 流式增量回调 {type:'text'|'reasoning', text}（供 VS Code 扩展等 UI 消费）
    // 内核事件总线（一个内核、N 个视图）。不传则引擎自建一个，
    // 这样终端/Telegram/socket 都能直接 `engine.bus.subscribe()` 接入，无需改主循环。
    this.bus = options.bus || null
    this.configStore = options.configStore || null        // 配置实例（供工具读取 web.fetch.jinaApiKey 等；可选）
    // 思考深度（v3.6.18）：{ mode:'auto'|'off'|'on', effort:'', budgetTokens:0 }
    // 由 thinking-adapter 按 provider 翻译成各家真正接受的参数（见 thinking-adapter.js）
    this.thinking = options.thinking || { mode: 'auto', effort: '', budgetTokens: 0 }
  }
}

/**
 * 查询引擎 — 核心循环
 */
export class QueryEngine {
  constructor(config) {
    this.config = config instanceof QueryEngineConfig ? config : new QueryEngineConfig(config)
    this.state = new SessionState()
    this.permissionChecker = new EnhancedPermissionChecker(this.config.permissionMode, {
      cwd: this.config.cwd,
      projectDir: this.config.cwd,
    })
    this.abortController = null
    // 事件总线：调用方未注入就自建一个（多个视图共享同一个实例的前提是注入同一个）
    this.bus = this.config.bus instanceof EventBus ? this.config.bus : new EventBus()
    this._currentReqId = null
    this.costTracker = this.config.costTracker || new CostTracker({ model: this.config.model })
    this.tokenBudget = this.config.tokenBudget || null
    // 最近一次 processMessage 是否已通过流式回调/直写把正文输出（供调用方避免重复打印 response）
    this.lastStreamed = false
  }

  /**
   * 主入口 — 处理用户消息
   * @param {string} userInput 文本
   * @param {string[]} [images] 图片 URL（data URL / http），视觉模型用
   * @param {object} [opts]
   * @param {string} [opts.reqId] 外部指定的回合 ID（socket 接入方自带的消息 ID）。
   *   为什么不总是自己生成：远程视图发消息后会收到 `queued` 和 `turn/start`，
   *   如果 reqId 由内核重新生成，客户端无法判断"这条开始事件对应我哪一条输入"，
   *   连续两条排队时只能靠时间猜 —— 气泡会挂错。
   * @param {string} [opts.source] 输入来源（cli / telegram / attach），随 turn/start 广播
   */
  async processMessage(userInput, images = [], opts = {}) {
    if (this.state.isRunning) {
      throw new Error('引擎正在运行中，请等待当前回合完成')
    }
    this.state.isRunning = true
    this.state.turnCount++
    this.lastStreamed = false  // 本轮是否已流式输出正文
    this.abortController = new AbortController()
    // 用户输入入库前剥离 ANSI（粘贴带色文本等场景，防截断切断序列后泄漏）
    const userMsg = new UserMessage(stripAnsiCodes(userInput), images)
    this.state.messages.push(userMsg)

    // M3: 自动上下文压缩 + 滑动窗口兜底
    // 新消息已 push，确保上下文 ≤ 窗口（摘要优先，超窗则从最早消息精确裁剪）
    this._ensureFitWindow()

    // 回合开始 —— 所有视图（终端/Telegram/socket attach）从这里知道"内核忙起来了"
    // reqId 优先用调用方给的（socket 客户端的消息 ID），没有才自己生成。
    const reqId = this._currentReqId = (opts.reqId || newReqId())
    this.bus?.emit('turn/start', { reqId, source: opts.source || this.config.source || null })
    this.bus?.emit('status', { state: 'running' })

    try {
      const result = await this._runToolLoop(userMsg)
      this.bus?.emit('turn/end', {
        reqId,
        text: this._clipEventText(result.response),
        turns: result.turns,
        aborted: !!result.aborted,
      })
      return result
    } catch (err) {
      // 异常也要给视图一个收尾事件，否则远程界面会永远停在"正在生成"
      this.bus?.emit('turn/end', {
        reqId,
        text: '',
        turns: this.state.turnCount,
        aborted: false,
        error: err?.message || String(err),
      })
      throw err
    } finally {
      this.state.isRunning = false
      this._currentReqId = null
      this.bus?.emit('status', { state: 'idle' })
    }
  }

  /**
   * turn/end 里携带的完整回答需要限长。
   * 理由：turn/end 会进 replay 环形缓冲（200 条），若每条都塞几百 KB 回答，
   * 光缓冲区就能吃掉上百 MB；正文已经由 stream 事件逐段给过了，
   * 这里只需要"可展示/可落盘"的量。
   */
  _clipEventText(text, max = 32000) {
    const s = text == null ? '' : String(text)
    return s.length > max ? s.slice(0, max) + '\n…（事件流中已截断）' : s
  }

  /**
   * 确保上下文 ≤ 窗口（滑动窗口语义）+ 消息条数可控
   *
   * 处理顺序（每层都基于上一层的输出，逐层收敛）：
   *   0. 发送前常驻工具结果截断（trimToolResults）—— 不依赖是否超窗，从源头压住
   *      超长工具结果噪音，防止"token 未超窗但工具结果堆积"。
   *   1. 消息条数折叠（foldHistoryByCount）—— 当 state.messages 条数超过
   *      maxMessages 时，把早期历史折叠成摘要，保留最近 N 轮完整对话。
   *      解决本地小模型"200+ 条消息、token 仅 37% 却变傻不干活"的核心问题。
   *   2. 估算当前消息总 token（实时估算，反映 state.messages 真实大小）；
   *      若未超窗 → 不做 token 层处理；
   *   3. 若超窗 → 先做摘要式压缩（保留最近 N 轮 + 早期摘要，信息量更高）。
   *   4. 摘要后仍超窗 → 滑动窗口精确裁剪兜底：从最早完整 user 回合挤出，
   *      并把被裁掉的历史压缩成摘要 system 保留，避免 AI 失忆。
   *      保证最新信息（含刚加入的用户消息）保留在末尾，上下文永不超出窗口。
   *
   * 保守化（v2.8.11）：
   *   estimateMessages 是启发式估算，可能比模型真实 token 偏少。若等到估算真正
   *   超过 hardLimit 才压缩，实际 token 可能已超模型窗口（如 400 exceed_context_size）。
   *   因此压缩触发点提前到 hardLimit × SAFETY_FACTOR（默认 85%），给 tokenization
   *   差异留余量，确保实际请求永远 ≤ 模型窗口。
   */
  /**
   * 请求固定开销（system prompt + tools schema）的 token 估算 —— 带缓存。
   *
   * 为什么必须算它：旧实现 `estimateMessages(state.messages)` **完全不含**
   * ① 基础 systemPrompt ② 每轮都要发送的 16 个工具定义（name/description/parameters）。
   * 这两部分每轮都随请求发送、且是固定量（几万 token 级别），漏算会让压缩判定
   * 系统性偏松 —— 实测事故里这正是"本地估 719k / 服务端实测 987k"偏差的一部分。
   *
   * @returns {number}
   */
  _staticOverheadTokens() {
    if (this._staticOverheadCache != null) return this._staticOverheadCache
    let total = 0
    // systemPrompt：非小模型模式下 _buildRequest 会单独作为第一条 system 发送
    if (!this.config.smallModel && this.config.systemPrompt) {
      total += estimateTokens(this.config.systemPrompt)
    }
    // tools schema：_callLLM 每轮都发送 config.tools（除空数组）
    const tools = this.config.tools
    if (Array.isArray(tools) && tools.length) {
      const schema = tools.map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }))
      total += estimateTokens(JSON.stringify(schema))
    }
    // 每条消息的结构开销已由 estimateMessageTokens 的 +10 覆盖，这里不再重复
    this._staticOverheadCache = total
    return total
  }

  /**
   * 估算「本次请求实际会送出的上下文」token —— 压缩判定与展示统一走这里。
   *
   * 口径 = (systemPrompt + tools schema + messages) × 服务端校准系数
   * 校准系数由 TokenBudget.calibrate() 用 usage.prompt_tokens 持续修正，
   * 因此换模型/换语言/换厂商都会自动收敛（不再依赖写死的字符/token 比例）。
   *
   * @param {Array} [messages] — 默认 this.state.messages
   * @returns {number}
   */
  _estimateContextTokens(messages) {
    const msgs = messages || this.state.messages || []
    const raw = this._staticOverheadTokens() + (this.tokenBudget?.estimateMessages(msgs) ?? 0)
    const factor = this.tokenBudget?.calibrationFactor ?? 1
    return Math.ceil(raw * factor)
  }

  /**
   * 压缩判定用的硬上限（窗口 - 输出预留）。
   * @returns {{ maxTokens:number, reservedForOutput:number, hardLimit:number }}
   */
  _windowLimits() {
    const maxTokens = this.tokenBudget?.maxTokens || 0
    // 输出预留取 max(配置预留, 实际输出上限)。实际输出由 _computeMaxOutputTokens 决定
    // (默认窗口 1/16,如 1M 窗口 → 62500)。若只按 reservedForOutput(默认 8192) 预留,
    // 压缩判定门槛会偏松,导致 messages + completion 实际超窗(实测 986k+62.5k > 1048576)。
    const reservedForOutput = Math.max(
      this.tokenBudget?.reservedForOutput || 0,
      this._computeMaxOutputTokens()
    )
    return { maxTokens, reservedForOutput, hardLimit: Math.max(1, maxTokens - reservedForOutput) }
  }

  _ensureFitWindow() {
    if (!this.tokenBudget) return
    // 自动压缩总开关关闭时，整条压缩链（截断/折叠/摘要/裁剪）都不介入。
    if (this.config.autoCompact === false) return

    // ---- 0) 发送前常驻工具结果截断（不依赖超窗）----
    // 避免超长工具结果持续堆积成噪音；阈值宽松（默认 6000），仅在确实过长时截断
    if (this.config.maxToolResultChars > 0) {
      const beforeTrim = this.state.messages.length
      this.state.messages = trimToolResults(this.state.messages, this.config.maxToolResultChars)
      if (this.config.verbose && this.state.messages.length !== beforeTrim) {
        console.error('[compact] 工具结果已按上限截断（常驻）')
      }
    }

    // ---- 1) 消息条数折叠（解决本地小模型"条数过多变傻"）----
    // 不依赖 token 是否超窗：只要消息条数超过 maxMessages，就折叠早期历史为摘要
    if (this.config.maxMessages > 0) {
      const { folded, messages: foldedMsgs, removed, summary } = foldHistoryByCount(this.state.messages, {
        maxMessages: this.config.maxMessages,
        keepRecentTurns: 4,
      })
      if (folded) {
        this.state.messages = foldedMsgs
        if (this.config.verbose) {
          console.error(`[compact] 消息条数 ${removed + foldedMsgs.length} > ${this.config.maxMessages}，已折叠早期 ${removed} 条为摘要（保留最近 4 轮）`)
          if (summary) console.error('[compact] 折叠摘要：\n' + summary)
        }
      }
    }

    const { maxTokens, reservedForOutput, hardLimit } = this._windowLimits()
    // 保守触发阈值：估算到可用窗口的 85% 就开始压缩，避免估算偏差导致实际超窗
    const safetyFactor = this.config.compressSafetyFactor ?? 0.85
    const triggerLimit = Math.max(1, Math.floor(hardLimit * safetyFactor))
    // ★ 口径统一：含 systemPrompt + tools schema，并应用服务端校准系数
    const est = this._estimateContextTokens(this.state.messages)
    if (est <= triggerLimit) return

    // 2) 摘要式压缩优先：用实时估算直接决定是否压缩（不再依赖滞后的 usagePercent）
    //    压缩目标也用保守阈值（而非 hardLimit），确保压缩后实际 token 远离窗口上限
    const summarized = compactMessages(this.state.messages, {
      maxTokens: Math.floor(maxTokens * 0.6),
    })
    const reEst = this._estimateContextTokens(summarized)
    if (reEst <= triggerLimit) {
      this.state.messages = summarized
      if (this.config.verbose) console.error(`[compact] Context summarized to fit token budget (${est} → ${reEst}, trigger<${triggerLimit})`)
      return
    }

    // 3) 滑动窗口精确裁剪兜底（摘要仍超窗）：裁剪时保留被裁剪历史的摘要
    const { trimmed, messages: trimmedMsgs, removed, summary } = trimToWindow(this.state.messages, {
      tokenBudget: this.tokenBudget,
      maxTokens,
      keepSummary: true,
      // 裁剪也需满足保守阈值（估算 ≤ triggerLimit），避免估算偏差导致实际超窗
      limitOverride: triggerLimit,
    })
    if (trimmed) {
      this.state.messages = trimmedMsgs
      if (this.config.verbose) {
        console.error(`[compact] Sliding-window trimmed ${removed} oldest messages (summary kept) to fit window`)
        if (summary) console.error('[compact] 被裁剪历史已压缩为摘要保留：\n' + summary)
      }
    }
  }

  /**
   * 用一次成功响应的 usage.prompt_tokens 校准本地估算系数。
   *
   * @param {object} usage — 厂商返回的 usage
   * @param {number} rawSendEstimate — 发送前本地估算（含 system+tools，未乘系数）
   */
  _calibrateFromUsage(usage, rawSendEstimate) {
    if (!usage || !this.tokenBudget) return
    const actual = usage.prompt_tokens ?? usage.input_tokens ?? 0
    if (!(actual > 0) || !(rawSendEstimate > 0)) return
    const before = this.tokenBudget.calibrationFactor
    const after = this.tokenBudget.calibrate(actual, rawSendEstimate)
    if (this.config.verbose && Math.abs(after - before) > 0.001) {
      console.error(`[calib] 服务端 ${actual.toLocaleString()} / 本地 ${rawSendEstimate.toLocaleString()} → 系数 ${after.toFixed(3)}`)
    }
  }

  /**
   * 判断错误是否为「上下文超窗」（各厂商文案不同，见下）。
   * 命中后走 _forceCompactForOverflow() 自愈，而不是把 400 直接抛给用户。
   */
  _isContextOverflowError(message) {
    if (!message) return false
    return /maximum context length|context[_\s-]?length[_\s-]?exceeded|reduce the length of the (messages|prompt)|prompt is too long|exceeds? the (maximum )?context|too many tokens|context window|上下文.{0,8}(过长|太长|超|溢)|(过长|太长).{0,8}上下文|超出.{0,8}(上下文|最大长度|模型长度)/i
      .test(String(message))
  }

  /**
   * 从厂商报错里解析「服务端实测的输入 token 数」（拿不到返回 0）。
   *
   * OpenAI 系典型文案：
   *   This model's maximum context length is 1048576 tokens. However, you requested
   *   1049296 tokens (986796 in the messages, 62500 in the completion).
   * → 优先取 "in the messages"（输入部分），其次取 "requested N tokens"（含输出）。
   */
  _parseOverflowActualTokens(message) {
    if (!message) return 0
    const s = String(message)
    const num = (x) => Number(String(x).replace(/[^\d]/g, '')) || 0
    const inMsg = s.match(/\(\s*([\d,]+)\s+in\s+the\s+messages/i)
    if (inMsg) return num(inMsg[1])
    const requested = s.match(/requested\s+([\d,]+)\s+tokens/i)
    if (requested) return num(requested[1])
    const anyMsg = s.match(/([\d,]+)\s+tokens?\s+(?:in\s+)?(?:the\s+)?messages/i)
    if (anyMsg) return num(anyMsg[1])
    return 0
  }

  /**
   * 强制压缩到「安全水位」—— API 已明确报超窗时的自愈动作。
   *
   * 与 _ensureFitWindow 的区别：这里**不再判断"需不需要"**，无条件压到
   * hardLimit 的 50%（给估算误差留一倍余量），并用服务端真值强校一次系数。
   *
   * @param {number} [actualInputTokens] — 服务端实测输入 token（0 = 未解析到）
   * @returns {{ before:number, after:number, target:number }}
   */
  _forceCompactForOverflow(actualInputTokens = 0) {
    const { maxTokens, hardLimit } = this._windowLimits()
    const before = this._estimateContextTokens(this.state.messages)
    // 目标水位：硬上限的一半（危机场景宁可多丢，也要保证请求能发出去）
    const target = Math.max(1000, Math.floor(hardLimit * 0.5))

    // ① 先用服务端真值强校系数（分母用"未经校准的本地估算"，口径含 system+tools）
    if (this.tokenBudget && actualInputTokens > 0) {
      const rawEst = this._staticOverheadTokens() + (this.tokenBudget.estimateMessages(this.state.messages) || 0)
      const factor = this.tokenBudget.calibrate(actualInputTokens, rawEst)
      if (this.config.verbose) {
        console.error(`[compact] 校准系数更新为 ${factor.toFixed(3)}（服务端实测 ${actualInputTokens.toLocaleString()} / 本地估算 ${rawEst.toLocaleString()}）`)
      }
    }
    const factor = this.tokenBudget?.calibrationFactor ?? 1
    // trimToWindow / compactMessages 内部用**未校准**估算，故目标要除以系数
    const rawTarget = Math.max(200, Math.floor(target / factor))

    // ② 摘要压缩（compactMessages 内部用未校准估算）
    const summarized = compactMessages(this.state.messages, {
      maxTokens: rawTarget,
      keepRecentTurns: 2,   // 危机场景保留更少
    })
    let after = this._estimateContextTokens(summarized)
    // ⚠️ 摘要可能"越压越大"：小窗口下 generateSummary 生成的摘要本身就比被丢弃的
    //    内容还长（实测 1,207 → 1,724）。这种情况直接放弃摘要，改用滑动窗口裁剪。
    const summaryHelps = after < before
    if (summaryHelps) {
      this.state.messages = summarized
    } else if (this.config.verbose) {
      console.error(`[compact] 摘要压缩不划算（${before.toLocaleString()} → ${after.toLocaleString()}），改用滑动窗口裁剪`)
    }
    after = this._estimateContextTokens(this.state.messages)

    // ③ 仍超 → 滑动窗口裁剪（先保留摘要，极端情况再放弃摘要）
    if (after > target) {
      for (const keepSummary of [true, false]) {
        const res = trimToWindow(this.state.messages, {
          tokenBudget: this.tokenBudget,
          maxTokens,
          keepSummary,
          limitOverride: rawTarget,
        })
        if (res?.trimmed && Array.isArray(res.messages)) {
          this.state.messages = res.messages
          after = this._estimateContextTokens(this.state.messages)
          if (after <= target) break
        }
      }
    }

    console.error(
      `[compact] ⚠️ API 报上下文超窗 → 已强制压缩 ` +
      `(${before.toLocaleString()} → ${after.toLocaleString()} tokens，目标 ≤ ${target.toLocaleString()}` +
      `${actualInputTokens ? `，服务端实测 ${actualInputTokens.toLocaleString()}` : ''})`
    )
    return { before, after, target }
  }

  /**
   * 单次请求允许的工具循环轮数上限。
   * - `maxTurns > 0` → 用它（同时启用收尾引导）
   * - `maxTurns <= 0` → **不限制**（默认），只保留 HARD_TURN_CAP 作极端兜底；
   *   真正的刹车交给「无进展检测 + /stop」
   */
  _turnLimit() {
    const m = this.config.maxTurns
    return (typeof m === 'number' && m > 0) ? m : HARD_TURN_CAP
  }

  /**
   * 收尾引导的触发轮次 —— maxTurns 的 wrapUpRatio（默认 0.8）。
   * 例：maxTurns=100 → 第 81 轮起开始提示；maxTurns=20 → 第 17 轮起。
   * `maxTurns <= 0`（不限轮数）时返回 Infinity —— 不限就不该有"快到上限了"的提示。
   */
  _wrapUpAt() {
    const m = this.config.maxTurns
    if (!(typeof m === 'number' && m > 0)) return Infinity
    const ratio = typeof this.config.wrapUpRatio === 'number' ? this.config.wrapUpRatio : 0.8
    return Math.max(1, Math.floor(m * ratio))
  }

  /** 判断错误是否为「用户主动中断」(abort) —— 兼容 fetch AbortError 与旧的中文错误 */
  _isAbortError(err) {
    if (!err) return false
    if (err.name === 'AbortError') return true
    if (this.abortController?.signal?.aborted) return true
    return String(err.message || '') === '操作已取消'
  }

  /**
   * 工具调用循环 — 核心逻辑
   *
   * LLM 回复可能包含工具调用 → 执行工具 → 把工具结果喂回 LLM
   * 最多跑 maxTurns 次；接近上限时自动注入「收尾引导」，让模型主动总结而不是硬撞上限。
   */
  async _runToolLoop(userMessage) {
    let finalResponse = ''
    // 循环收尾原因：
    //   'done'     模型给出最终答复
    //   'aborted'  用户 /stop
    //   'max-turns' 跑满用户设定的轮数上限（仅在 maxTurns>0 时可能出现）
    //   'stuck'    无进展检测判定卡死（重复同样的调用且结果不变）
    let outcome = 'running'
    let turnsUsed = 0        // 本次请求实际跑了几轮（供提示语/诊断用）
    let pendingHint = ''     // 只注入「下一轮请求体」的一次性 system 提示
    let stuckWarned = false  // 是否已就"无进展"提醒过模型
    let prevCallSig = null   // 上一轮的工具调用签名（工具名+参数）
    let prevResultSig = null // 上一轮的工具结果签名
    let sameCallStreak = 0
    let sameResultStreak = 0
    let lastToolNames = ''

    // 小模型模式：每个用户任务开始前，主动清空 LLM 端缓存一次。
    // 根因：LLM 端（llama.cpp 等自建服务）KV cache 无限叠加被塞满，是工作几轮后
    // 报 500 的真正原因（cc-node 端 context 并未到极限）。先发一个轻量清缓存请求，
    // 让本轮整个工具链从"干净缓存"起步（配合请求体里的 cache_prompt:false 双重保障）。
    await this._clearLlmCache()

    // 朴素工具循环（v2.8.11 风格）：
    // 实测结论——小模型在"朴素模式"（16 个工具全上、无引导注入、无代执行、
    // 无工具精简）下才能正常工作。v2.8.13 后我加的意图引导注入、工具精简、
    // 多步计划、框架代执行等"辅助机制"反而让模型乱套（不调用工具、瞎编内容）。
    // 因此这里【不做任何干预】，回归最原始行为：构建请求 → 调 LLM →
    // 有工具调用就执行 → 循环。
    try {
      for (let turn = 0; turn < this._turnLimit(); turn++) {
        turnsUsed = turn + 1
        // 用户 /stop → 优雅退出（不再抛异常：保证本轮消息仍走正常流程落盘）
        if (this.abortController.signal.aborted) { outcome = 'aborted'; break }

        // 发送前硬校验：工具结果可能已使上下文超窗，确保 ≤ 窗口（摘要优先 + 滑动窗口裁剪兜底）
        this._ensureFitWindow()

        const requestMessages = this._buildRequest(this.state.messages)
        // 注入 system 提示（只进「本次请求体」，不写入 state.messages —— 不污染历史、
        // 不落盘、不影响 prompt 缓存前缀）：
        //   ① 收尾引导：接近用户设定的轮数上限时，让模型主动总结而不是硬撞上限
        //   ② 无进展提醒：重复同样的操作且结果不变时，要求它换策略
        const hints = []
        if (turn >= this._wrapUpAt()) hints.push(TOOL_LOOP_WRAP_UP_HINT)
        if (pendingHint) { hints.push(pendingHint); pendingHint = '' }
        if (hints.length) {
          const firstNonSystem = requestMessages.findIndex(m => m.role !== 'system')
          requestMessages.splice(firstNonSystem < 0 ? requestMessages.length : firstNonSystem, 0, {
            role: 'system',
            content: hints.join('\n\n'),
          })
          if (this.config.verbose) {
            console.error(`[QueryEngine] 第 ${turn + 1} 轮：已注入 ${hints.length} 条 system 提示（收尾/重复检测）`)
          }
        }
        const response = await this._callLLM(requestMessages, this.state.messages)

        if (this.abortController.signal.aborted) { outcome = 'aborted'; break }

        // 没有工具调用 → 最终回复
        if (!response.toolCalls || response.toolCalls.length === 0) {
          finalResponse = response.content
          this.state.messages.push(new AssistantMessage(response.content, [], response.reasoningContent))
          outcome = 'done'
          break
        }

        // 有工具调用 → 记录 assistant 消息（含 tool_calls）
        this.state.messages.push(new AssistantMessage(response.content, response.toolCalls, response.reasoningContent))

        // 执行工具（串行；中断时仍为每个 tool_call 补齐结果，保证 OpenAI 协议不出现「孤儿 tool_calls」）
        const toolResults = await this._executeToolCalls(response.toolCalls)

        // 工具结果加入 state.messages（OpenAI 兼容格式）
        // 入库前剥离 ANSI 序列：颜色码对模型无意义（白耗 token），且会被
        // 截断逻辑（trimToolResults/compact）拦腰切断造成终端颜色泄漏
        for (const result of toolResults) {
          const cleanContent = stripAnsiCodes(result.content)
          this.state.messages.push({
            role: 'tool',
            tool_call_id: result.toolCallId,
            content: result.isError ? `[ERROR] ${cleanContent}` : cleanContent,
          })
          this.state.toolResults.set(result.toolCallId, result)
        }

        if (this.abortController.signal.aborted) { outcome = 'aborted'; break }

        // ---- 无进展检测（替代"固定轮数上限"的真正刹车）----
        // 只比较**连续**轮次（不跨轮累计），避免误伤"改了代码再跑同一个测试"这类
        // 正常节律：只要中间有任何一次不同的调用，签名就会变，连击自然清零。
        const callSig = JSON.stringify(response.toolCalls.map(tc => [tc.name, tc.input]))
        const resultSig = toolResults.map(r => String(r.content)).join('\u0000').slice(0, 4000)
        sameCallStreak = (callSig === prevCallSig) ? sameCallStreak + 1 : 1
        sameResultStreak = (resultSig === prevResultSig) ? sameResultStreak + 1 : 1
        prevCallSig = callSig
        prevResultSig = resultSig
        lastToolNames = [...new Set(response.toolCalls.map(tc => tc.name))].join(', ')

        const streak = Math.max(sameCallStreak, sameResultStreak)
        if (streak < NO_PROGRESS_WARN_STREAK) {
          stuckWarned = false   // 恢复了进展 → 允许下次再提醒
        } else if (streak >= NO_PROGRESS_BREAK_STREAK) {
          outcome = 'stuck'
          break
        } else if (!stuckWarned) {
          stuckWarned = true
          const reason = sameCallStreak >= sameResultStreak
            ? `连续 ${streak} 轮用**完全相同的参数**调用同一个工具`
            : `连续 ${streak} 轮拿到**完全相同的结果**`
          pendingHint = buildNoProgressHint(lastToolNames, reason)
          if (this.config.verbose) {
            console.error(`[QueryEngine] 无进展检测：${reason} → 已提醒模型换策略`)
          }
        }

        if (this.config.verbose) {
          console.error(`[QueryEngine] 工具循环第 ${turn + 1} 轮完成，执行了 ${toolResults.length} 个工具`)
        }
      }
    } catch (err) {
      // 用户中断可能以异常形式冒泡（fetch/sw 流被 abort → AbortError）。
      // 统一转成「优雅收尾」：不抛出，保证 state.messages 一致 + 本轮仍能落盘。
      if (this._isAbortError(err)) {
        outcome = 'aborted'
      } else {
        throw err
      }
    }

    // 循环正常耗尽（既没 break 也没中断）→ 判定为跑满上限
    if (outcome === 'running') outcome = 'max-turns'

    if (!finalResponse) {
      if (outcome === 'aborted') {
        finalResponse = '⏹️ 已按你的要求中断本轮（历史已保留，可直接继续对话）'
      } else if (outcome === 'stuck') {
        // 无进展检测：这才是"卡住了"的真正判据
        finalResponse =
          `⏹️ 已停止：连续多轮重复同样的操作且结果没有变化（${lastToolNames || '相同工具'}）。\n` +
          '原因多半是这一步在当前条件下推不动。建议换个思路，或直接告诉我你想达成什么，我来重新拆解。'
      } else if (outcome === 'max-turns') {
        finalResponse =
          `⏹️ 本轮工具调用已达 ${this.config.maxTurns} 轮上限，已暂停。\n` +
          '直接回复「继续」即可接着做；如果不想再受此限制，用 `/max-turns 0` 关闭（默认已是不限）。'
      } else {
        // outcome === 'done'：模型自己结束了这一轮（没有工具调用），但**内容是空的**
        // —— 既没有文字、也没有工具调用。
        //
        // ⚠️ 这里就是"1 分钟就报 100 轮上限"的真凶（3.6.12）：
        //   空回复让 finalResponse 保持空字符串 → 被"达到上限"分支接住 →
        //   打出 `[达到最大回合数限制 (100)，停止响应]`，**哪怕只跑了 1 轮**。
        finalResponse =
          `[模型这次没有返回任何内容（本次共 ${turnsUsed} 轮，既无文字也无工具调用）。` +
          '可以直接再发一次，或换一个模型试试。' + (this._emptyReplyHint?.() || '') + ']'
      }
    }

    return {
      response: finalResponse,
      turns: this.state.turnCount,
      toolResults: Array.from(this.state.toolResults.values()),
      aborted: outcome === 'aborted',
    }
  }

  /**
   * 动态计算单次输出上限 max_tokens
   *
   * 不再写死 4096，而是根据当前上下文窗口（/window 设置、tokenBudget.maxTokens）
   * 按比例动态得出——窗口越大，允许的单次输出越大，避免小模型写大文件时被截断。
   *
   * 公式：max_tokens = max(基础下限, 窗口 × 输出比例)
   *   - 输出比例默认 1/16（6.25%）：131072 窗口 → 8192；65536 → 4096
   *   - 下限 4096：窗口很小时也有足够输出空间
   *   - 上限不超过窗口的一半（留足输入空间，绝不超窗）
   *
   * @returns {number}
   */
  _computeMaxOutputTokens() {
    const windowSize = this.tokenBudget?.maxTokens
    // 可配置：默认输出比例 1/16，下限 4096
    const ratio = this.config.outputRatio != null ? this.config.outputRatio : 1 / 16
    const min = this.config.maxOutputTokens || 4096
    if (!windowSize || !Number.isFinite(windowSize) || windowSize <= 0) return min
    const byWindow = Math.floor(windowSize * ratio)
    // 上限 = 窗口一半，保证输入有足够空间，绝不超窗
    const cap = Math.floor(windowSize / 2)
    const maxOut = Math.min(cap, Math.max(min, byWindow))
    return maxOut
  }

  /**
   * 构建 LLM 请求消息列表 — 统一 OpenAI 兼容格式
   */
  _buildRequest(messages) {
    const request = []

    // 系统提示（朴素模式：直接用基础 system prompt，不做 cwd/工具铁律等注入——
    // 实测 v2.8.11 朴素模式能正常工作，注入反而干扰模型）
    // 小模型模式下不在此单独 push —— 基础 systemPrompt 会与 state 里的摘要 system
    // 在下方【合并成单条 system】一起 push，避免 system=2 触发 llama.cpp Jinja 报错。
    if (!this.config.smallModel && this.config.systemPrompt) {
      request.push({ role: 'system', content: this.config.systemPrompt })
    }

    // 历史消息 — 转换为 OpenAI 兼容格式
    // 关键：把所有 system 消息【收集到一起放到最前面】，而不是原样透传。
    // 原因：llama.cpp/Jinja 严格要求 system 消息必须在对话开头，中间出现 system
    // 会报 "System message must be at the beginning" (500)。
    // 折叠/压缩/引导注入可能在 state.messages 中间留下 system 摘要消息，
    // 这里统一前置，彻底规避该错误。
    const systemMsgs = []
    const bodyMsgs = []
    for (const msg of messages) {
      if (msg.role === 'system') {
        systemMsgs.push(msg)
      } else {
        bodyMsgs.push(msg)
      }
    }

    // 小模型模式：把所有 system 消息【合并成一条】放在最前面。
    // 原因：llama.cpp/Qwen 的 Jinja 模板严格要求"system 必须在开头"，但即便多条
    // system 都在开头，某些模板仍会因"多余 system 消息"报 500
    // （"System message must be at the beginning"）。
    // 折叠/压缩会在 state.messages 里留下"摘要 system"，与基础 system 叠加成
    // system=2。这里把 base systemPrompt + 全部摘要 system 拼接为单条 system，
    // 彻底消除多 system 触发 Jinja 报错的场景。
    if (this.config.smallModel) {
      const mergedSystem = []
      if (this.config.systemPrompt) mergedSystem.push(this.config.systemPrompt)
      for (const msg of systemMsgs) {
        if (msg.content) mergedSystem.push(String(msg.content))
      }
      if (mergedSystem.length) {
        request.push({ role: 'system', content: mergedSystem.join('\n\n') })
      }
    } else {
      for (const msg of systemMsgs) {
        request.push({ role: 'system', content: msg.content })
      }
    }

    for (const msg of bodyMsgs) {
      if (msg.role === 'user') {
        request.push({ role: 'user', content: this._buildUserContent(msg) })
      } else if (msg.role === 'assistant') {
        const hasToolCalls = Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0
        const rawContent = msg.content == null ? '' : msg.content
        const isEmptyContent = rawContent === '' || (Array.isArray(rawContent) && rawContent.length === 0)

        // API 约束：assistant 消息必须至少含 content 或 tool_calls。
        // 两者皆空 → 跳过，避免 400 "content or tool_calls must be set"
        // (来源:模型某轮既无文本、也无工具调用的空回复,或历史里被清空的 assistant)。
        if (!hasToolCalls && isEmptyContent) continue

        // 构建 assistant 消息基础
        const asstMsg = {
          role: 'assistant',
          // 有 tool_calls 时 content 允许为空(null);无 tool_calls 时必须是有效 content
          content: hasToolCalls ? (isEmptyContent ? null : rawContent) : rawContent,
        }

        // DeepSeek thinking mode: 必须传回 reasoning_content (tool call 场景)
        if (msg.reasoningContent) {
          asstMsg.reasoning_content = msg.reasoningContent
        }

        // tool_calls
        if (hasToolCalls) {
          asstMsg.tool_calls = msg.toolCalls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input) },
          }))
        }

        request.push(asstMsg)
      } else if (msg.role === 'tool') {
        // tool 结果消息 — 直接透传
        request.push({
          role: 'tool',
          tool_call_id: msg.tool_call_id,
          content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
        })
      }
    }

    return request
  }


  /**
   * 执行工具调用 — 两阶段策略
   * 阶段1（串行）：安全检查 + ask 模式确认（需要用户交互，必须串行）
   * 阶段2（串行）：按模型给出的顺序依次执行；中断时为剩余调用补齐占位结果
   */
  async _executeToolCalls(toolCalls) {
    const reqId = this._currentReqId
    // 阶段1：串行安全检查
    const approved = []
    for (const tc of toolCalls) {
      const permResult = await this.permissionChecker.check(tc.name, tc.input)
      if (!permResult.allowed) {
        if (permResult.requiresConfirmation && this.config.onConfirmTool) {
          // 确认请求进事件总线：任何视图（终端 / Telegram / attach）都能应答。
          // 「先答先赢」—— 谁先回应谁的结果生效，其余视图收到 confirm/resolved 收尾。
          const confirmId = newReqId('c')
          const snippet = summarizeToolResult(tc.input, 200)
          this.bus?.emit('confirm/request', {
            reqId, id: confirmId, tool: tc.name,
            question: `允许执行工具「${tc.name}」吗？`,
            snippet,
          })
          let verdict = false
          let answeredBy = null
          try {
            // 第三个参数是给宿主的上下文：confirmId 用于让远程视图"应答同一条请求"，
            // 不带它的话 attach 端根本无从对应（只能靠猜）。
            const answer = await this.config.onConfirmTool(tc.name, tc.input, { confirmId, reqId })
            // 兼容两种返回：布尔（旧）或 { answer, by }（新，便于标出谁答的）
            if (answer && typeof answer === 'object') {
              verdict = !!answer.answer
              answeredBy = answer.by || null
            } else {
              verdict = !!answer
            }
          } finally {
            this.bus?.emit('confirm/resolved', {
              reqId, id: confirmId,
              answer: verdict ? 'y' : 'n',
              by: answeredBy,
            })
          }
          if (!verdict) {
            approved.push({ tc, error: '用户未确认' })
            continue
          }
        } else {
          approved.push({ tc, error: `安全策略拒绝: ${permResult.reason || ""}` })
          continue
        }
      }

      const tool = this.config.tools.find(t => t.name === tc.name)
      if (!tool) {
        approved.push({ tc, error: `未找到工具: ${tc.name}` })
        continue
      }

      approved.push({ tc, tool })
    }

    // 阶段2：**按顺序串行**执行已批准的工具
    //
    // 为什么不用并行（历史教训，2026-10-06）：同一批工具调用之间常有**隐式依赖**——
    // 先 Write 再 Bash 跑它、先 git add 再 git commit、对同一文件先读后写……
    // 并行会打乱顺序，并让同一文件被并发读写：
    //   - 各自 readFile 到同一份旧内容 → 后写覆盖先写 → **编辑被静默丢弃**（实测 20 并发 Edit 只生效 1 个）
    //   - 两个 writeFile 并发（open('w') 截断 + 分批 write）交错 → **文件尾部残片 / 内容损坏**
    // 串行把"模型给出的顺序"原样落实，用极小的延迟代价换取正确性。
    // （Write/Edit 另带文件级串行锁 utils/file-lock.js 作为纵深防御。）
    const results = []
    const signal = this.abortController?.signal
    for (const item of approved) {
      if (item.error) {
        const r = new ToolResult(item.tc.id, item.error, true)
        r.toolName = item.tc.name
        results.push(r)
        // 未获批准 / 工具不存在 / 已被中断：同样给视图一个明确结局，
        // 否则远程界面会看到 turn/end 里凭空少了一个工具的结果。
        this.bus?.emit('tool/result', {
          reqId, id: item.tc.id, name: item.tc.name, ok: false,
          skipped: true, summary: item.error,
        })
        continue
      }
      const { tc, tool } = item

      // 用户 /stop → 剩余工具不再执行，但仍为每个 tool_call 补齐一条结果。
      // 必须补齐：OpenAI 协议要求每条带 tool_calls 的 assistant 消息，其后必须有
      // 与之一一对应的 tool 消息；否则下一轮请求直接 400（历史损坏）。
      if (signal?.aborted) {
        tc.status = 'aborted'
        const r = new ToolResult(tc.id, '[已中断：用户请求停止，此工具未执行]', true)
        r.toolName = tc.name
        results.push(r)
        continue
      }

      tc.status = 'running'
      // 工具开始/结束都进事件总线：远程视图才能显示"正在跑什么"
      this.bus?.emit('tool/call', {
        reqId, id: tc.id, name: tc.name,
        input: summarizeToolResult(tc.input, 500),
      })
      try {
        const content = await tool.handler(tc.input, {
          cwd: this.config.cwd,
          engine: this,
          readline: this.config.readline,
          signal,                       // 长任务工具（Bash 等）可用它实现即时中断
        })
        tc.status = 'done'
        const r = new ToolResult(tc.id, typeof content === 'string' ? content : JSON.stringify(content), false)
        r.toolName = tc.name
        results.push(r)
        this.bus?.emit('tool/result', {
          reqId, id: tc.id, name: tc.name, ok: true,
          summary: summarizeToolResult(content),
        })
      } catch (err) {
        tc.status = 'error'
        const r = new ToolResult(tc.id, `工具执行错误: ${err.message}`, true)
        r.toolName = tc.name
        results.push(r)
        this.bus?.emit('tool/result', {
          reqId, id: tc.id, name: tc.name, ok: false,
          summary: summarizeToolResult(`工具执行错误: ${err.message}`),
        })
      }
    }
    return results
  }

  /**
   * 清空 LLM 端缓存（小模型模式专用，best-effort）
   *
   * 背景（详见 error.log）：对话工作若干轮后报 500 的真根因是——LLM 端
   * （llama.cpp 等自建本地服务）的 KV cache / prompt cache 无限叠加被塞满。
   * cc-node 端即使 compact 后 context 变小，LLM 端旧的大 context 仍占着缓存，
   * 导致后续请求被拒（Jinja "System message must be at the beginning" 只是表象）。
   * 用户 /clear 能恢复，正是因为重置后首个请求用了全新 context，等价于清了缓存。
   *
   * 本方法在【每个用户任务开始时】主动向本地服务发一个轻量"清缓存"请求：
   *   - 对 llama.cpp：发送一个带 cache_prompt:false 的最小请求，令其丢弃旧 prompt 缓存；
   *   - 部分服务提供专用清缓存端点，通过 URL 段可拼接（best-effort，失败静默忽略）。
   * 配合主请求里的 cache_prompt:false，实现"每轮清空 LLM 缓存"，保证 context 始终正确。
   *
   * 仅当 config.smallModel 且目标是自建本地服务时生效；云端厂商跳过。
   * 任何失败都被静默吞掉（清缓存失败不应阻断主流程）。
   */
  async _clearLlmCache() {
    const apiBase = this.config.apiBase
    if (!this.config.smallModel || !isLocalLlmServer(apiBase)) return
    // 无并发保护：同一时刻仅一个 _runToolLoop 在跑（processMessage 有 isRunning 锁）
    try {
      const base = apiBase.replace(/\/+$/, '')
      // 尝试常见的本地服务清缓存端点（llama.cpp / vLLM 等，best-effort）
      const clearUrls = [
        `${base}/cache/clear`,       // 部分 llama.cpp 封装
        `${base}/reset`,             // 部分服务
      ]
      let cleared = false
      for (const url of clearUrls) {
        try {
          const ctrl = new AbortController()
          const t = setTimeout(() => ctrl.abort(), 1200)
          const res = await fetch(url, {
            method: 'POST',
            headers: { ...buildAuthHeaders(apiBase, this.config.apiKey), 'Content-Type': 'application/json' },
            body: '{}',
            signal: ctrl.signal,
          })
          clearTimeout(t)
          if (res.ok) { cleared = true; break }
        } catch { /* 端点不存在 → 继续尝试下一个 */ }
      }
      if (cleared) {
        if (this.config.verbose) console.error('[cache] 已发送清缓存请求（small-model）')
      }
      // 兜底：即便没有专用清缓存端点，主请求的 cache_prompt:false 也能保证本轮不复用缓存。
    } catch {
      // 静默失败 —— 清缓存失败不阻断主流程
    }
  }

  async _callLLM(messages, contextMessages) {
    const apiKey = this.config.apiKey
    const apiBase = this.config.apiBase

    // apiBase 指向自建本地服务（Ollama / llama.cpp / vLLM 等）时，允许缺省 apiKey
    const isLocalServer = isLocalLlmServer(apiBase)
    if (!isLocalServer && !apiKey) {
      throw new Error(
        `未设置 API Key。请设置以下环境变量之一:\n` +
        `  LLM_API_KEY=xxx (通用，推荐)\n` +
        `  DEEPSEEK_API_KEY=xxx (DeepSeek)\n` +
        `  OPENAI_API_KEY=xxx (OpenAI)\n` +
        `  QWEN_API_KEY=xxx (通义千问)\n` +
        `  GLM_API_KEY=xxx (智谱 GLM)\n` +
        `  KIMI_API_KEY=xxx (Moonshot Kimi)\n` +
        `或通过 --api-key 参数传入`
      )
    }

    if (!apiBase) {
      throw new Error(
        `未设置 API Base URL。默认使用 https://api.deepseek.com/v1 ` +
        `可通过 LLM_API_BASE 或 --api-base 参数切换其他提供商`
      )
    }

    // 构建工具定义
    // 朴素模式（v2.8.11 风格）：16 个工具全上，不做精简。
    // 实测结论——小模型在工具全给时才能正常调用；按意图精简反而让它不会调用、瞎编。
    const tools = this.config.tools.map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }))

    const useStream = !this.config.noStream
    const url = apiBase.replace(/\/+$/, '') + '/chat/completions'

    const body = {
      model: this.config.model,
      messages,
      // 根据当前上下文窗口动态计算输出上限（不再写死 4096）
      max_tokens: this._computeMaxOutputTokens(),
      ...(tools.length && { tools }),
      ...(useStream && { stream: true }),
    }

    // 小模型模式：每轮调用前【清空 LLM 端缓存】。
    // 背景（详见 error.log）：对话工作若干轮后报 500，根因不是 cc-node 的 context
    // 到极限，而是 LLM 端（llama.cpp 等自建本地服务）的 KV cache / prompt cache
    // 无限叠加被塞满。即便 cc-node 端 compact 后 context 变小（如 system=2 只剩十几条），
    // LLM 端旧的大 context 仍占着缓存，导致新请求被拒。
    // 这里显式加 cache_prompt:false，告诉本地服务【本轮不复用、不累积上一次的 prompt 缓存】，
    // 每次都全新计算 —— 等价于"每轮清空 LLM 缓存"，保证 context 始终以正确、全新的形态送入。
    // 仅对自建本地服务（llama.cpp/Ollama/vLLM 等）生效，云端厂商会忽略此字段。
    if (this.config.smallModel && isLocalLlmServer(apiBase)) {
      body.cache_prompt = false
      if (this.config.verbose) {
        console.error('[cache] small-model 模式：本轮已禁用 LLM prompt cache（cache_prompt=false，每轮清空缓存）')
      }
    }

    // [debug] 打印实际发送请求的关键信息，用于排查"模型为何不调用工具"
    if (this.config.verbose) {
      const sysCount = messages.filter(m => m.role === 'system').length
      const toolCallsInHistory = messages.filter(m => m.role === 'assistant' && m.tool_calls).length
      console.error(`[debug] → ${url}`)
      console.error(`[debug]   model=${body.model} | messages=${messages.length} (system=${sysCount}, user=${messages.filter(m=>m.role==='user').length}, assistant=${messages.filter(m=>m.role==='assistant').length}, tool=${messages.filter(m=>m.role==='tool').length}) | tools=${tools.length} | max_tokens=${body.max_tokens}`)
      console.error(`[debug]   history tool_calls=${toolCallsInHistory} | 首条=${messages[0]?.role}:${String(messages[0]?.content).slice(0,40)} | 末条=${messages[messages.length-1]?.role}:${String(messages[messages.length-1]?.content).slice(0,40)}`)
      if (tools.length) {
        console.error(`[debug]   工具名: ${tools.map(t=>t.function.name).join(', ')}`)
      } else {
        console.error(`[debug]   ⚠️ tools 为空！请求未携带工具定义，模型不会调用工具`)
      }
    }

    // 思考深度（v3.6.18）：交由 thinking-adapter 按 provider 分别构造参数。
    //
    // 旧实现是一行硬编码：`if (model.startsWith('deepseek-v')) body.thinking = {type:'disabled'}`，
    // 有两个问题：① 前缀匹配脆弱（默认模型 deepseek-flash 根本匹配不上，等于没关）；
    // ② 只处理 DeepSeek，其他厂商完全没有思考深度控制。
    // 现在：按 apiBase/model 识别 provider → 生成该厂商真正接受的参数
    // （OpenAI: reasoning_effort；DeepSeek: reasoning_effort+thinking；Kimi: low/high/max；
    //   Qwen: enable_thinking+thinking_budget；Anthropic: output_config.effort；
    //   GLM: thinking:{type}；OpenRouter: reasoning:{...}；未识别 → 不发）。
    const thinking = buildThinkingParams({
      mode: this.config.thinking?.mode ?? 'auto',
      effort: this.config.thinking?.effort ?? '',
      budgetTokens: this.config.thinking?.budgetTokens ?? 0,
      apiBase,
      model: this.config.model,
    })
    Object.assign(body, thinking.params)
    // Qwen 的 thinking_budget 与可见输出**共享** max_tokens 预算：
    // 预算不够时会「思考吃光配额 → content 为空 + finish_reason=length」。
    // 所以显式给了预算时，保证输出上限高于它。
    if (thinking.minOutputTokens > 0) {
      body.max_tokens = Math.max(body.max_tokens, thinking.minOutputTokens + 1024)
    }
    if (this.config.verbose) {
      console.error(`[thinking] provider=${thinking.provider} mode=${thinking.mode} ${Object.keys(thinking.params).length ? JSON.stringify(thinking.params) : '(不发参数)'}${thinking.note ? ' — ' + thinking.note : ''}`)
    }

    // apiBase 是用户显式指定的配置（--api-base），不是外部输入，跳过 SSRF 检查
    // SSRF 防护仅适用于 web-fetch/web-search 等工具发起的请求
    const maxRetries = 3
    // Jitter 退避 — 指数退避 + 随机 ±50%，防止惊群效应
    const retryDelay = (baseMs, attempt) => {
      const ms = baseMs * Math.pow(2, attempt - 1)
      const jitter = ms * (0.5 + Math.random() * 0.5) // 50%-100% of base
      return Math.round(jitter)
    }
    let lastError = null
    let strippedImagesOnce = false // 图片降级只做一次，防止剥离后仍报同样错误时死循环
    let strippedThinkingOnce = false // 思考参数被拒时剥离重试（同样只做一次）
    let compactedForOverflow = false // 超窗自愈只做一次，防止压缩后仍超窗时死循环
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (this.abortController?.signal?.aborted) {
          throw new Error('请求已取消')
        }

        // 记录「本次实际发送」的本地估算（校准基准；含 system+tools，未乘校准系数）
        const rawSendEstimate = this._staticOverheadTokens() +
          (this.tokenBudget?.estimateMessages(messages) ?? 0)

        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...buildAuthHeaders(apiBase, apiKey),
          },
          body: JSON.stringify(body),
          signal: this.abortController?.signal,
        })

        if (!response.ok) {
          const errText = await response.text()
          // 429/503 可重试
          if ((response.status === 429 || response.status === 503) && attempt < maxRetries) {
            const waitMs = retryDelay(response.status === 429 ? 2000 : 1000, attempt)
            if (this.config.verbose) {
              console.error(`[retry] API ${response.status}, waiting ${waitMs}ms (attempt ${attempt}/${maxRetries})`)
            }
            await new Promise(r => setTimeout(r, waitMs))
            continue
          }
          // ★ 上下文超窗自愈（v3.6.20）
          // 本地估算是启发式的，必然存在偏差（实测低估 27%）；一旦偏差导致实际请求超窗，
          // 厂商会回 400 并附上**真实 token 数**。这里不再把 400 甩给用户，而是：
          //   解析真值 → 强校校准系数 → 强制压缩到安全水位 → 重建请求体 → 重试一次。
          const apiErr = `API 错误 ${response.status}: ${errText}`
          if (!compactedForOverflow && this.tokenBudget && this._isContextOverflowError(errText)) {
            compactedForOverflow = true
            const actual = this._parseOverflowActualTokens(errText)
            this._forceCompactForOverflow(actual)
            // 重建请求体（历史已变），并重算输出上限
            messages = this._buildRequest(this.state.messages)
            body.messages = messages
            body.max_tokens = this._computeMaxOutputTokens()
            continue
          }
          throw new Error(apiErr)
        }

        // 流式或非流式处理
        if (useStream && response.body) {
          const result = await this._handleStreamResponse(response)
          this._lastUsage = result.usage || null   // 供空回复诊断（finish_reason / reasoning_tokens）
          if (result.usage && this.costTracker) {
            this.costTracker.recordUsage(result.usage)
          }
          if (this.tokenBudget && result.usage) {
            this.tokenBudget.recordUsage(result.usage)
            this._calibrateFromUsage(result.usage, rawSendEstimate)
          }
          return result
        } else {
          const data = await response.json()
          const result = parseNonStreamResponse(data)
          this._lastUsage = result.usage || null   // 供空回复诊断
          if (result.usage && this.costTracker) {
            this.costTracker.recordUsage(result.usage)
          }
          if (this.tokenBudget && result.usage) {
            this.tokenBudget.recordUsage(result.usage)
            this._calibrateFromUsage(result.usage, rawSendEstimate)
          }
          return result
        }
      } catch (err) {
        lastError = err
        // 兜底：纯文字模型收到历史中的图片时，API 会以 4xx 拒绝。
        // 典型场景：先用多模态模型发图识别，再切回纯文字模型 —— 历史图片每轮都随
        // 请求发送，之后**所有消息都被拒**。这里自动剥离【本次请求体 + 会话历史】中的
        // 全部图片并立即重试，无需用户 /clear。
        //
        // v3.6.14 放宽判据（原来只认 "image|vision|multimodal|visual|图片"，太窄）：
        //   各家的报错文案五花八门，漏判就会表现成"换了纯文字模型后每条消息都报错"。
        //   补充实测常见的几种说法：
        //     · "invalid content type"（OpenAI 系）
        //     · "...expected a string"（DeepSeek 反序列化：content 是数组而非字符串）
        //     · "该模型不支持图像输入"（中文，"图像"≠"图片"，旧正则匹配不到）
        //   ⚠️ 注意**不能**写成"只要是 4xx 且有图就剥离"——那会把 API Key 错误之类的
        //   无关错误也当成图片问题，白白重试一次，并**误删用户历史里的图片**。
        const errMentionsImage =
          /image|vision|multimodal|visual|图片|图像|视觉|attachment|content[\s._-]?type|invalid[\s._-]*content|expected[\s._-]*a[\s._-]*string/i
            .test(err.message)
        if (!strippedImagesOnce && err.name !== 'AbortError' && errMentionsImage) {
          strippedImagesOnce = true
          const nReq = this._stripImageParts(messages)       // 本次请求体（_buildRequest 产物）
          const nHist = this.stripImagesFromHistory()        // 会话历史（state.messages）
          if (nReq + nHist > 0) {
            console.error(`[fallback] 当前模型不接受图片 → 已从会话历史移除 ${nReq + nHist} 张图片并重试`)
            continue
          }
        }
        // 思考参数被服务端拒绝 → 剥掉参数重试一次。
        //
        // 背景：thinking-adapter 是按厂商文档构造参数的，但"OpenAI 兼容"的实现五花八门，
        // 网关（中转/代理）可能不认 `reasoning_effort` / `thinking` / `enable_thinking`，
        // 直接回 400。此时**不能**让整个会话不可用 —— 剥掉参数退回"服务端默认"即可。
        // 只做一次（strippedThinkingOnce），避免剥离后仍报错时反复重试。
        const thinkingKeys = ['reasoning_effort', 'thinking', 'enable_thinking', 'thinking_budget', 'output_config', 'reasoning']
        const hasThinkingParams = thinkingKeys.some(k => k in body)
        if (!strippedThinkingOnce && err.name !== 'AbortError' && hasThinkingParams
            && /400|invalid|unsupported|unknown|unrecognized|not support/i.test(err.message)) {
          strippedThinkingOnce = true
          const present = thinkingKeys.filter(k => k in body)
          for (const k of present) delete body[k]
          console.error(`[fallback] 服务端不接受思考参数（${present.join('/')}）→ 已剥离并重试。如需固定此行为：/thinking auto`)
          continue
        }
        // 网络错误重试
        if (err.name !== 'AbortError' && attempt < maxRetries && !err.message.startsWith('API 错误')) {
          const waitMs = retryDelay(1000, attempt)
          if (this.config.verbose) {
            console.error(`[retry] Network error: ${err.message}, waiting ${waitMs}ms (attempt ${attempt}/${maxRetries})`)
          }
          await new Promise(r => setTimeout(r, waitMs))
          continue
        }
        throw err
      }
    }
    throw lastError
  }

  /**
   * 空回复的**原因提示**（v3.6.18）。
   *
   * 为什么需要：空回复（无文字无工具调用）最常见的真因是
   * **思考 token 吃光了 max_tokens 预算** —— 此时 finish_reason === 'length'，
   * 且 reasoning_tokens ≈ completion_tokens，可见输出为 0。
   * 只说"模型没返回任何内容"会让用户以为是模型抽风；把这两个信号带出来，
   * 用户一眼就能判断该「/thinking off 或调小深度」还是「换个模型」。
   *
   * @returns {string} 形如 " ⚠️ finish_reason=length 且思考占 250/300 token —— 多半是思考吃光了输出预算，可试 /thinking off 或降低深度。"；无信号时返回 ''
   */
  _emptyReplyHint() {
    const u = this._lastUsage
    if (!u) return ''
    const fr = u.finish_reason
    const rt = u.reasoning_tokens || 0
    const out = u.output_tokens || u.completion_tokens || 0
    if (fr === 'length' && rt > 0 && rt >= out * 0.8) {
      return ` ⚠️ finish_reason=length，且思考占 ${rt}/${out} token —— 多半是思考吃光了输出预算，可试 /thinking off 或降低深度（/thinking on low）。`
    }
    if (fr === 'length') {
      return ` ⚠️ finish_reason=length —— 输出被 max_tokens 截断，可用 /window 或 /max-turns 检查输出上限。`
    }
    if (rt > 0) {
      return ` （本次思考 ${rt} token，finish_reason=${fr || '未上报'}）`
    }
    return ''
  }

  /**
   * 处理流式响应 — 逐 token 输出
   */
  async _handleStreamResponse(response) {
    const result = { content: '', reasoningContent: '', toolCalls: [], usage: {} }
    let currentText = ''

    try {
      for await (const event of parseStream(response)) {
        if (event.type === 'text') {
          // 记录已流式输出正文（供调用方避免重复打印最终 response）
          if (event.text) this.lastStreamed = true
          // ① 事件总线：所有视图（终端/TG/socket）统一从这里拿增量
          this.bus?.emit('stream', { reqId: this._currentReqId, kind: 'text', text: event.text })
          // ② 兼容旧 onDelta 回调（VS Code 扩展等既有接入方）
          // 实时输出（有 onDelta 回调时交给调用方；否则写终端）
          // 终端直写前剥离 ANSI：工具输出里的颜色序列（npm warning 黄色等）若被
          // 截断/复述后只有开启无复位，终端颜色会永久卡死（整屏变黄）
          if (typeof this.config.onDelta === 'function') {
            this.config.onDelta({ type: 'text', text: event.text })
          } else {
            process.stdout.write(stripAnsiCodes(event.text))
          }
          currentText += event.text
        } else if (event.type === 'reasoning') {
          // 推理内容（thinking）同样支持回调；无 onDelta 时在终端展示思维链
          this.bus?.emit('stream', { reqId: this._currentReqId, kind: 'reasoning', text: event.text })
          if (typeof this.config.onDelta === 'function') {
            this.config.onDelta({ type: 'reasoning', text: event.text })
          } else if (this.config.verbose) {
            process.stdout.write(stripAnsiCodes(event.text))
          }
        } else if (event.type === 'tool_use') {
          // 收集工具调用
          result.toolCalls.push(new ToolCall(
            event.toolCall.id,
            event.toolCall.name,
            event.toolCall.input
          ))
        } else if (event.type === 'done') {
          result.content = event.result.content || currentText
          result.reasoningContent = event.result.reasoningContent || result.reasoningContent
          result.toolCalls = event.result.toolCalls?.map(tc =>
            new ToolCall(tc.id, tc.name, tc.input)
          ) || result.toolCalls
          result.usage = event.result.usage || {}
        }
      }
    } catch (err) {
      // 流中断 — 返回已收到的内容
      result.content = currentText || ''
      if (this.config.verbose) {
        console.error(`[stream] interrupted: ${err.message}`)
      }
    }

    // 流式输出后换行（仅终端直写模式；onDelta 回调模式由调用方处理，避免污染协议流）
    if (currentText && typeof this.config.onDelta !== 'function') process.stdout.write('\n')

    return result
  }

  /** 格式化内容 */
  _formatContent(content) {
    if (content == null) return ''
    if (typeof content === 'string') return content
    if (typeof content === 'object') return JSON.stringify(content)
    return String(content)
  }

  /**
   * 构建用户消息 content（支持多模态：文本 + 图片）
   * 有 images 时输出 OpenAI 兼容 content 数组；否则纯文本（向后兼容）
   */
  _buildUserContent(msg) {
    const text = this._formatContent(msg.content)
    const images = msg.images && msg.images.length ? msg.images : []
    if (images.length === 0) return text
    const parts = []
    if (text) parts.push({ type: 'text', text })
    for (const url of images) {
      parts.push({ type: 'image_url', image_url: { url } })
    }
    return parts
  }

  /**
   * 从 OpenAI 兼容消息数组中剥离所有 image_url 内容。
   * content 数组剥离图片 part 后，若只剩单个 text part 则简化回纯字符串
   * （部分纯文字 API 对数组格式的兼容性差，字符串最稳）。
   * @param {Array} messages — 消息数组（原地修改）
   * @returns {number} 移除的图片数
   */
  _stripImageParts(messages) {
    let removed = 0
    for (const m of messages || []) {
      if (!m || !Array.isArray(m.content)) continue
      const kept = m.content.filter(p => !(p && p.type === 'image_url'))
      if (kept.length === m.content.length) continue
      removed += m.content.length - kept.length
      m.content = kept.length === 1 && kept[0] && kept[0].type === 'text' ? kept[0].text : kept
    }
    return removed
  }

  /**
   * 剥离会话历史中的所有图片（切换到可能不支持视觉的模型时调用）。
   * 处理两处图片来源：
   *   1. user 消息的 images 字段（_buildUserContent 构建请求时转成 image_url part）
   *   2. 已序列化为 content 数组的 image_url part（兼容任何形式的请求构建）
   * @returns {number} 移除的图片张数
   */
  stripImagesFromHistory() {
    let removed = 0
    for (const m of this.state.messages || []) {
      if (m && Array.isArray(m.images) && m.images.length) {
        removed += m.images.length
        m.images = []
      }
    }
    removed += this._stripImageParts(this.state.messages)
    return removed
  }

  /** 取消当前运行 */
  abort() {
    this.abortController?.abort()
  }

  /** 重置引擎状态 */
  reset() {
    this.state = new SessionState()
  }
}
