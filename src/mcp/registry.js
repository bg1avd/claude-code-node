/**
 * MCP 服务器注册表
 * 对应原版: src/services/mcp/mcpServerApproval.tsx + 配置加载
 */
import { readFile, writeFile, mkdir } from 'fs/promises'
import { resolve, join } from 'path'
import { existsSync } from 'fs'
import { MCPClient } from './client.js'

/**
 * MCP 服务器注册表 — 管理多个 MCP 服务器连接
 */
export class MCPRegistry {
  constructor(options = {}) {
    this.configPath = options.configPath || null
    this.servers = new Map() // name → MCPClient
    this.serverConfigs = new Map() // name → config
  }

  /** 从配置文件加载 MCP 服务器列表 */
  async loadFromConfig(configPath) {
    this.configPath = configPath
    try {
      const raw = await readFile(configPath, 'utf-8')
      const config = JSON.parse(raw)
      const mcpServers = config.mcpServers || {}

      for (const [name, serverConfig] of Object.entries(mcpServers)) {
        this.serverConfigs.set(name, serverConfig)
      }
    } catch {
      // 配置文件不存在 — 空注册表
    }
  }

  /** 注册一个 MCP 服务器 */
  register(name, config) {
    this.serverConfigs.set(name, config)
  }

  /** 注销一个 MCP 服务器 */
  unregister(name) {
    this.serverConfigs.delete(name)
    const client = this.servers.get(name)
    if (client) {
      client.close()
      this.servers.delete(name)
    }
  }

  /** 连接指定服务器 */
  async connect(name) {
    const config = this.serverConfigs.get(name)
    if (!config) {
      throw new Error(`MCP server not registered: ${name}`)
    }

    const client = new MCPClient(config)
    await client.connect()
    this.servers.set(name, client)
    return client
  }

  /** 连接所有注册的服务器 */
  async connectAll() {
    const results = {}
    for (const [name, _] of this.serverConfigs) {
      try {
        results[name] = await this.connect(name)
      } catch (err) {
        results[name] = { error: err.message }
      }
    }
    return results
  }

  /** 关闭所有连接 */
  async closeAll() {
    const promises = []
    for (const [name, client] of this.servers) {
      promises.push(
        client.close().catch(() => {})
      )
    }
    await Promise.all(promises)
    this.servers.clear()
  }

  /** 获取所有已连接服务器的工具列表 */
  getAllTools() {
    const tools = []
    for (const [name, client] of this.servers) {
      for (const tool of client.tools) {
        tools.push({
          ...tool,
          _mcpServer: name, // 标记来源
        })
      }
    }
    return tools
  }

  /** 获取所有已连接服务器的资源列表 */
  getAllResources() {
    const resources = []
    for (const [name, client] of this.servers) {
      for (const resource of client.resources) {
        resources.push({
          ...resource,
          _mcpServer: name,
        })
      }
    }
    return resources
  }

  /** 调用指定服务器上的工具 */
  async callTool(serverName, toolName, args) {
    const client = this.servers.get(serverName)
    if (!client) {
      throw new Error(`MCP server not connected: ${serverName}`)
    }
    return client.callTool(toolName, args)
  }

  /** 通过工具名查找并调用（自动路由到正确的服务器） */
  async callToolByName(toolName, args) {
    for (const [name, client] of this.servers) {
      const tool = client.tools.find(t => t.name === toolName)
      if (tool) {
        return client.callTool(toolName, args)
      }
    }
    throw new Error(`Tool not found on any connected MCP server: ${toolName}`)
  }

  /** 读取指定服务器上的资源 */
  async readResource(serverName, uri) {
    const client = this.servers.get(serverName)
    if (!client) {
      throw new Error(`MCP server not connected: ${serverName}`)
    }
    return client.readResource(uri)
  }

  /** 保存当前配置到文件 */
  async saveConfig(configPath) {
    const path = configPath || this.configPath
    if (!path) throw new Error('No config path specified')

    const mcpServers = {}
    for (const [name, config] of this.serverConfigs) {
      mcpServers[name] = config
    }

    await mkdir(resolve(path, '..'), { recursive: true })
    await writeFile(path, JSON.stringify({ mcpServers }, null, 2), 'utf-8')
  }

  /** 获取服务器状态 */
  getStatus() {
    const status = []
    for (const [name, config] of this.serverConfigs) {
      const connected = this.servers.has(name)
      const client = this.servers.get(name)
      status.push({
        name,
        command: config.command,
        connected,
        toolCount: client?.tools?.length || 0,
        resourceCount: client?.resources?.length || 0,
      })
    }
    return status
  }
}
