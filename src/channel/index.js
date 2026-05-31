/**
 * 通讯通道模块 — 支持多平台消息推送
 *
 * v2.0 增强：
 * - 新增 QQBotChannel 适配器（QQ Bot API v2）
 * - 增强 TelegramChannel：Markdown 安全编码、分片发送、编辑/删除
 * - 增强速率限制和错误处理
 *
 * 支持的通道：
 * - Telegram Bot API
 * - QQ Bot (群/频道)
 * - 企业微信 (WeCom) Webhook
 * - 飞书 (Feishu) Webhook
 * - Discord Webhook
 * - Slack Webhook
 * - 自定义 HTTP Webhook
 */

// ============================================================
// MarkdownV2 安全编码
// ============================================================

const TG_MD_ESCAPE_CHARS = /[_*[\]()~`>#+\-=|{}.!]/g

function escapeMarkdownV2(text) {
  return text.replace(TG_MD_ESCAPE_CHARS, '\\$&')
}

// ============================================================
// 通道适配器
// ============================================================

/** Telegram Bot API 适配器 v2.0 */
class TelegramChannel {
  constructor({ token, chatId }) {
    this.token = token
    this.chatId = chatId
    this.proxyAddr = process.env.CC_NODE_CHANNEL_TELEGRAM_PROXY || ''
    const customBase = process.env.CC_NODE_CHANNEL_TELEGRAM_API_BASE || ''
    this.apiBase = customBase || `https://api.telegram.org/bot${token}`
    this.lastCall = 0
    this.callInterval = 50  // 20 calls/sec max
  }

  /** 带代理支持的 fetch */
  async _fetch(url, options = {}) {
    if (!this.proxyAddr) return fetch(url, options)
    const { fetchViaSocks5 } = await import('./tg-proxy.js')
    return fetchViaSocks5(url, options, this.proxyAddr)
  }

  get name() { return 'telegram' }

  /** 速率限制等待 */
  async _rateLimit() {
    const now = Date.now()
    const wait = this.callInterval - (now - this.lastCall)
    if (wait > 0) await new Promise(r => setTimeout(r, wait))
    this.lastCall = Date.now()
  }

  /** 发送消息（自动分段） */
  async send(text, options = {}) {
    const MAX_LEN = 4000
    const parts = this._splitMessage(text, MAX_LEN)
    const results = []

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      const header = i > 0 ? `📎 (${i + 1}/${parts.length})\n` : ''
      const body = header + part

      await this._rateLimit()
      const result = await this._sendSingle(body, options)
      results.push(result)

      // 分段之间稍作延迟
      if (i < parts.length - 1) {
        await new Promise(r => setTimeout(r, 200))
      }
    }
    return results[0] || {}
  }

  /** 单条发送 */
  async _sendSingle(text, options = {}) {
    const { parseMode, silent, replyTo, disableWebPreview, keyboard } = options
    const useMarkdown = parseMode === 'Markdown' || parseMode === 'MarkdownV2' || !parseMode

    const body = {
      chat_id: this.chatId,
      text: text.slice(0, 4096),
      parse_mode: 'HTML',  // HTML 比 Markdown 更稳定
      disable_notification: silent || false,
      disable_web_page_preview: disableWebPreview ?? true,
    }

    if (replyTo) body.reply_parameters = { message_id: replyTo }
    if (keyboard) body.reply_markup = JSON.stringify(keyboard)

    // Telegram HTML 安全编码（只保留基本标签）
    body.text = this._safeHTML(body.text)

    const r = await this._fetch(`${this.apiBase}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    const data = await r.json()
    if (!data.ok) {
      // 429 — 速率限制，自动等待
      if (data.error_code === 429) {
        const retryAfter = data.parameters?.retry_after || 3
        await new Promise(r => setTimeout(r, retryAfter * 1000))
        return this._sendSingle(text, { ...options, parseMode: undefined })
      }
      // 400 格式错 — 降级纯文本
      if (data.error_code === 400) {
        return this._sendSingle(text, { ...options, parseMode: 'text' })
      }
      throw new Error(`Telegram error ${data.error_code}: ${(data.description || '').slice(0, 200)}`)
    }
    return data.result
  }

  /** 安全 HTML（只允许 Telegram 支持的基本标签） */
  _safeHTML(text) {
    // Telegram HTML 只支持: <b>, <i>, <u>, <s>, <code>, <pre>, <a href="">
    // 替换不支持的标签
    return text
      .replace(/<h[1-6][^>]*>/gi, '<b>')
      .replace(/<\/h[1-6]>/gi, '</b>')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<p[^>]*>/gi, '')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<strong>/gi, '<b>')
      .replace(/<\/strong>/gi, '</b>')
      .replace(/<em>/gi, '<i>')
      .replace(/<\/em>/gi, '</i>')
      .replace(/<hr[^>]*>/gi, '\n────────────\n')
      .replace(/<img[^>]*>/gi, '[图片]')
      .replace(/<[^>]+>/g, (tag) => {
        const allowed = ['<b>', '</b>', '<i>', '</i>', '<u>', '</u>', '<s>', '</s>', '<code>', '</code>', '<pre>', '</pre>']
        if (allowed.includes(tag.toLowerCase())) return tag
        if (tag.toLowerCase().startsWith('<a ')) return tag
        if (tag === '</a>') return tag
        return ''
      })
  }

  /** 分片消息 */
  _splitMessage(text, maxLen) {
    if (!text || text.length <= maxLen) return [text || '']
    const parts = []
    let current = ''
    for (const line of text.split('\n')) {
      if (current.length + line.length + 1 > maxLen) {
        parts.push(current)
        current = line
      } else {
        current += (current ? '\n' : '') + line
      }
    }
    if (current) parts.push(current)
    return parts
  }

  /** 编辑消息 */
  async edit(messageId, text, options = {}) {
    await this._rateLimit()
    const r = await this._fetch(`${this.apiBase}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: this.chatId,
        message_id: messageId,
        text: this._safeHTML(text).slice(0, 4096),
        parse_mode: 'HTML',
      }),
    })
    return r.json()
  }

  /** 删除消息 */
  async delete(messageId) {
    await this._rateLimit()
    const r = await this._fetch(`${this.apiBase}/deleteMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: this.chatId, message_id: messageId }),
    })
    return r.ok
  }
}

// ============================================================
// QQ Bot 通道适配器 v3.0 — 多账户、权限、富媒体
// ============================================================

import { QQBotEnhanced } from './qqbot-enhanced.js'
import { QQBotAccountManager } from './qqbot-account-manager.js'

/**
 * QQ Bot 增强版通道适配器
 *
 * 功能：
 * - 多账户管理（从配置文件加载）
 * - 权限控制（dmPolicy/groupPolicy + allowFrom 白名单）
 * - 自动解析 <qqmedia> 标签并上传富媒体
 * - 支持图片、文件、语音上传（限于 ~/.openclaw/media/qqbot）
 * - WebSocket 监听（可选）
 */
class QQBotChannel {
  constructor(config = {}, globalConfig = {}) {
    this.name = 'qqbot'
    this.enabled = config.enabled !== false

    // 合并全局配置
    const qqbotConfig = {
      ...globalConfig.qqbot,
      ...config
    }

    // 创建增强版 QQBot 实例
    this.bot = new QQBotEnhanced(qqbotConfig)

    // 通道特定配置
    this.scope = config.scope || 'group'  // 默认发送到群
    this.defaultTargetId = config.targetId || config.groupOpenId || ''

    // WebSocket 监听状态
    this._listener = null
    this._onMessageCallback = null
  }

  /** 启动消息监听 */
  async listen(onMessage) {
    if (!this.enabled) {
      console.warn('[QQBotChannel] 通道未启用')
      return
    }
    try {
      this._onMessageCallback = onMessage
      await this.bot.listen(this._handleIncomingMessage.bind(this))
      console.log('[QQBotChannel] 监听已启动')
    } catch (e) {
      console.error('[QQBotChannel] 监听启动失败:', e.message)
      throw e
    }
  }

  _handleIncomingMessage(msg) {
    // 包装为统一消息格式，转发给回调
    if (this._onMessageCallback) {
      this._onMessageCallback({
        channel: 'qqbot',
        text: msg.text,
        scope: msg.scope,
        chatId: msg.chatId,
        from: msg.from,
        messageId: msg.messageId,
        raw: msg.raw,
        accountId: msg.accountId
      })
    }
  }

  /** 停止监听 */
  stop() {
    if (this.bot) {
      this.bot.stop()
    }
  }

  /** 发送消息（支持富媒体标签） */
  async send(text, options = {}) {
    if (!this.enabled) {
      return [{ channel: 'qqbot', ok: false, error: '通道未启用' }]
    }

    try {
      const scope = options.scope || this.scope
      const targetId = options.targetId || this.defaultTargetId
      const accountId = options.accountId || null

      const result = await this.bot.send({
        text,
        scope,
        targetId,
        accountId,
        opts: { replyMsgId: options.replyMsgId }
      })

      return result.ok
        ? [{ channel: 'qqbot', ok: true }]
        : [{ channel: 'qqbot', ok: false, error: result.error }]
    } catch (e) {
      console.error('[QQBotChannel] 发送失败:', e)
      return [{ channel: 'qqbot', ok: false, error: e.message }]
    }
  }

  /** 支持的工具调用（提供给 Agent） */
  get tools() {
    return {
      /** 发送 QQ 消息 */
      qqbot_send: async (args) => {
        const { text, scope = this.scope, targetId = this.defaultTargetId } = args
        const result = await this.send(text, { scope, targetId })
        return result[0]
      },

      /** 获取账户列表 */
      qqbot_list_accounts: async () => {
        const accounts = this.bot.accountManager.getAllAccounts()
        return accounts.map(a => ({ id: a.id, name: a.name, enabled: a.enabled }))
      },

      /** 发送图片（直接文件路径） */
      qqbot_send_image: async (args) => {
        const { path, scope = this.scope, targetId = this.defaultTargetId } = args
        // 这里需要支持直接的图片发送，不通过文本标签
        // 临时方案：调用 bot 的底层方法
        return { ok: false, error: '暂未实现' }
      }
    }
  }
}


// ============================================================
// 已有适配器（保持兼容）
// ============================================================

/** 企业微信 Webhook 适配器 */
class WeComChannel {
  constructor({ webhookUrl }) {
    this.webhookUrl = webhookUrl
  }

  get name() { return 'wecom' }

  async send(text, options = {}) {
    const body = JSON.stringify({
      msgtype: 'text',
      text: { content: text.slice(0, 2048) },
    })
    const r = await fetch(this.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
    if (!r.ok) {
      const errText = await r.text()
      throw new Error(`WeCom API error ${r.status}: ${errText.slice(0, 200)}`)
    }
    return r.json()
  }
}

/** 飞书 Webhook 适配器 */
class FeishuChannel {
  constructor({ webhookUrl }) {
    this.webhookUrl = webhookUrl
  }

  get name() { return 'feishu' }

  async send(text, options = {}) {
    const body = JSON.stringify({
      msg_type: 'text',
      content: { text: text.slice(0, 4096) },
    })
    const r = await fetch(this.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
    if (!r.ok) {
      const errText = await r.text()
      throw new Error(`Feishu API error ${r.status}: ${errText.slice(0, 200)}`)
    }
    return r.json()
  }
}

/** Discord Webhook 适配器 */
class DiscordChannel {
  constructor({ webhookUrl }) {
    this.webhookUrl = webhookUrl
  }

  get name() { return 'discord' }

  async send(text, options = {}) {
    const body = JSON.stringify({ content: text.slice(0, 2000) })
    const r = await fetch(this.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
    if (!r.ok) {
      const errText = await r.text()
      throw new Error(`Discord API error ${r.status}: ${errText.slice(0, 200)}`)
    }
    return r.status === 204 ? 'ok' : r.json()
  }
}

/** Slack Webhook 适配器 */
class SlackChannel {
  constructor({ webhookUrl }) {
    this.webhookUrl = webhookUrl
  }

  get name() { return 'slack' }

  async send(text, options = {}) {
    const body = JSON.stringify({ text: text.slice(0, 3000) })
    const r = await fetch(this.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
    if (!r.ok) {
      const errText = await r.text()
      throw new Error(`Slack API error ${r.status}: ${errText.slice(0, 200)}`)
    }
    return r.text()
  }
}

/** 通用 HTTP Webhook 适配器 */
class WebhookChannel {
  constructor({ url, method = 'POST', headers = {}, bodyTemplate }) {
    this.url = url
    this.method = method
    this.headers = headers
    this.bodyTemplate = bodyTemplate
  }

  get name() { return 'webhook' }

  async send(text, options = {}) {
    const body = this.bodyTemplate
      ? this.bodyTemplate.replace('{text}', text)
      : JSON.stringify({ text, ...options })
    const r = await fetch(this.url, {
      method: this.method,
      headers: { 'Content-Type': 'application/json', ...this.headers },
      body,
    })
    if (!r.ok) {
      const errText = await r.text()
      throw new Error(`Webhook error ${r.status}: ${errText.slice(0, 200)}`)
    }
    return r.text()
  }
}

// ============================================================
// 通道管理器
// ============================================================

const CHANNEL_ADAPTERS = {
  telegram: TelegramChannel,
  qqbot: QQBotChannel,
  wecom: WeComChannel,
  feishu: FeishuChannel,
  discord: DiscordChannel,
  slack: SlackChannel,
  webhook: WebhookChannel,
}

const ENV_PREFIX = 'CC_NODE_CHANNEL_'

export class ChannelManager {
  constructor(config = {}, defaultChannel) {
    this.channels = new Map()
    this.defaultChannel = defaultChannel || config.defaultChannel || null
    if (config.channels) {
      this._loadFromConfig(config)
    }
    // If config is array-like or flat, handle old format
    if (typeof config === 'object' && !config.channels && Object.keys(config).length > 0) {
      this._loadFromConfig({ channels: config })
    }
    this._loadFromEnv()
  }

  /** 从配置对象加载通道 */
  _loadFromConfig(config) {
    if (!config.channels) return
    for (const [name, chConfig] of Object.entries(config.channels)) {
      if (chConfig.enabled === false) continue
      this._registerChannel(name, chConfig)
    }
  }

  /** 从环境变量加载通道 */
  _loadFromEnv() {
    const envChannels = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (!key.startsWith(ENV_PREFIX)) continue
      const rest = key.slice(ENV_PREFIX.length)
      if (rest === 'DEFAULT') {
        if (!this.defaultChannel) this.defaultChannel = value.toLowerCase()
        continue
      }
      const parts = rest.split('_')
      const channelType = parts[0].toLowerCase()
      const param = parts.slice(1).join('_').toLowerCase()

      if (!envChannels[channelType]) envChannels[channelType] = { type: channelType }
      const camelKey = param.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
      envChannels[channelType][camelKey] = value
    }
    for (const [name, chConfig] of Object.entries(envChannels)) {
      if (!this.channels.has(name)) {
        this._registerChannel(name, chConfig)
      }
    }
  }

  /** 注册一个通道 */
  _registerChannel(name, config) {
    const type = config.type || name
    const Adapter = CHANNEL_ADAPTERS[type]
    if (!Adapter) {
      console.warn(`[channel] Unknown channel type: ${type}`)
      return
    }
    try {
      const instance = new Adapter(config)
      this.channels.set(name, instance)
    } catch (e) {
      console.warn(`[channel] Failed to register ${name}: ${e.message}`)
    }
  }

  /** 获取已注册通道列表 */
  list() { return Array.from(this.channels.keys()) }

  /** 发送消息 */
  async send(text, options = {}) {
    const targetChannels = options.channel
      ? [options.channel]
      : this.defaultChannel
        ? [this.defaultChannel]
        : this.list()
    const results = []
    for (const name of targetChannels) {
      const ch = this.channels.get(name)
      if (!ch) {
        // 不存在的通道尝试按 type 注册
        const Adapter = CHANNEL_ADAPTERS[name]
        if (Adapter) {
          this._registerChannel(name, { type: name })
          const ch2 = this.channels.get(name)
          if (ch2) {
            try {
              const result = await ch2.send(text, options)
              results.push({ channel: name, ok: true, result })
            } catch (e) {
              results.push({ channel: name, ok: false, error: e.message })
            }
            continue
          }
        }
        results.push({ channel: name, ok: false, error: 'not registered' })
        continue
      }
      try {
        const result = await ch.send(text, options)
        results.push({ channel: name, ok: true, result })
      } catch (e) {
        results.push({ channel: name, ok: false, error: e.message })
      }
    }
    return results
  }

  /** 发送模板消息 */
  async sendTemplate(template, data = {}, options = {}) {
    const templates = {
      'task-done': `✅ 任务完成\n${data.task || ''}\n${data.result ? '结果：' + data.result : ''}`,
      'error': `❌ 错误\n${data.task || ''}\n${data.error || ''}`,
      'question': `❓ 需要确认\n${data.question || ''}\n${data.options ? '选项：' + data.options.join(' / ') : ''}`,
      'progress': `🔄 进度更新\n${data.task || ''}\n${data.progress || ''}${data.percent ? ' (' + data.percent + '%)' : ''}`,
      'warning': `⚠️ 警告\n${data.message || ''}`,
      'debug': `🔍 调试信息\n${data.info || ''}`,
    }
    const text = templates[template] || `📢 ${data.message || ''}`
    return this.send(text, options)
  }
}

// 导出适配器类（供外部使用）
export {
  TelegramChannel,
  QQBotChannel,
  WeComChannel,
  FeishuChannel,
  DiscordChannel,
  SlackChannel,
  WebhookChannel,
}
