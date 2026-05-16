/**
 * 权限系统增强版 — 规则持久化 + 审计日志
 * 对应原版：src/hooks/toolPermission/ + src/utils/permissions/
 */
import { readFile, writeFile, mkdir, stat, rename } from 'fs/promises'
import { join } from 'path'
import { checkBashSafety } from './bash-guard.js'
import { checkPathSafety, checkWritePathSafety } from './path-guard.js'
import { checkUrlSafety } from './ssrf-guard.js'

const PERMISSIONS_FILE = '.claude-code/permissions.json'
const AUDIT_LOG_FILE = '.claude-code/audit.log'
const AUDIT_LOG_MAX_SIZE = 10 * 1024 * 1024 // 10MB 审计日志上限
const AUDIT_LOG_MAX_BACKUPS = 3 // 最多保留 3 个轮转备份

/**
 * 权限决策类型
 */
export const PermissionDecision = {
  ALLOW: 'allow',
  DENY: 'deny',
  ASK: 'ask',
}

/**
 * 工具权限规则
 */
export class PermissionRule {
  constructor({ tool, pattern, decision, reason, expiresAt = null }) {
    this.tool = tool // 工具名或 '*'（所有工具）
    this.pattern = pattern // 匹配模式（glob 或 regex 字符串）
    this.decision = decision // allow / deny / ask
    this.reason = reason // 规则原因
    this.createdAt = Date.now()
    this.expiresAt = expiresAt // 过期时间（会话级规则）
  }

  /** 检查规则是否已过期 */
  get isExpired() {
    return this.expiresAt && Date.now() > this.expiresAt
  }

  /** 检查输入是否匹配此规则 */
  matches(input) {
    if (this.isExpired) return false
    // 简单 glob 匹配
    const pattern = this.pattern
    if (pattern === '*') return true
    // 路径模式
    if (typeof input === 'string' && input.includes('/')) {
      return this._globMatch(pattern, input)
    }
    // 命令模式
    if (typeof input === 'string') {
      return input.startsWith(pattern) || this._globMatch(pattern, input)
    }
    return false
  }

  _globMatch(pattern, str) {
    const regex = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')
    return new RegExp(`^${regex}$`).test(str)
  }
}

/**
 * 增强版权限检查器
 */
export class EnhancedPermissionChecker {
  constructor(mode = 'ask', options = {}) {
    this.mode = mode
    this.rules = [] // PermissionRule 列表
    this.auditLog = [] // 审计日志
    this.cwd = options.cwd || process.cwd()
    this.projectDir = options.projectDir || process.cwd()
    this._maxAuditEntries = 1000
  }

  /** 添加规则 */
  addRule(rule) {
    this.rules.push(new PermissionRule(rule))
    return this
  }

  /** 移除过期规则 */
  cleanupRules() {
    this.rules = this.rules.filter(r => !r.isExpired)
  }

  /** 添加会话级允许规则（当前会话有效） */
  allowForSession(tool, pattern = '*') {
    return this.addRule({
      tool,
      pattern,
      decision: PermissionDecision.ALLOW,
      reason: '用户会话级授权',
      expiresAt: null, // 会话级不过期，但可以手动清除
    })
  }

  /** 添加永久拒绝规则 */
  deny(tool, pattern = '*', reason = '') {
    return this.addRule({
      tool,
      pattern,
      decision: PermissionDecision.DENY,
      reason,
    })
  }

  /**
   * 综合权限检查
   * @param {string} toolName — 工具名
   * @param {object} input — 工具输入参数
   * @returns {Promise<{allowed: boolean, reason?: string, requiresConfirmation?: boolean, securityCheck?: object}>}
   */
  async check(toolName, input = {}) {
    // 1. 模式级检查
    if (this.mode === 'deny') {
      this._log(toolName, input, false, '全局拒绝模式')
      return { allowed: false, reason: '全局拒绝模式' }
    }

    if (this.mode === 'always-allow') {
      const securityResult = await this._securityCheck(toolName, input)
      if (!securityResult.safe) {
        this._log(toolName, input, false, securityResult.reason)
        return { allowed: false, reason: securityResult.reason, securityCheck: securityResult }
      }
      this._log(toolName, input, true, '全局允许模式')
      return { allowed: true }
    }

    // 2. 规则匹配
    this.cleanupRules()
    for (const rule of this.rules) {
      if (rule.tool === toolName || rule.tool === '*') {
        if (rule.matches(this._extractPattern(toolName, input))) {
          if (rule.decision === PermissionDecision.DENY) {
            this._log(toolName, input, false, `规则拒绝：${rule.reason}`)
            return { allowed: false, reason: rule.reason }
          }
          if (rule.decision === PermissionDecision.ALLOW) {
            // 即使规则允许，也要过安全检查
            const securityResult = await this._securityCheck(toolName, input)
            if (!securityResult.safe) {
              this._log(toolName, input, false, securityResult.reason)
              return { allowed: false, reason: securityResult.reason, securityCheck: securityResult }
            }
            this._log(toolName, input, true, `规则允许：${rule.reason}`)
            return { allowed: true }
          }
        }
      }
    }

    // 3. 安全检查（在 ask 之前）
    const securityResult = await this._securityCheck(toolName, input)
    if (!securityResult.safe) {
      this._log(toolName, input, false, securityResult.reason)
      return { allowed: false, reason: securityResult.reason, securityCheck: securityResult }
    }

    // 4. ask 模式 — 需要用户确认
    // 返回 requiresConfirmation=true，让调用方处理确认逻辑
    this._log(toolName, input, true, 'ask 模式 — 等待用户确认')
    return {
      allowed: false, // ask 模式下先拒绝，等待用户确认
      requiresConfirmation: true, // 标记需要用户确认
      reason: 'ask 模式需要用户确认',
      securityCheck: securityResult,
    }
  }

