/**
 * 工具注册表 — 导出所有内置工具
 */
import { bashTool } from './bash.js'
import { fileReadTool } from './file-read.js'
import { fileEditTool } from './file-edit.js'
import { fileWriteTool } from './file-write.js'
import { globTool } from './glob.js'
import { grepTool } from './grep.js'
import { webFetchTool } from './web-fetch.js'
import { webSearchTool } from './web-search.js'
import { askUserTool } from './ask-user.js'
import { gitTool } from './git-tool.js'

/**
 * 所有内置工具列表
 */
export const builtinTools = [
  bashTool,
  fileReadTool,
  fileEditTool,
  fileWriteTool,
  globTool,
  grepTool,
  webFetchTool,
  webSearchTool,
  askUserTool,
  gitTool,
]

/**
 * 工具注册表 — 管理所有可用工具
 */
export class ToolRegistry {
  constructor() {
    this.tools = new Map()
  }

  /** 注册一个工具 */
  register(tool) {
    this.tools.set(tool.name, tool)
    return this
  }

  /** 批量注册 */
  registerAll(tools) {
    for (const tool of tools) {
      this.register(tool)
    }
    return this
  }

  /** 获取工具 */
  get(name) {
    return this.tools.get(name)
  }

  /** 获取所有工具 */
  getAll() {
    return Array.from(this.tools.values())
  }

  /** 获取工具名称列表 */
  getNames() {
    return Array.from(this.tools.keys())
  }

  /** 注销工具 */
  unregister(name) {
    return this.tools.delete(name)
  }

  /** 检查工具是否存在 */
  has(name) {
    return this.tools.has(name)
  }

  /** 生成 OpenAI function-calling 格式的工具定义 */
  toOpenAITools() {
    return this.getAll().map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }))
  }

  /** 生成 tool_use 格式的工具定义（兼容多种 API） */
  getToolDefinitions() {
    return this.getAll().map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }))
  }

  /** @deprecated 使用 getToolDefinitions() 替代 */
  toAnthropicTools() {
    return this.getToolDefinitions()
  }
}

/**
 * 创建包含所有内置工具的注册表
 */
export function createDefaultRegistry() {
  const registry = new ToolRegistry()
  registry.registerAll(builtinTools)
  return registry
}
