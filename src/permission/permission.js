/**
 * 权限检查器
 * 对应原版: src/hooks/toolPermission/ + src/Tool.ts 中的 ToolPermissionContext
 */

export class PermissionChecker {
  constructor(mode = 'ask') {
    this.mode = mode // 'always-allow' | 'ask' | 'deny'
    this.alwaysAllow = new Set()
    this.alwaysDeny = new Set()
    this.askRules = new Set()
    this.sessionAllowAll = false // 整个会话自动允许
  }

  /**
   * 检查工具调用是否被允许
   */
  async check(toolName, input = {}) {
    if (this.mode === 'always-allow' || this.sessionAllowAll) return true
    if (this.mode === 'deny') return false

    if (this.alwaysAllow.has(toolName)) return true
    if (this.alwaysDeny.has(toolName)) return false

    return true // 'ask' 模式下由 onConfirmTool 决定
  }

  allow(toolName) {
    this.alwaysAllow.add(toolName)
  }

  deny(toolName) {
    this.alwaysDeny.add(toolName)
  }

  // 会话剩余时间全部工具自动允许
  allowAllForSession() {
    this.sessionAllowAll = true
  }

  // 重置会话允许状态
  resetSessionAllow() {
    this.sessionAllowAll = false
  }
}

