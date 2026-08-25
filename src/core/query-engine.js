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
import { compactMessages, trimToWindow } from './compact.js'
import { CostTracker } from './cost-tracker.js'
import { EnhancedPermissionChecker } from '../security/enhanced-permission.js'
import { isLocalLlmServer, buildAuthHeaders } from '../utils/index.js'

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
    this.maxTurns = options.maxTurns || 100
    this.maxBudgetTokens = options.maxBudgetTokens || 1_000_000
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
    this.configStore = options.configStore || null        // 配置实例（供工具读取 web.fetch.jinaApiKey 等；可选）
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
    this.costTracker = this.config.costTracker || new CostTracker({ model: this.config.model })
    this.tokenBudget = this.config.tokenBudget || null
    // 最近一次 processMessage 是否已通过流式回调/直写把正文输出（供调用方避免重复打印 response）
    this.lastStreamed = false
  }

  /**
   * 主入口 — 处理用户消息
   * @param {string} userInput 文本
   * @param {string[]} [images] 图片 URL（data URL / http），视觉模型用
   */
  async processMessage(userInput, images = []) {
    if (this.state.isRunning) {
      throw new Error('引擎正在运行中，请等待当前回合完成')
    }
    this.state.isRunning = true
    this.state.turnCount++
    this.lastStreamed = false  // 本轮是否已流式输出正文
    this.abortController = new AbortController()
    const userMsg = new UserMessage(userInput, images)
    this.state.messages.push(userMsg)

    // M3: 自动上下文压缩 + 滑动窗口兜底
    // 新消息已 push，确保上下文 ≤ 窗口（摘要优先，超窗则从最早消息精确裁剪）
    this._ensureFitWindow()

    try {
      const result = await this._runToolLoop(userMsg)
      return result
    } finally {
      this.state.isRunning = false
    }
  }

  /**
   * 确保上下文 ≤ 窗口（滑动窗口语义）
   *
   * 处理顺序：
   *   1. 估算当前消息总 token（实时估算，反映 state.messages 真实大小）；
   *   2. 若未超窗 → 不做任何事；
   *   3. 若超窗 → 先做摘要式压缩（保留最近 N 轮 + 早期摘要，信息量更高）。
   *      注意：这里直接用实时 token 估算判断是否压缩，而非依赖滞后的
   *      usagePercent（那会导致"判定超窗但压缩永不触发"）。
   *   4. 摘要后仍超窗 → 滑动窗口精确裁剪兜底：从最早完整 user 回合挤出，
   *      并把被裁掉的历史压缩成摘要 system 保留，避免 AI 失忆。
   *      保证最新信息（含刚加入的用户消息）保留在末尾，上下文永不超出窗口。
   */
  _ensureFitWindow() {
    if (!this.tokenBudget) return
    const limit = this.tokenBudget.maxTokens - this.tokenBudget.reservedForOutput
    const est = this.tokenBudget.estimateMessages(this.state.messages)
    if (est <= limit) return

    // 1) 摘要式压缩优先：用实时估算直接决定是否压缩（不再依赖滞后的 usagePercent）
    const summarized = compactMessages(this.state.messages, {
      maxTokens: Math.floor(this.tokenBudget.maxTokens * 0.6),
    })
    const reEst = this.tokenBudget.estimateMessages(summarized)
    if (reEst <= limit) {
      this.state.messages = summarized
      if (this.config.verbose) console.error('[compact] Context summarized to fit token budget')
      return
    }

    // 2) 滑动窗口精确裁剪兜底（摘要仍超窗）：裁剪时保留被裁剪历史的摘要
    const { trimmed, messages: trimmedMsgs, removed, summary } = trimToWindow(this.state.messages, {
      tokenBudget: this.tokenBudget,
      maxTokens: this.tokenBudget.maxTokens,
      keepSummary: true,
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
   * 工具调用循环 — 核心逻辑
   *
   * LLM 回复可能包含工具调用 → 执行工具 → 把工具结果喂回 LLM
   * 最多跑 maxTurns 次
   */
  async _runToolLoop(userMessage) {
    let finalResponse = ''

    for (let turn = 0; turn < this.config.maxTurns; turn++) {
      // 发送前硬校验：工具结果可能已使上下文超窗，确保 ≤ 窗口（摘要优先 + 滑动窗口裁剪兜底）
      this._ensureFitWindow()

      const requestMessages = this._buildRequest(this.state.messages)
      const response = await this._callLLM(requestMessages, this.state.messages)

      if (this.abortController.signal.aborted) {
        throw new Error('操作已取消')
      }

      // 没有工具调用 → 最终回复
      if (!response.toolCalls || response.toolCalls.length === 0) {
        finalResponse = response.content
        this.state.messages.push(new AssistantMessage(response.content, [], response.reasoningContent))
        break
      }

      // 有工具调用 → 记录 assistant 消息（含 tool_calls）
      this.state.messages.push(new AssistantMessage(response.content, response.toolCalls, response.reasoningContent))

      // 执行工具
      const toolResults = await this._executeToolCalls(response.toolCalls)

      // 工具结果加入 state.messages（OpenAI 兼容格式）
      for (const result of toolResults) {
        this.state.messages.push({
          role: 'tool',
          tool_call_id: result.toolCallId,
          content: result.isError ? `[ERROR] ${result.content}` : result.content,
        })
        this.state.toolResults.set(result.toolCallId, result)
      }

      if (this.config.verbose) {
        console.error(`[QueryEngine] 工具循环第 ${turn + 1} 轮完成，执行了 ${toolResults.length} 个工具`)
      }
    }

    if (!finalResponse && this.state.turnCount >= this.config.maxTurns) {
      finalResponse = `[达到最大回合数限制 (${this.config.maxTurns})，停止响应]`
    }

    return {
      response: finalResponse,
      turns: this.state.turnCount,
      toolResults: Array.from(this.state.toolResults.values()),
    }
  }

  /**
   * 构建 LLM 请求消息列表 — 统一 OpenAI 兼容格式
   */
  _buildRequest(messages) {
    const request = []

    // 系统提示
    if (this.config.systemPrompt) {
      request.push({ role: 'system', content: this.config.systemPrompt })
    }

    // 历史消息 — 转换为 OpenAI 兼容格式
    for (const msg of messages) {
      if (msg.role === 'system') {
        request.push({ role: 'system', content: msg.content })
      } else if (msg.role === 'user') {
        request.push({ role: 'user', content: this._buildUserContent(msg) })
      } else if (msg.role === 'assistant') {
        // 构建 assistant 消息基础
        const asstMsg = {
          role: 'assistant',
          content: msg.content || null,
        }

        // DeepSeek thinking mode: 必须传回 reasoning_content (tool call 场景)
        if (msg.reasoningContent) {
          asstMsg.reasoning_content = msg.reasoningContent
        }

        // tool_calls
        if (msg.toolCalls && msg.toolCalls.length > 0) {
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
   * 阶段2（并行）：批准后的工具并行执行，互不依赖的工具同时跑
   */
  async _executeToolCalls(toolCalls) {
    // 阶段1：串行安全检查
    const approved = []
    for (const tc of toolCalls) {
      const permResult = await this.permissionChecker.check(tc.name, tc.input)
      if (!permResult.allowed) {
        if (permResult.requiresConfirmation && this.config.onConfirmTool) {
          const confirmed = await this.config.onConfirmTool(tc.name, tc.input)
          if (!confirmed) {
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

    // 阶段2：并行执行已批准的工具
    const execPromises = approved.map(async (item) => {
      if (item.error) {
        const r = new ToolResult(item.tc.id, item.error, true)
        r.toolName = item.tc.name
        return r
      }
      const { tc, tool } = item
      tc.status = 'running'
      try {
        const content = await tool.handler(tc.input, { cwd: this.config.cwd, engine: this, readline: this.config.readline })
        tc.status = 'done'
        const r = new ToolResult(tc.id, typeof content === 'string' ? content : JSON.stringify(content), false)
        r.toolName = tc.name
        return r
      } catch (err) {
        tc.status = 'error'
        const r = new ToolResult(tc.id, `工具执行错误: ${err.message}`, true)
        r.toolName = tc.name
        return r
      }
    })

    const results = await Promise.all(execPromises)
    return results
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
    const tools = this.config.tools.map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }))

    const useStream = !this.config.noStream
    const modelLower = this.config.model.toLowerCase()

    const body = {
      model: this.config.model,
      messages,
      max_tokens: 4096,
      ...(tools.length && { tools }),
      ...(useStream && { stream: true }),
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

    // DeepSeek V4: 默认启用 thinking mode → 要求回传 reasoning_content
    // 这里显式关闭，避免 tool call 场景下的 400 错误
    // thinking 参数是 DeepSeek 私有扩展，直接放在 body 顶层
    if (modelLower.startsWith('deepseek-v')) {
      body.thinking = { type: 'disabled' }
    }

    const url = apiBase.replace(/\/+$/, '') + '/chat/completions'

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
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (this.abortController?.signal?.aborted) {
          throw new Error('请求已取消')
        }

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
          throw new Error(`API 错误 ${response.status}: ${errText}`)
        }

        // 流式或非流式处理
        if (useStream && response.body) {
          const result = await this._handleStreamResponse(response)
          if (result.usage && this.costTracker) {
            this.costTracker.recordUsage(result.usage)
          }
          if (this.tokenBudget && result.usage) {
            this.tokenBudget.recordUsage(result.usage)
          }
          return result
        } else {
          const data = await response.json()
          const result = parseNonStreamResponse(data)
          if (result.usage && this.costTracker) {
            this.costTracker.recordUsage(result.usage)
          }
          if (this.tokenBudget && result.usage) {
            this.tokenBudget.recordUsage(result.usage)
          }
          return result
        }
      } catch (err) {
        lastError = err
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
          // 实时输出（有 onDelta 回调时交给调用方，如 VS Code 扩展；否则写终端）
          if (typeof this.config.onDelta === 'function') {
            this.config.onDelta({ type: 'text', text: event.text })
          } else {
            process.stdout.write(event.text)
          }
          currentText += event.text
        } else if (event.type === 'reasoning') {
          // 推理内容（thinking）同样支持回调；无 onDelta 时在终端展示思维链
          if (typeof this.config.onDelta === 'function') {
            this.config.onDelta({ type: 'reasoning', text: event.text })
          } else if (this.config.verbose) {
            process.stdout.write(event.text)
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

  /** 取消当前运行 */
  abort() {
    this.abortController?.abort()
  }

  /** 重置引擎状态 */
  reset() {
    this.state = new SessionState()
  }
}
