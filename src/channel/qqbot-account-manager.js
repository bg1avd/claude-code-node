/**
 * QQBot 多账户管理器
 *
 * 功能：
 * - 管理多个 QQ 机器人账户
 * - 自动选择账户发送消息
 * - 支持账户级别的权限控制
 */

export class QQBotAccount {
  constructor(config, globalConfig = {}) {
    this.id = config.id || 'default'
    this.name = config.name || this.id
    this.enabled = config.enabled !== false

    // 认证信息（支持环境变量或直接配置）
    this.appId = config.appId || process.env[`CC_NODE_CHANNEL_QQBOT_${this.id.toUpperCase()}_APPID`] || ''
    this.clientSecret = config.clientSecret || process.env[`CC_NODE_CHANNEL_QQBOT_${this.id.toUpperCase()}_SECRET`] || ''

    // 权限策略
    this.dmPolicy = config.dmPolicy || globalConfig.dmPolicy || 'open'  // 'open'|'allowlist'|'disabled'
    this.groupPolicy = config.groupPolicy || globalConfig.groupPolicy || 'open'

    // 白名单（格式: "qqbot:openid" 或 "qqbot:group:group_openid"）
    this.allowFrom = config.allowFrom || globalConfig.allowFrom || ['*']

    // 目标群/用户（可选默认值）
    this.defaultTargets = config.defaultTargets || {}

    // 高级配置
    this.markdownSupport = config.markdownSupport !== false
    this.streaming = config.streaming || { mode: 'partial' }

    // 验证
    if (!this.appId || !this.clientSecret) {
      console.warn(`[QQBot] 账户 ${this.id} 未配置 appId/clientSecret`)
    }
  }

  /** 检查是否允许来自指定源的消息 */
  isAllowed(scope, openid, groupOpenid = null) {
    // 如果允许所有人
    if (this.allowFrom.includes('*')) return true

    // 检查具体白名单
    const checks = []
    if (scope === 'c2c') {
      checks.push(`qqbot:${openid}`)
    } else if (scope === 'group' && groupOpenid) {
      checks.push(`qqbot:${groupOpenid}`)  // 群级别
      checks.push(`qqbot:group:${groupOpenid}:${openid}`)  // 用户级别
    }

    return checks.some(c => this.allowFrom.includes(c))
  }

  /** 获取目标 ID（优先级：传入 > 默认配置） */
  getTargetId(scope, overrideTargetId = null) {
    if (overrideTargetId) return overrideTargetId
    return this.defaultTargets[scope] || null
  }
}

export class QQBotAccountManager {
  constructor(config = {}) {
    this.accounts = new Map()
    this.defaultAccountId = config.defaultAccount || 'default'
    this.globalConfig = {
      dmPolicy: config.dmPolicy || 'open',
      groupPolicy: config.groupPolicy || 'open',
      allowFrom: config.allowFrom || ['*']
    }

    // 初始化所有账户
    if (config.accounts) {
      for (const [id, accountConfig] of Object.entries(config.accounts)) {
        this.addAccount(new QQBotAccount(accountConfig, this.globalConfig))
      }
    }

    // 确保有默认账户
    if (!this.accounts.has(this.defaultAccountId)) {
      this.addAccount(new QQBotAccount({ id: this.defaultAccountId }, this.globalConfig))
    }
  }

  addAccount(account) {
    this.accounts.set(account.id, account)
    return this
  }

  getAccount(id = null) {
    const targetId = id || this.defaultAccountId
    return this.accounts.get(targetId)
  }

  getAllAccounts() {
    return Array.from(this.accounts.values()).filter(a => a.enabled)
  }

  /** 根据消息上下文选择账户（基于 routing 规则） */
  selectAccount(scope, openid, groupOpenid = null) {
    // 遍历所有账户，找到第一个匹配权限的
    for (const account of this.getAllAccounts()) {
      const policy = scope === 'c2c' ? account.dmPolicy : account.groupPolicy
      if (policy === 'disabled') continue

      if (account.isAllowed(scope, openid, groupOpenid)) {
        return account
      }
    }

    // 没匹配到，返回默认账户（如果默认账户开启了的话）
    const defaultAcc = this.getAccount()
    return defaultAcc && defaultAcc.enabled ? defaultAcc : null
  }
}
