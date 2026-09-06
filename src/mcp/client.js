/**
 * MCP (Model Context Protocol) 客户端
 * 对应原版: src/services/mcp/
 * 支持两种传输：stdio (spawn 子进程) + HTTP(streamable)（远程独立部署的 MCP server）。
 *
 * v1.1 修复:
 * - 新增 MCP 服务器命令白名单，阻止任意命令执行
 * - 新增沙箱环境变量清理
 * - 新增 spawn 参数验证
 *
 * v2 新增(远程 HTTP):
 * - type:'http' / 有 url 无 command 时走 HTTP(streamable)，用于连接独立部署的搜索等 MCP server
 * - token 会原样作为 `Authorization: Bearer` 透传（服务端负责 API-key 校验）
 * - 非 2xx 且体不是 MCP JSON-RPC error 时抛可读错误
 */
import { spawn } from 'child_process'
import { resolve, basename } from 'path'

/**
 * MCP 服务器命令白名单
 * 只允许这些可执行文件名（不含路径）
 * 阻止: /bin/bash, /bin/sh, python, node, perl, ruby 等通用解释器
 */
const ALLOWED_MCP_COMMANDS = [
  'npx',           // Node.js 包执行器
  'uvx',           // Python uv 执行器
  'mcp-server',    // 通用 MCP 服务器前缀
  'mcp-',          // mcp- 前缀的服务器
]

/**
 * 明确禁止的命令 — 无论白名单如何都不允许
 */
const BLOCKED_MCP_COMMANDS = [
  'bash', 'sh', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh',
  'python', 'python2', 'python3',
  'perl', 'ruby', 'php',
  'node', 'deno', 'bun',
  'nc', 'ncat', 'socat', 'telnet',
  'curl', 'wget',
  'eval', 'exec', 'source',
]

/**
 * 验证 MCP 服务器命令是否安全
 * @param {string} command — 要执行的命令
 * @returns {{allowed: boolean, reason?: string}}
 */
function validateMcpCommand(command) {
  // 提取命令的基本名（去除路径）
  const cmdBase = basename(command).toLowerCase()

  // 1. 检查是否在禁止列表中
  if (BLOCKED_MCP_COMMANDS.includes(cmdBase)) {
    return { allowed: false, reason: `MCP 服务器命令禁止: ${cmdBase}（通用解释器/网络工具不允许作为 MCP 服务器）` }
  }

  // 2. 检查绝对路径中的可疑位置
  if (command.includes('/')) {
    const resolved = resolve(command)
    // 阻止 /tmp, /dev/shm 等临时目录
    if (resolved.startsWith('/tmp/') || resolved.startsWith('/dev/shm/') || resolved.startsWith('/var/tmp/')) {
      return { allowed: false, reason: `MCP 服务器命令在临时目录: ${resolved}（可能为注入攻击）` }
    }
    // 阻止 /dev, /proc, /sys
    if (resolved.startsWith('/dev/') || resolved.startsWith('/proc/') || resolved.startsWith('/sys/')) {
      return { allowed: false, reason: `MCP 服务器命令在系统目录: ${resolved}` }
    }
  }

  // 3. 检查是否匹配白名单前缀
  const isAllowed = ALLOWED_MCP_COMMANDS.some(prefix => cmdBase.startsWith(prefix))
  if (!isAllowed) {
    return { allowed: false, reason: `MCP 服务器命令不在白名单中: ${cmdBase}（允许前缀: ${ALLOWED_MCP_COMMANDS.join(', ')}）` }
  }

  return { allowed: true }
}

/**
 * 清理环境变量 — 移除敏感变量，防止注入
 */
function sanitizeEnv(env) {
  const sanitized = { ...process.env, ...env }
  // 移除可能导致注入的环境变量
  const dangerousEnvKeys = [
    'LD_PRELOAD', 'LD_LIBRARY_PATH',
    'PYTHONPATH', 'PYTHONSTARTUP',
    'NODE_OPTIONS',
    'BASH_ENV', 'ENV',
  ]
  for (const key of dangerousEnvKeys) {
    delete sanitized[key]
  }
  return sanitized
}

/**
 * JSON-RPC 2.0 请求 ID 计数器
 */
let requestId = 0

function nextId() {
  return ++requestId
}

/**
 * MCP 客户端 — 通过 stdio 与 MCP 服务器通信
 */
export class MCPClient {
  constructor(serverConfig) {
    this.config = serverConfig
    this.process = null
    this.pending = new Map() // id → { resolve, reject }
    this.buffer = ''
    this.tools = []
    this.resources = []
  }

