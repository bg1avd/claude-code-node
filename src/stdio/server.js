/**
 * server.js — cc-node --stdio 服务器（JSON-RPC 2.0 over NDJSON）
 *
 * 协议：docs/stdio-protocol.md v1.0（详见 cc-node-bridge 项目）
 *
 * 职责：
 *  - 通过 stdin 接收 JSON-RPC 请求，stdout 返回响应与事件（每行一个 JSON）
 *  - 引擎子进程形态：每会话一个进程（由桥接层 spawn 本模块）
 *  - remote 工具模式：LLM 产生工具调用 → 发 event/toolCall → 挂起等待
 *    toolCall/result → 结果喂回 LLM
 *
 * 用法：
 *   cc-node --stdio [--api-base ...] [--model ...] [--api-key ...]
 *   node src/stdio/server.js 等同
 */

import { createInterface } from 'readline'
import { randomUUID } from 'crypto'
import { homedir } from 'os'
import { join, resolve } from 'path'
import {
  QueryEngine,
  QueryEngineConfig,
  SessionManager,
} from '../core/index.js'
import { CostTracker } from '../core/cost-tracker.js'
import { builtinTools } from '../tools/index.js'
import { isLocalLlmServer } from '../utils/index.js'

const DEFAULT_SYSTEM_PROMPT =
  'You are cc-node, an AI coding assistant running as a stdio server. ' +
  'Tools are executed by the client (VS Code / Web / Telegram). ' +
  'When you call tools, the client performs them and returns results.'

export class StdioServer {
  constructor(options = {}) {
    this.cliArgs = options.cliArgs || {}
    this.config = {
      apiBase: this.cliArgs.apiBase || process.env.LLM_API_BASE || '',
      apiKey: this.cliArgs.apiKey || process.env.LLM_API_KEY || '',
      model: this.cliArgs.model || '',
      systemPrompt: this.cliArgs.systemPrompt || DEFAULT_SYSTEM_PROMPT,
      maxTurns: this.cliArgs.maxTurns || 50,
    }
    this.initialized = false
    this.running = false
    this.aborted = false
    this.engine = null
    this.toolDefs = null          // 客户端 tools/define 下发（null = 用内置定义）
    this.pendingToolCalls = new Map() // toolCallId → resolve({content, isError})
    this.sessionManager = null
    this.currentSession = null
    this.shuttingDown = false
  }

  // ─────────────────────────── 协议基础 ───────────────────────────

