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
import { autoCompact } from './compact.js'
import { CostTracker } from './cost-tracker.js'
import { EnhancedPermissionChecker } from '../security/enhanced-permission.js'
import { checkHostSafety } from '../security/ssrf-guard.js'

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
    this.readline = options.readline || null              // 用于 AskUserQuestion 工具
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
  }

  /**
   * 主入口 — 处理用户消息
   */
  async processMessage(userInput) {
    if (this.state.isRunning) {
      throw new Error('引擎正在运行中，请等待当前回合完成')
    }
    this.state.isRunning = true
    this.state.turnCount++
    this.abortController = new AbortController()
    const userMsg = new UserMessage(userInput)
    this.state.messages.push(userMsg)

    // M3: 自动上下文压缩
    if (this.tokenBudget) {
      const { compacted, messages } = autoCompact(this.state.messages, this.tokenBudget)
      if (compacted) {
        this.state.messages = messages
        if (this.config.verbose) console.error('[compact] Context compressed to fit token budget')
      }
    }

    try {
      const result = await this._runToolLoop(userMsg)
      return result
    } finally {
      this.state.isRunning = false
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
        request.push({ role: 'user', content: this._formatContent(msg.content) })
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

    if (!apiKey) {
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

    // DeepSeek V4: 默认启用 thinking mode → 要求回传 reasoning_content
    // 这里显式关闭，避免 tool call 场景下的 400 错误
    // thinking 参数是 DeepSeek 私有扩展，直接放在 body 顶层
    if (modelLower.startsWith('deepseek-v')) {
      body.thinking = { type: 'disabled' }
    }

    const url = apiBase.replace(/\/+$/, '') + '/chat/completions'

    // H3 修复：SSRF 防护 — 在 fetch 之前检查 API 主机名
    try {
      const parsedUrl = new URL(url)
      const hostResult = await checkHostSafety(parsedUrl.hostname)
      if (!hostResult.allowed) {
        throw new Error(`SSRF blocked: ${hostResult.reason}`)
      }
    } catch (err) {
      if (err.message.startsWith('SSRF blocked:')) {
        throw err
      }
      // URL 解析错误忽略，让 fetch 自己处理
    }

    // 带重试的 fetch
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
            'Authorization': `Bearer ${apiKey}`,
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
    const result = { content: '', toolCalls: [], usage: {} }
    let currentText = ''

    try {
      for await (const event of parseStream(response)) {
        if (event.type === 'text') {
          // 实时输出到终端
          process.stdout.write(event.text)
          currentText += event.text
        } else if (event.type === 'tool_use') {
          // 收集工具调用
          result.toolCalls.push(new ToolCall(
            event.toolCall.id,
            event.toolCall.name,
            event.toolCall.input
          ))
        } else if (event.type === 'done') {
          result.content = event.result.content || currentText
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

    // 流式输出后换行
    if (currentText) process.stdout.write('\n')

    return result
  }

  /** 格式化内容 */
  _formatContent(content) {
    if (content == null) return ''
    if (typeof content === 'string') return content
    if (typeof content === 'object') return JSON.stringify(content)
    return String(content)
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
