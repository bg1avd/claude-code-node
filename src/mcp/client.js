/**
 * MCP (Model Context Protocol) 客户端
 * 对应原版: src/services/mcp/
 * 简化版：支持 stdio 传输，JSON-RPC 2.0
 */
import { spawn } from 'child_process'

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

  /** 启动 MCP 服务器进程 */
  async connect() {
    const { command, args = [], env = {} } = this.config

    this.process = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
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
    return this._sendRequest('tools/call', {
      name,
      arguments: args,
    })
  }

  /** 读取 MCP 资源 */
  async readResource(uri) {
    return this._sendRequest('resources/read', { uri })
  }

  /** 发送 JSON-RPC 请求 */
  _sendRequest(method, params) {
    return new Promise((resolve, reject) => {
      const id = nextId()
      const message = JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params,
      })

      this.pending.set(id, { resolve, reject })

      // 每条消息以换行符分隔
      this.process.stdin.write(message + '\n', (err) => {
        if (err) {
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
          const { resolve, reject } = this.pending.get(message.id)
          this.pending.delete(message.id)

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