  /**
   * 内部安全检查 — 工具特定的安全逻辑
   */
  async _securityCheck(toolName, input) {
    switch (toolName) {
      case 'Bash': {
        const command = input.command || ''
        if (!command) return { safe: true }
        const result = checkBashSafety(command)
        return {
          safe: result.allowed,
          reason: result.reasons.length > 0 ? result.reasons.join('; ') : undefined,
          detail: result,
        }
      }
      case 'Read': {
        const filePath = input.file_path || ''
        if (!filePath) return { safe: true }
        const result = checkPathSafety(filePath, { cwd: this.cwd })
        return {
          safe: result.safe,
          reason: result.reasons.length > 0 ? result.reasons.join('; ') : undefined,
          detail: result,
        }
      }
      case 'Edit':
      case 'Write': {
        const filePath = input.file_path || ''
        if (!filePath) return { safe: true }
        const checker = toolName === 'Write' ? checkWritePathSafety : checkPathSafety
        const result = checker(filePath, { cwd: this.cwd })
        return {
          safe: result.safe,
          reason: result.reasons.length > 0 ? result.reasons.join('; ') : undefined,
          detail: result,
        }
      }
      case 'WebFetch': {
        const url = input.url || ''
        if (!url) return { safe: true }
        const result = await checkUrlSafety(url)
        return {
          safe: result.allowed,
          reason: result.reason,
        }
      }
      default:
        return { safe: true }
    }
  }

  /** 提取规则匹配用的模式字符串 */
  _extractPattern(toolName, input) {
    switch (toolName) {
      case 'Bash':
        return input.command || ''
      case 'Read':
      case 'Edit':
      case 'Write':
        return input.file_path || ''
      case 'Glob':
      case 'Grep':
        return input.path || input.pattern || ''
      case 'WebFetch':
      case 'WebSearch':
        return input.url || input.query || ''
      default:
        return JSON.stringify(input)
    }
  }

  /** 审计日志记录 */
  _log(toolName, input, allowed, reason) {
    this.auditLog.push({
      timestamp: new Date().toISOString(),
      tool: toolName,
      inputSnippet: JSON.stringify(input).slice(0, 200),
      allowed,
      reason,
    })
    // 限制审计日志大小
    if (this.auditLog.length > this._maxAuditEntries) {
      this.auditLog = this.auditLog.slice(-this._maxAuditEntries)
    }
  }

  /** 保存权限规则到文件 */
  async saveRules() {
    const dir = join(this.projectDir, '.claude-code')
    await mkdir(dir, { recursive: true })
    const data = this.rules
      .filter(r => !r.isExpired && !r.expiresAt) // 只保存永久规则
      .map(r => ({
        tool: r.tool,
        pattern: r.pattern,
        decision: r.decision,
        reason: r.reason,
      }))
    // v1.1 修复：文件权限 0600（仅所有者可读写），防止其他用户读取权限规则
    await writeFile(join(dir, 'permissions.json'), JSON.stringify(data, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
    })
  }

  /** 加载权限规则 */
  async loadRules() {
    try {
      const raw = await readFile(join(this.projectDir, PERMISSIONS_FILE), 'utf-8')
      const data = JSON.parse(raw)
      for (const rule of data) {
        this.addRule(rule)
      }
    } catch {
      // 文件不存在 — 使用默认规则
    }
  }

  /** 保存审计日志（v1.1: 增加轮转，防止磁盘耗尽） */
  async saveAuditLog() {
    const dir = join(this.projectDir, '.claude-code')
    await mkdir(dir, { recursive: true })
    const logPath = join(dir, 'audit.log')

    // 检查现有日志大小，超过上限则轮转
    try {
      const logStat = await stat(logPath)
      if (logStat.size >= AUDIT_LOG_MAX_SIZE) {
        // 轮转：audit.log → audit.log.1 → audit.log.2 → audit.log.3（最老的删除）
        for (let i = AUDIT_LOG_MAX_BACKUPS; i >= 1; i--) {
          const src = i === 1 ? logPath : join(dir, `audit.log.${i - 1}`)
          const dst = join(dir, `audit.log.${i}`)
          try {
            if (i === AUDIT_LOG_MAX_BACKUPS) {
              // 最老的备份直接删除
              const { unlink } = await import('fs/promises')
              await unlink(dst).catch(() => {})
            }
            await rename(src, dst).catch(() => {})
          } catch {
            /* 忽略轮转错误 */
          }
        }
      }
    } catch {
      /* 日志文件不存在，首次写入 */
    }

    const lines = this.auditLog
      .map(e => `${e.timestamp} | ${e.tool} | ${e.allowed ? 'ALLOW' : 'DENY'} | ${e.reason} | ${e.inputSnippet}`)
      .join('\n')
    // v1.1 修复：文件权限 0600
    await writeFile(logPath, lines, { encoding: 'utf-8', mode: 0o600 })
  }

  /** 获取审计摘要 */
  getAuditSummary() {
    const summary = {
      total: this.auditLog.length,
      allowed: 0,
      denied: 0,
      byTool: {},
    }
    for (const entry of this.auditLog) {
      if (entry.allowed) summary.allowed++
      else summary.denied++
      summary.byTool[entry.tool] = (summary.byTool[entry.tool] || 0) + 1
    }
    return summary
  }
}
