/**
 * 通讯通道模块 — 支持多平台消息推送
 * 
 * 支持的通道：
 *   - Telegram Bot API
 *   - 企业微信 (WeCom) Webhook
 *   - 飞书 (Feishu) Webhook
 *   - Discord Webhook
 *   - Slack Webhook
 *   - 自定义 HTTP Webhook
 * 
 * 配置方式：
 *   环境变量或 .claude-code/config.json 中的 channels 字段
 * 
 * 用法：
 *   import { ChannelManager } from './channel.js'
 *   const cm = new ChannelManager()
 *   await cm.send('任务完成！结果：xxx')
 *   await cm.send('⚠️ 警告', { channel: 'telegram' })
 */


// ============================================================
// 通道适配器
// ============================================================

/** Telegram Bot API 适配器 */
class TelegramChannel {
  constructor({ token, chatId }) {
    this.token = token
    this.chatId = chatId
  }

  get name() { return 'telegram' }

  async send(text, options = {}) {
    const url = `https://api.telegram.org/bot${this.token}/sendMessage`
    const body = {
      chat_id: this.chatId,
      text,
      parse_mode: options.parseMode || 'Markdown',
      disable_notification: options.silent || false,
    }
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(r => r.json())
  }
}

/** 企业微信 Webhook 适配器 */
class WeComChannel {
  constructor({ webhookUrl }) {
    this.webhookUrl = webhookUrl
  }

  get name() { return 'wecom' }

  async send(text, options = {}) {
    const body = {
      msgtype: options.msgType || 'text',
      text: { content: text },
      markdown: options.parseMode === 'markdown' ? { content: text } : undefined,
    }
    // 清理 undefined 字段
    if (body.markdown === undefined) delete body.markdown
    if (body.msgtype === 'markdown') delete body.text

    return fetch(this.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(r => r.json())
  }
}

/** 飞书 Webhook 适配器 */
class FeishuChannel {
  constructor({ webhookUrl }) {
    this.webhookUrl = webhookUrl
  }

  get name() { return 'feishu' }

  async send(text, options = {}) {
    const isMarkdown = options.parseMode === 'markdown'
    const body = {
      msg_type: isMarkdown ? 'interactive' : 'text',
      card: isMarkdown ? {
        elements: [{ tag: 'markdown', content: text }]
      } : undefined,
      content: isMarkdown
        ? undefined
        : JSON.stringify({ text: text }),
    }
    // 清理 undefined 字段
    if (body.card === undefined) delete body.card
    if (body.content === undefined) delete body.content

    return fetch(this.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(r => r.json())
  }
}

/** Discord Webhook 适配器 */
class DiscordChannel {
  constructor({ webhookUrl }) {
    this.webhookUrl = webhookUrl
  }

  get name() { return 'discord' }

  async send(text, options = {}) {
    const body = {
      content: text,
      username: options.username || 'cc-node',
    }
    return fetch(this.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(r => r.json())
  }
}

/** Slack Webhook 适配器 */
class SlackChannel {
  constructor({ webhookUrl }) {
    this.webhookUrl = webhookUrl
  }

  get name() { return 'slack' }

  async send(text, options = {}) {
    const body = {
      text,
      username: options.username || 'cc-node',
      mrkdwn: options.parseMode !== 'plain',
    }
    return fetch(this.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(r => r.text())
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
    
    return fetch(this.url, {
      method: this.method,
      headers: { 'Content-Type': 'application/json', ...this.headers },
      body,
    }).then(r => r.text())
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

  /** 从环境变量加载通道
   *  
   *  环境变量格式：
   *    CC_NODE_CHANNEL_TELEGRAM_TOKEN=xxx
   *    CC_NODE_CHANNEL_TELEGRAM_CHAT_ID=xxx
   *    CC_NODE_CHANNEL_WECOM_WEBHOOK_URL=xxx
   *    CC_NODE_CHANNEL_DEFAULT=telegram
   */
  _loadFromEnv() {
    const envChannels = {}
    
    for (const [key, value] of Object.entries(process.env)) {
      if (!key.startsWith(ENV_PREFIX)) continue
      const rest = key.slice(ENV_PREFIX.length)
      
      if (rest === 'DEFAULT') {
        this.defaultChannel = value.toLowerCase()
        continue
      }
      
      // 解析 CC_NODE_CHANNEL_<TYPE>_<PARAM>
      const parts = rest.split('_')
      const channelType = parts[0].toLowerCase()
      const param = parts.slice(1).join('_').toLowerCase()
      
      if (!envChannels[channelType]) envChannels[channelType] = { type: channelType }
      // 将 SNAKE_CASE 转为 camelCase
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
  list() {
    return Array.from(this.channels.keys())
  }

  /** 发送消息
   *  @param {string} text — 消息内容
   *  @param {object} options — 
   *    channel: 通道名（默认用 defaultChannel 或全部通道）
   *    parseMode: 'Markdown' | 'plain'
   *    silent: 静默通知
   */
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

  /** 发送模板消息
   *  @param {string} template — 模板名：'task-done', 'error', 'question'
   *  @param {object} data — 模板变量
   */
  async sendTemplate(template, data = {}, options = {}) {
    const templates = {
      'task-done': `✅ 任务完成\n${data.task || ''}\n${data.result ? '结果：' + data.result : ''}`,
      'error': `❌ 错误\n${data.task || ''}\n${data.error || ''}`,
      'question': `❓ 需要确认\n${data.question || ''}\n${data.options ? '选项：' + data.options.join(' / ') : ''}`,
      'progress': `🔄 进度更新\n${data.task || ''}\n${data.progress || ''}${data.percent ? ' (' + data.percent + '%)' : ''}`,
      'warning': `⚠️ 警告\n${data.message || ''}`,
    }
    const text = templates[template] || `📢 ${data.message || text}`
    return this.send(text, options)
  }
}
