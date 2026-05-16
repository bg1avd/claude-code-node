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
  }

  /**
   * 检查工具调用是否被允许
   */
  async check(toolName, input = {}) {
    if (this.mode === 'always-allow') return true
    if (this.mode === 'deny') return false

    if (this.alwaysAllow.has(toolName)) return true
    if (this.alwaysDeny.has(toolName)) return false

    // 'ask' 模式 — 需要用户确认（简化版直接允许）
    // 完整版应该在终端显示确认对话框
    return true
  }

  allow(toolName) {
    this.alwaysAllow.add(toolName)
  }

  deny(toolName) {
    this.alwaysDeny.add(toolName)
  }
}

