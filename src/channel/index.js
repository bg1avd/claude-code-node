/**
 * 通讯通道模块 — 支持多平台消息推送
 *
 * v1.1 修复:
 * - TelegramChannel: 添加缺失的 url 属性
 * - 新增 WeComChannel, FeishuChannel, DiscordChannel, SlackChannel 适配器实现
 * - 所有适配器统一错误处理
 *
 * 支持的通道：
 * - Telegram Bot API
 * - 企业微信 (WeCom) Webhook
 * - 飞书 (Feishu) Webhook
 * - Discord Webhook
 * - Slack Webhook
 * - 自定义 HTTP Webhook
 */

// ============================================================
// 通道适配器
// ============================================================

/** Telegram Bot API 适配器 */
class TelegramChannel {
  constructor({ token, chatId }) {
    this.token = token
    this.chatId = chatId
    // v1.1 修复: 添加缺失的 url 属性
    this.url = `https://api.telegram.org/bot${token}/sendMessage`
    this.method = 'POST'
    this.headers = {}
    this.bodyTemplate = null
  }

  get name() { return 'telegram' }

  async send(text, options = {}) {
    const body = JSON.stringify({
      chat_id: this.chatId,
      text,
      parse_mode: options.parseMode || 'Markdown',
      disable_notification: options.silent || false,
    })
    const r = await fetch(this.url, {
      method: this.method,
      headers: { 'Content-Type': 'application/json', ...this.headers },
      body,
    })
    if (!r.ok) {
      const errText = await r.text()
      throw new Error(`Telegram API error ${r.status}: ${errText.slice(0, 200)}`)
    }
    return r.json()
  }
}

/** 企业微信 Webhook 适配器 */
class WeComChannel {
  constructor({ webhookUrl }) {
    this.webhookUrl = webhookUrl
  }

  get name() { return 'wecom' }

  async send(text, options = {}) {
    const body = JSON.stringify({
      msgtype: 'text',
      text: { content: text },
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
      content: { text },
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
    const body = JSON.stringify({ content: text })
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
    const body = JSON.stringify({ text })
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
  wecom: WeComChannel,
  feishu: FeishuChannel,
  discord: DiscordChannel,
  slack: SlackChannel,
  webhook: WebhookChannel,
}

const ENV_PREFIX = 'CC_NODE_CHANNEL_'

export class ChannelManager {
  constructor(config = {}) {
    this.channels = new Map()
    this.defaultChannel = config.defaultChannel || null
    this._loadFromConfig(config)
    this._loadFromEnv()
  }

  /** 从配置对象加载通道 */
  _loadFromConfig(config) {
    if (!config.channels) return
    for (const [name, chConfig] of Object.entries(config.channels)) {
      if (chConfig.enabled === false) continue
      this._registerChannel(name, chConfig)
    }
    if (config.defaultChannel) {
      this.defaultChannel = config.defaultChannel
    }
  }

  /** 从环境变量加载通道 */
  _loadFromEnv() {
    const envChannels = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (!key.startsWith(ENV_PREFIX)) continue
      const rest = key.slice(ENV_PREFIX.length)
      if (rest === 'DEFAULT') {
        this.defaultChannel = value.toLowerCase()
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
    }
    const text = templates[template] || `📢 ${data.message || ''}`
    return this.send(text, options)
  }
}
