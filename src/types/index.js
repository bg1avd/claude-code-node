import { randomUUID } from 'crypto'
// ====== 消息类型 ======

/** 消息角色 */
export const Role = {
  USER: 'user',
  ASSISTANT: 'assistant',
  SYSTEM: 'system',
}

/** 基础消息 */
export class Message {
  role
  content
  timestamp
  id

  constructor(role, content) {
    this.role = role
    this.content = content
    this.timestamp = Date.now()
    this.id = randomUUID()
  }
}

export class UserMessage extends Message {
  constructor(content) {
    super(Role.USER, content)
  }
}

export class AssistantMessage extends Message {
  toolCalls
  reasoningContent
  constructor(content, toolCalls = [], reasoningContent = '') {
    super(Role.ASSISTANT, content)
    this.toolCalls = toolCalls
    this.reasoningContent = reasoningContent
  }
}

export class SystemMessage extends Message {
  constructor(content) {
    super(Role.SYSTEM, content)
  }
}

// ====== 工具调用类型 ======

export class ToolCall {
  id
  name
  input
  status // 'pending' | 'running' | 'done' | 'error'

  constructor(id, name, input) {
    this.id = id
    this.name = name
    this.input = input
    this.status = 'pending'
  }
}

export class ToolResult {
  toolCallId
  content
  isError

  constructor(toolCallId, content, isError = false) {
    this.toolCallId = toolCallId
    this.content = content
    this.isError = isError
  }
}

// ====== 工具定义 ======

export class ToolDef {
  name
  description
  parameters // JSON Schema
  handler
  permissionLevel // 'always-allow' | 'ask' | 'deny'

  constructor(name, description, parameters, handler, permissionLevel = 'ask') {
    this.name = name
    this.description = description
    this.parameters = parameters
    this.handler = handler
    this.permissionLevel = permissionLevel
  }
}

// ====== Agent 类型 ======

export class AgentDef {
  id
  name
  systemPrompt
  tools
  model

  constructor(id, name, systemPrompt, tools = [], model = 'default') {
    this.id = id
    this.name = name
    this.systemPrompt = systemPrompt
    this.tools = tools
    this.model = model
  }
}

// ====== 会话状态 ======

export class SessionState {
  messages
  toolResults
  turnCount
  budgetUsed // token 预算
  isRunning

  constructor() {
    this.messages = []
    this.toolResults = new Map()
    this.turnCount = 0
    this.budgetUsed = 0
    this.isRunning = false
  }
}