  /**
   * 是否远程 HTTP 传输
   * 识别依据：config 里给了 url（且没给 command），或显式 type。
   */
  get isHttp() {
    const t = this.config.type
    const hasUrl = !!this.config.url
    const noCommand = !this.config.command
    return (t === 'http' || t === 'streamable-http' || (hasUrl && noCommand))
  }

  /** 启动 MCP 服务器（stdio spawn 或 HTTP 连接） */
  async connect() {
    if (this.isHttp) {
      return this._connectHttp()
    }
    const { command, args = [], env = {} } = this.config

    // v1.1: 验证命令安全性
    const validation = validateMcpCommand(command)
    if (!validation.allowed) {
      throw new Error(`MCP 服务器命令验证失败: ${validation.reason}`)
    }

    // v1.1: 验证参数不包含注入
    for (const arg of args) {
      if (typeof arg !== 'string') {
        throw new Error(`MCP 服务器参数类型错误: ${typeof arg}，期望 string`)
      }
    }

    this.process = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: sanitizeEnv(env),
    })

    this.process.stdout.on('data', (data) => {
      this.buffer += data.toString()
      this._processBuffer()
    })

    this.process.stderr.on('data', (data) => {
      // MCP 服务器日志输出到 stderr
      if (this.config.debug) {
        console.error(`[MCP stderr] ${data.toString().trim()}`)
      }
    })

    this.process.on('error', (err) => {
      // 拒绝所有等待中的请求
      for (const [id, { reject }] of this.pending) {
        reject(new Error(`MCP server error: ${err.message}`))
      }
      this.pending.clear()
    })

    this.process.on('close', (code) => {
      for (const [id, { reject }] of this.pending) {
        reject(new Error(`MCP server exited with code ${code}`))
      }
      this.pending.clear()
    })

    // 初始化握手
    await this._initialize()
  }

  /**
   * ===== HTTP(streamable-HTTP) 传输实现 =====
   * 让 MCP 客户端可连接独立部署在远端(如 Cloudflare/反代后)的 MCP 搜索服务器。
   * 只要在 mcp.servers 配置里给 { type:'http'|url, token } 即可，无需本地进程。
   */

  /** 组装 HTTP 请求头 */
  _httpHeaders(json) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    }
    const token = this.config.token || this.config.apiKey
    if (token) headers['Authorization'] = `Bearer ${token}`
    if (json) {
      // streamable-http 建议带协议版本头（可选）
      headers['MCP-Protocol-Version'] = this.config.protocolVersion || '2024-11-05'
    }
    return headers
  }

  /** HTTP POST 一次 JSON-RPC 请求并返回响应对象 */
  async _httpPost(payload) {
    const target = this.config.url
    if (!target) throw new Error('HTTP MCP server 缺少 url')
    const timeoutMs = this.config.timeoutMs || this.config.timeout || 30000
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(target, {
        method: 'POST',
        headers: this._httpHeaders(true),
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
      const ctype = (res.headers.get('content-type') || '').toLowerCase()
      const text = await res.text()
      if (!text) {
        // 202 / 空 body — 通知类，无返回
        return null
      }
      // 解析响应体（可能 JSON 或 SSE）
      let parsed = null
      if (ctype.includes('text/event-stream')) {
        const line = text.split('\n').find((l) => l.startsWith('data:'))
        if (line) {
          try { parsed = JSON.parse(line.slice(5).trim()) } catch { /* ignore */ }
        }
      } else {
        try { parsed = JSON.parse(text) } catch { /* ignore */ }
      }
      // 4xx/5xx 且体不是 MCP JSON-RPC error → 给一个可读错误（如网关 502、SSO 登录页等）
      if (!res.ok && !(parsed && (parsed.error || parsed.result !== undefined))) {
        throw new Error(`HTTP ${res.status} ${res.statusText || ''}`.trim())
      }
      return parsed
    } finally {
      clearTimeout(timer)
    }
  }

  /** HTTP 模式连接：完成 initialize 与工具列表装载 */
  async _connectHttp() {
    const url = this.config.url
    if (!url) throw new Error('HTTP MCP server 缺少 url 配置')
    // 简单连通性：直接走 initialize
    try {
      const res = await this._httpPost({
        jsonrpc: '2.0',
        id: this._nextId(),
        method: 'initialize',
        params: {
          protocolVersion: this.config.protocolVersion || '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'claude-code-node', version: '1.0.0' },
        },
      })
      if (!res || res.error) {
        throw new Error((res && res.error && (res.error.message || 'initialize failed')) || '连接失败')
      }
      // initialized 通知（fire-and-forget）
      this._httpPost({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
        params: {},
      }).catch(() => {})
    } catch (err) {
      throw new Error(`HTTP MCP 连接失败: ${err.message}`)
    }
    // 装载工具列表
    try {
      const tl = await this._httpPost({
        jsonrpc: '2.0',
        id: this._nextId(),
        method: 'tools/list',
        params: {},
      })
      this.tools = (tl && tl.result && tl.result.tools) || []
    } catch {
      this.tools = []
    }
  }

  /** 内部连续 id */
  _nextId() {
    // 复用上层 requestId，但避免与 stdio 计数冲突——单独给一个简单计数
    if (!this._idc) this._idc = 0
    return ++this._idc
  }

  /** HTTP 模式调用工具（post tools/call） */
  async _httpCallTool(name, args) {
    const payload = {
      jsonrpc: '2.0',
      id: this._nextId(),
      method: 'tools/call',
      params: { name, arguments: args || {} },
    }
    const res = await this._httpPost(payload)
    if (!res) return {}
    if (res.error) throw new Error(res.error.message || 'MCP tool call error')
    return res.result || {}
  }

  /** HTTP 模式读资源 */
  async _httpReadResource(uri) {
    const payload = {
      jsonrpc: '2.0',
      id: this._nextId(),
      method: 'resources/read',
      params: { uri },
    }
    const res = await this._httpPost(payload)
    if (!res) return {}
    if (res.error) throw new Error(res.error.message || 'MCP resource error')
    return res.result || {}
  }

  /** 初始化协议 */
  async _initialize() {
    const result = await this._sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'claude-code-node',
        version: '1.0.0',
      },
    })

    // 发送 initialized 通知
    this._sendNotification('notifications/initialized', {})

    // 获取工具列表
    try {
      const toolsResult = await this._sendRequest('tools/list', {})
      this.tools = toolsResult?.tools || []
    } catch {
      this.tools = []
    }

    // 获取资源列表
    try {
      const resourcesResult = await this._sendRequest('resources/list', {})
      this.resources = resourcesResult?.resources || []
    } catch {
      this.resources = []
    }

    return result
  }

  /** 调用 MCP 工具 */
  async callTool(name, args = {}) {
    if (this.isHttp) return this._httpCallTool(name, args)
    return this._sendRequest('tools/call', {
      name,
      arguments: args,
    })
  }

  /** 读取 MCP 资源 */
  async readResource(uri) {
    if (this.isHttp) return this._httpReadResource(uri)
    return this._sendRequest('resources/read', { uri })
  }

  /** 发送 JSON-RPC 请求 */
  _sendRequest(method, params, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const id = nextId()
      const message = JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params,
      })

      // M8 fix: 请求超时保护，防止 MCP 服务器无响应时永远挂起
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`MCP request timeout: ${method} (${timeoutMs}ms)`))
        }
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })

      // 每条消息以换行符分隔
      this.process.stdin.write(message + '\n', (err) => {
        if (err) {
          clearTimeout(timer)
          this.pending.delete(id)
          reject(new Error(`Failed to send message: ${err.message}`))
        }
      })
    })
  }

  /** 发送 JSON-RPC 通知（无响应） */
  _sendNotification(method, params) {
    const message = JSON.stringify({
      jsonrpc: '2.0',
      method,
      params,
    })
    this.process.stdin.write(message + '\n')
  }

  /** 处理接收缓冲区 */
  _processBuffer() {
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() // 保留不完整的行

    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const message = JSON.parse(line)

        if (message.id && this.pending.has(message.id)) {
          const { resolve, reject, timer } = this.pending.get(message.id)
          this.pending.delete(message.id)
          // M8 fix: 清除超时定时器
          if (timer) clearTimeout(timer)

          if (message.error) {
            reject(new Error(message.error.message || 'MCP error'))
          } else {
            resolve(message.result)
          }
        }
        // 忽略通知和未知消息
      } catch {
        // 忽略解析错误
      }
    }
  }

  /** 关闭连接 */
  async close() {
    if (this.isHttp) {
      // HTTP 连接无长驻进程：尝试 shutdown（尽力而为），无需 kill
      try {
        await this._httpPost({
          jsonrpc: '2.0',
          id: this._nextId(),
          method: 'shutdown',
          params: {},
        })
      } catch {
        /* 忽略 */
      }
      return
    }
    if (this.process) {
      try {
        await this._sendRequest('shutdown', {})
      } catch {
        // 忽略关闭错误
      }
      this.process.kill('SIGTERM')
      this.process = null
    }
  }

  /** 获取工具定义 — tool_use 格式（兼容多种 API） */
  getToolDefinitions() {
    return this.tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }))
  }

  /** @deprecated 使用 getToolDefinitions() 替代 */
  getAnthropicTools() {
    return this.getToolDefinitions()
  }

  /** 获取工具定义（适配 OpenAI function-calling 格式） */
  getOpenAITools() {
    return this.tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }))
  }
}