  start() {
    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
    this._chain = Promise.resolve()
    rl.on('line', (line) => {
      if (!line.trim()) return
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        this._sendError(null, -32700, '解析错误: 无效 JSON')
        return
      }
      // 串行处理：保证响应/事件顺序（协议要求按序）
      this._chain = this._chain.then(() => this._dispatch(msg)).catch((e) => {
        console.error(`[cc-node-stdio] 处理异常: ${e.message}`)
      })
    })
    rl.on('close', () => {
      this._shutdownNow()
    })
    // stdout 只用于协议，日志走 stderr
    console.error('[cc-node-stdio] 服务器已启动，等待请求…')
  }

  async _dispatch(msg) {
    const { id, method, params } = msg

    // 通知（无 id）
    if (id === undefined || id === null) {
      if (method === 'abort') this._abort()
      else if (method === 'shutdown') this._shutdownNow()
      // 其他通知忽略
      return
    }

    try {
      switch (method) {
        case 'initialize':
          this._sendResponse(id, await this._initialize(params))
          break
        case 'chat':
          this._sendResponse(id, await this._chat(params))
          break
        case 'toolCall/result':
          this._sendResponse(id, await this._toolCallResult(params))
          break
        case 'tools/define':
          this._sendResponse(id, await this._toolsDefine(params))
          break
        case 'session/new':
          this._sendResponse(id, await this._sessionNew(params))
          break
        case 'session/load':
          this._sendResponse(id, await this._sessionLoad(params))
          break
        case 'session/list':
          this._sendResponse(id, await this._sessionList())
          break
        case 'session/delete':
          this._sendResponse(id, await this._sessionDelete(params))
          break
        case 'config/get':
          this._sendResponse(id, this._configGet())
          break
        case 'config/set':
          this._sendResponse(id, await this._configSet(params))
          break
        case 'shutdown':
          this._sendResponse(id, { ok: true })
          this._shutdownNow()
          break
        default:
          this._sendError(id, -32601, `方法不存在: ${method}`)
      }
    } catch (err) {
      this._sendError(id, err.code || -32603, err.message)
    }
  }

  _sendResponse(id, result) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
  }

  _sendError(id, code, message) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n')
  }

  _sendEvent(method, params) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  }

  // ─────────────────────────── 方法实现 ───────────────────────────

  async _initialize(params = {}) {
    this.initialized = true
    const clientInfo = params.clientInfo || {}
    console.error(`[cc-node-stdio] 客户端接入: ${clientInfo.name || 'unknown'} ${clientInfo.version || ''}`)
    return {
      serverInfo: { name: 'cc-node', version: '2.6.2' },
      capabilities: {
        toolExecution: 'remote',
        streaming: true,
        images: true,
        modes: ['plan', 'code'],
        sessions: true,
        abort: true,
      },
    }
  }

  async _chat(params = {}) {
    if (!this.initialized) throw this._err(3, '未初始化，先发送 initialize')
    if (this.running) throw this._err(1, '引擎正在运行中')
    const text = params.text
    if (typeof text !== 'string' || !text.trim()) throw this._err(-32602, '缺少 text 参数')

    // 模式切换（若提供）
    if (params.mode && params.mode !== this._mode) {
      this._mode = params.mode
      this._rebuildEngine()
      this._sendEvent('event/mode', { mode: this._mode })
    }

    this.running = true
    this.aborted = false
    this._sendEvent('event/status', { state: 'running' })

    // 异步执行（不阻塞响应）
    this._runChat(text, params.images || [], params.sessionId).catch((err) => {
      this._sendEvent('event/error', { message: err.message })
      this.running = false
      this._sendEvent('event/status', { state: 'idle' })
    })

    return { accepted: true }
  }

  async _runChat(text, images, sessionId) {
    try {
      const engine = await this._getEngine()
      const result = await engine.processMessage(text, images)
      if (this.aborted) {
        this._sendEvent('event/done', { content: '', aborted: true, turns: engine.state.turnCount })
      } else {
        // 持久化到会话
        try {
          const session = await this._getSession(sessionId)
          await this.sessionManager.appendMessage({ role: 'assistant', content: result.response })
        } catch (e) { /* 会话保存失败不影响响应 */ }
        this._sendEvent('event/done', {
          content: result.response,
          usage: engine.costTracker ? this._lastUsage(engine) : {},
          turns: result.turns,
          aborted: false,
        })
      }
    } catch (err) {
      if (err.message === '操作已取消' || err.name === 'AbortError') {
        this._sendEvent('event/done', { content: '', aborted: true, turns: 0 })
      } else {
        this._sendEvent('event/error', { message: err.message })
      }
    } finally {
      this.running = false
      this._sendEvent('event/status', { state: 'idle' })
    }
  }

  _lastUsage(engine) {
    // QueryEngine 内部 costTracker 记录在 usageHistory 或直接读取最近记录
    try {
      const history = engine.costTracker.usageHistory || []
      return history.length ? history[history.length - 1] : {}
    } catch {
      return {}
    }
  }

  _abort() {
    if (this.engine && this.engine.abortController) {
      this.aborted = true
      this.engine.abortController.abort()
      console.error('[cc-node-stdio] 已请求中断')
    }
  }

  async _toolCallResult(params = {}) {
    const { toolCallId, result, isError } = params
    const resolve = this.pendingToolCalls.get(toolCallId)
    if (!resolve) throw this._err(-32602, `未知的 toolCallId: ${toolCallId}`)
    this.pendingToolCalls.delete(toolCallId)
    resolve({ content: String(result ?? ''), isError: !!isError })
    return { accepted: true }
  }

  async _toolsDefine(params = {}) {
    const tools = params.tools
    if (!Array.isArray(tools)) throw this._err(-32602, 'tools 必须为数组')
    this.toolDefs = tools
    this._rebuildEngine()
    return { ok: true, count: tools.length }
  }

  async _sessionNew(params = {}) {
    const sm = await this._getSessionManager()
    const session = await sm.create(params.title || '')
    this.currentSession = session
    this._rebuildEngine()
    return { sessionId: session.id, title: session.title }
  }

  async _sessionLoad(params = {}) {
    const sm = await this._getSessionManager()
    const session = await sm.load(params.sessionId)
    if (!session) throw this._err(-32602, `会话不存在: ${params.sessionId}`)
    this.currentSession = session
    this._rebuildEngine()
    return { sessionId: session.id, title: session.title, messageCount: session.messages?.length || 0 }
  }

  async _sessionList() {
    const sm = await this._getSessionManager()
    const sessions = await sm.list()
    return { sessions }
  }

  async _sessionDelete(params = {}) {
    const sm = await this._getSessionManager()
    return { ok: await sm.delete(params.sessionId) }
  }

  _configGet() {
    return {
      config: {
        apiBase: this.config.apiBase,
        apiKey: this.config.apiKey ? '***' : '',
        model: this.config.model,
        mode: this._mode,
      },
    }
  }

  async _configSet(params = {}) {
    const c = params.config || {}
    if (c.apiBase !== undefined) this.config.apiBase = String(c.apiBase)
    if (c.apiKey !== undefined) this.config.apiKey = String(c.apiKey)
    if (c.model !== undefined) this.config.model = String(c.model)
    if (c.systemPrompt !== undefined) this.config.systemPrompt = String(c.systemPrompt)
    this._rebuildEngine()
    return { ok: true }
  }

  _shutdownNow() {
    if (this.shuttingDown) return
    this.shuttingDown = true
    console.error('[cc-node-stdio] 关闭中…')
    process.exitCode = 0
    // 等待 stdout 缓冲刷完再退出（立即 exit 会丢弃未写入的响应）
    setTimeout(() => process.exit(0), 50)
  }

  // ─────────────────────────── 引擎 ───────────────────────────

  get _mode() {
    return this._currentMode || 'code'
  }

  set _mode(v) {
    this._currentMode = v
  }

  async _getSessionManager() {
    if (!this.sessionManager) {
      const sessionsDir = join(homedir(), '.cc-node', 'sessions')
      this.sessionManager = new SessionManager({ sessionsDir })
      await this.sessionManager.ensureDir()
    }
    return this.sessionManager
  }

  async _getSession(sessionId) {
    const sm = await this._getSessionManager()
    if (sessionId) {
      const s = await sm.load(sessionId)
      if (s) {
        this.currentSession = s
        return s
      }
    }
    if (!this.currentSession) {
      this.currentSession = await sm.create()
    }
    return this.currentSession
  }

  /** 构建工具列表（remote 模式：handler 转发给客户端执行） */
  _buildTools() {
    // 客户端下发优先；否则用内置工具定义
    const defs = this.toolDefs || builtinTools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }))
    return defs.map((t) => ({
      name: t.name,
      description: t.description || '',
      parameters: t.parameters || { type: 'object', properties: {} },
      handler: async (input) => {
        const toolCallId = `call_${randomUUID()}`
        this._sendEvent('event/toolCall', {
          toolCall: { id: toolCallId, name: t.name, input: input || {} },
        })
        return new Promise((resolve) => {
          this.pendingToolCalls.set(toolCallId, resolve)
        })
      },
    }))
  }

  async _getEngine() {
    if (this.engine) return this.engine
    if (!this.config.apiBase) {
      throw this._err(4, '未设置 apiBase（config/set 或 --api-base）')
    }
    if (!this.config.model) {
      throw this._err(4, '未设置 model（config/set 或 --model）')
    }
    return this._rebuildEngine()
  }

  _rebuildEngine() {
    const apiBase = this.config.apiBase
    const localServer = isLocalLlmServer(apiBase)
    const apiKey = this.config.apiKey
    if (!localServer && !apiKey) {
      console.error('[cc-node-stdio] 警告: 非本地服务未设置 apiKey')
    }
    this.engine = new QueryEngine(
      new QueryEngineConfig({
        cwd: resolve(this.cliArgs.cwd || process.cwd()),
        model: this.config.model,
        apiBase,
        apiKey,
        systemPrompt: this.config.systemPrompt,
        maxTurns: this.config.maxTurns,
        permissionMode: 'always-allow', // 安全底线仍检查；执行确认由客户端负责
        tools: this._buildTools(),
        verbose: false,
        costTracker: new CostTracker({ model: this.config.model }),
        onDelta: (evt) => {
          this._sendEvent('event/delta', { kind: evt.type, text: evt.text })
        },
      })
    )
    return this.engine
  }

  _err(code, message) {
    const e = new Error(message)
    e.code = code
    return e
  }
}

/** 直接运行：node src/stdio/server.js */
if (process.argv[1] && process.argv[1].endsWith('server.js')) {
  const server = new StdioServer()
  server.start()
}
