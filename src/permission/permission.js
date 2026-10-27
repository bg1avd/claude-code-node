/**
 * 权限检查器
 * 对应原版: src/hooks/toolPermission/ + src/Tool.ts 中的 ToolPermissionContext
 */
import { normalizePermissionMode } from '../core/permission-mode.js'

export class PermissionChecker {
  constructor(mode = 'ask') {
    // 对外只认 all / ask / deny（旧值 always-allow 兼容映射为 all）
    this.mode = normalizePermissionMode(mode).mode // 'all' | 'ask' | 'deny'
    this.rawMode = mode
    this.alwaysAllow = new Set()
    this.alwaysDeny = new Set()
    this.askRules = new Set()
    this.sessionAllowAll = false // 整个会话自动允许
  }

  /**
   * 检查工具调用是否被允许
   */
  async check(toolName, input = {}) {
    if (this.mode === 'all' || this.sessionAllowAll) return true
    if (this.mode === 'deny') return false

    // 工具名忽略大小写：`/allow bash` 与工具名 `Bash` 必须匹配
    // （旧实现严格比较，导致 `/allow Bash` 存成小写后永远匹配不上）。
    const key = String(toolName).toLowerCase()
    if (this.alwaysAllow.has(key)) return true
    if (this.alwaysDeny.has(key)) return false

    return true // 'ask' 模式下由 onConfirmTool 决定
  }

  allow(toolName) {
    this.alwaysAllow.add(String(toolName).toLowerCase())
  }

  deny(toolName) {
    this.alwaysDeny.add(String(toolName).toLowerCase())
  }

  // 会话剩余时间全部工具自动允许
  allowAllForSession() {
    this.sessionAllowAll = true
  }

  // 重置会话允许状态
  resetSessionAllow() {
    this.sessionAllowAll = false
    // 会话级放行必须**一并撤销**：`/allow reset` 的语义是「回到需要确认」，
    // 而 `/allow <tool>` 加进来的条目同样只作用于本进程（不写配置）。
    // 旧实现只清 sessionAllowAll，于是 `/allow Bash` 之后 `/allow reset` 形同虚设 ——
    // 提示写着"已恢复 ask"，实际 Bash 仍然免确认。
    this.alwaysAllow.clear()
  }
}

