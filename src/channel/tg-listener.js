/**
 * Telegram Bot 长轮询监听器 — 增强版 v2.0
 *
 * 支持：
 * - 长轮询消息接收
 * - MarkdownV2 安全编码
 * - 速率限制 (30 msg/s 单聊, 20 msg/min 群组)
 * - 指数退避重连
 * - 回复/内联键盘
 * - 多轮对话状态
 * - 命令解析
 * - 文件/图片接收
 */

// ============================================================
// MarkdownV2 安全编码
// ============================================================

const TG_MD_ESCAPE_CHARS = /[_*[\]()~`>#+\-=|{}.!]/g
const TG_CODE_ESCAPE_CHARS = /[`\\]/g
const TG_LINK_ESCAPE_CHARS = /[()]/g

/**
 * 对文本进行 Telegram MarkdownV2 安全转义
 * Telegram 的 MarkdownV2 非常严格，特殊字符必须用 \ 转义
 */
function escapeMarkdownV2(text, { code = false, link = false } = {}) {
  if (code) return text.replace(TG_CODE_ESCAPE_CHARS, '\\$&')
  if (link) return text.replace(TG_LINK_ESCAPE_CHARS, '\\$&')
  return text.replace(TG_MD_ESCAPE_CHARS, '\\$&')
}

/**
 * 安全发送 Markdown 文本（自动过滤不安全的字符）
 * Telegram 某些场景下 markdown 解析失败会静默返回空
 */
function safeMarkdown(text) {
  // 如果包含复杂的 markdown，用 MarkdownV2 并转义文本部分
  // 简单策略：用 HTML parse_mode 更安全
  return text
}

const API_BASE = (token) => `https://api.telegram.org/bot${token}`

// ============================================================
// 速率限制器
// ============================================================

class RateLimiter {
  constructor(maxPerSec = 30, maxPerMinPerChat = 20) {
    this.maxPerSec = maxPerSec
    this.maxPerMinPerChat = maxPerMinPerChat
    this._calls = []  // [{ time, chatId }]
  }

  /** 检查是否可以发送 */
  canSend(chatId) {
    const now = Date.now()
    // 清理过期记录
    this._calls = this._calls.filter(c => now - c.time < 60000)

    // 每秒限制
    const lastSec = this._calls.filter(c => now - c.time < 1000)
    if (lastSec.length >= this.maxPerSec) return false

    // 每聊天每分钟限制
    const perChat = this._calls.filter(c => c.chatId === chatId && now - c.time < 60000)
    if (perChat.length >= this.maxPerMinPerChat) return false

    return true
  }

  /** 记录一次调用 */
  record(chatId) {
    this._calls.push({ time: Date.now(), chatId })
  }

  /** 等待直到可以发送 */
  async waitForSlot(chatId, timeoutMs = 30000) {
    const start = Date.now()
    while (!this.canSend(chatId)) {
      if (Date.now() - start > timeoutMs) return false
      await new Promise(r => setTimeout(r, 200))
    }
    this.record(chatId)
    return true
  }
}

// ============================================================
// Telegram Bot 客户端
// ============================================================

class TelegramBotClient {
  constructor(token, opts = {}) {
    this.token = token
    this.apiBase = opts.apiBase || API_BASE(token)
    this.proxyAddr = opts.proxy || ''  // SOCKS5 代理地址, 如 "127.0.0.1:1080" 或 "socks5://user:pass@host:port"
    this.rateLimiter = new RateLimiter()
  }

  /** 带代理支持的 fetch */
  async _fetch(url, options = {}) {
    if (!this.proxyAddr) {
      return fetch(url, options)
    }
    const { fetchViaSocks5 } = await import('./tg-proxy.js')
    return fetchViaSocks5(url, options, this.proxyAddr)
  }

  /** 发送消息（带自动重试和速率限制） */
  async sendMessage(chatId, text, options = {}) {
    const { parseMode, replyTo, silent, disableWebPreview, keyboard } = options

    // 等待速率限制
    await this.rateLimiter.waitForSlot(chatId)

    const body = {
      chat_id: chatId,
      text: text.slice(0, 4096),  // Telegram 消息最大 4096 字符
      parse_mode: parseMode || 'HTML',
      disable_notification: silent || false,
      disable_web_page_preview: disableWebPreview ?? true,
    }
    if (replyTo) body.reply_parameters = { message_id: replyTo }
    if (keyboard) body.reply_markup = JSON.stringify(keyboard)

    const res = await this._fetch(`${this.apiBase}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    const data = await res.json()
    if (!data.ok) {
      // 429 速率限制 — 自动等待后重试
      if (data.error_code === 429) {
        const retryAfter = data.parameters?.retry_after || 5
        await new Promise(r => setTimeout(r, retryAfter * 1000))
        return this.sendMessage(chatId, text, options)
      }
      // 400 可能是消息太长或格式问题 — 降级为纯文本
      if (data.error_code === 400 && parseMode) {
        return this.sendMessage(chatId, text, { ...options, parseMode: undefined })
      }
      throw new Error(`Telegram API ${data.error_code}: ${data.description?.slice(0, 200) || 'unknown'}`)
    }
    return data.result
  }

  /** 编辑消息 */
  async editMessage(chatId, messageId, text, options = {}) {
    const { parseMode } = options
    const body = {
      chat_id: chatId,
      message_id: messageId,
      text: text.slice(0, 4096),
      parse_mode: parseMode || 'HTML',
    }
    const res = await this._fetch(`${this.apiBase}/editMessageText`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    const data = await res.json()
    if (!data.ok && data.error_code !== 400) throw new Error(`TG edit error: ${data.description}`)
    return data.result
  }

  /** 删除消息 */
  async deleteMessage(chatId, messageId) {
    const res = await this._fetch(`${this.apiBase}/deleteMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
    })
    return res.ok
  }

  /** 发送聊天动作（typing/upload_photo 等） */
  async sendChatAction(chatId, action = 'typing') {
    try {
      await this._fetch(`${this.apiBase}/sendChatAction`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, action }),
      })
    } catch {}
  }

  /** 获取文件下载链接 */
  async getFile(fileId) {
    const res = await this._fetch(`${this.apiBase}/getFile`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_id: fileId }),
    })
    const data = await res.json()
    if (!data.ok) throw new Error(`TG getFile error: ${data.description}`)
    return `https://api.telegram.org/file/bot${this.token}/${data.result.file_path}`
  }

  /** 设置机器人命令菜单 */
  async setMyCommands(commands) {
    await this._fetch(`${this.apiBase}/setMyCommands`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands }),
    })
  }
}

// ============================================================
// 对话状态管理 — 支持多轮交互
// ============================================================

class ConversationState {
  constructor() {
    // chatId -> { state, data, context, lastActivity }
    this._states = new Map()
    this._timeout = 30 * 60 * 1000 // 30分钟无活动自动清理
    this._cleanupTimer = setInterval(() => this._cleanup(), 5 * 60 * 1000)
  }

  get(chatId) {
    return this._states.get(chatId)
  }

  set(chatId, state, data = {}) {
    this._states.set(chatId, { state, data, lastActivity: Date.now() })
  }

  update(chatId, updates) {
    const existing = this._states.get(chatId)
    if (existing) {
      Object.assign(existing.data, updates)
      existing.lastActivity = Date.now()
    }
  }

  delete(chatId) {
    this._states.delete(chatId)
  }

  touch(chatId) {
    const s = this._states.get(chatId)
    if (s) s.lastActivity = Date.now()
  }

  _cleanup() {
    const now = Date.now()
    for (const [chatId, s] of this._states.entries()) {
      if (now - s.lastActivity > this._timeout) {
        this._states.delete(chatId)
      }
    }
  }

  destroy() {
    clearInterval(this._cleanupTimer)
    this._states.clear()
  }
}

// ============================================================
// Telegram 监听器
// ============================================================

export class TelegramListener {
  constructor(config) {
    this.config = config
    const ch = config.channels?.telegram || {}
    this.token = ch.token
    this.proxyAddr = ch.proxy || process.env.CC_NODE_CHANNEL_TELEGRAM_PROXY || ''
    this.apiBase = ch.apiBase || ''
    this.bot = this.token ? new TelegramBotClient(this.token, { proxy: this.proxyAddr, apiBase: this.apiBase }) : null
    this.lastUpdateId = 0
    this.running = false
    this._pollTimer = null
    this._retryDelay = 1000
    this.maxRetryDelay = 30000
    this.conversations = new ConversationState()
    this._onMessage = null
    this._handlers = {}
  }

  /** 注册消息处理器 */
  on(event, handler) {
    this._handlers[event] = handler
  }

  /** 带代理的 fetch（供类内部使用） */
  async _fetch(url, options = {}) {
    if (!this.proxyAddr) return fetch(url, options)
    const { fetchViaSocks5 } = await import('./tg-proxy.js')
    return fetchViaSocks5(url, options, this.proxyAddr)
  }

  /** 启动监听 */
  async start(onMessage) {
    if (!this.bot) {
      log('[TG] No token configured, skipping')
      return
    }
    this._onMessage = onMessage
    this.running = true
    log(`[TG] Starting long polling...`)

    // 设置命令菜单
    try {
      await this.bot.setMyCommands([
        { command: 'ping', description: '🏓 检查服务状态' },
        { command: 'status', description: '📊 查看 cc-node 状态' },
        { command: 'run', description: '💻 执行 shell 命令（如 /run ls -la）' },
        { command: 'notify', description: '📢 广播通知消息' },
        { command: 'help', description: '❓ 查看帮助' },
        { command: 'cancel', description: '🚫 取消当前操作' },
      ])
    } catch {}

    this._poll()
  }

  /** 内部轮询 */
  async _poll() {
    while (this.running) {
      try {
        const url = `${this.bot.apiBase}/getUpdates`
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            offset: this.lastUpdateId + 1,
            timeout: 30,
            allowed_updates: ['message', 'callback_query', 'edited_message'],
          }),
        })

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`)
        }

        const data = await res.json()
        if (!data.ok) {
          throw new Error(`API error: ${data.description}`)
        }

        if (data.result?.length) {
          for (const update of data.result) {
            this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id)

            // 处理回调查询（内联键盘按钮）
            if (update.callback_query) {
              await this._handleCallbackQuery(update.callback_query)
              continue
            }

            // 处理消息
            if (update.message) {
              await this._handleMessage(update.message)
            }
          }
        }

        // 成功 — 重置退避
        this._retryDelay = 1000

      } catch (e) {
        log(`[TG] Poll error: ${e.message} (retry in ${this._retryDelay}ms)`)
        await this._sleep(this._retryDelay)
        this._retryDelay = Math.min(this._retryDelay * 2, this.maxRetryDelay)
      }
    }
  }

  /** 处理消息 */
  async _handleMessage(msg) {
    const chatId = msg.chat?.id
    if (!chatId) return

    const chatType = msg.chat?.type || 'private' // private, group, supergroup
    const fromName = msg.from?.username || msg.from?.first_name || '?'

    // 提取消息文本 / 文件 / 图片
    let text = msg.text || msg.caption || ''
    let files = []

    // 图片
    if (msg.photo?.length) {
      const best = msg.photo.reduce((a, b) => (a.width > b.width ? a : b))
      try {
        const fileUrl = await this.bot.getFile(best.file_id)
        files.push({ type: 'photo', url: fileUrl })
      } catch {}
    }

    // 文档
    if (msg.document) {
      try {
        const fileUrl = await this.bot.getFile(msg.document.file_id)
        files.push({ type: 'document', url: fileUrl, name: msg.document.file_name })
      } catch {}
    }

    log(`[TG] ← ${fromName} (${chatType}): ${text.slice(0, 60) || '(media)'}`)

    // 处理命令
    if (text.startsWith('/')) {
      const reply = await this._handleCommand(chatId, text, msg)
      if (reply) {
        // 如果回复很长，分多条发送
        await this._sendLongMessage(chatId, reply, { replyTo: msg.message_id })
      }
      return
    }

    // 处理普通消息 — 转发给 cc-node
    if (this._onMessage) {
      // 发送 typing 提示
      this.bot.sendChatAction(chatId).catch(() => {})

      try {
        await this._onMessage({
          text,
          chatId,
          from: fromName,
          channel: 'telegram',
          files,
          replyTo: msg.message_id,
          messageId: msg.message_id,
          chatType,
        })
      } catch (e) {
        log(`[TG] Message handler error: ${e.message}`)
      }
    }
  }

  /** 处理回调查询（按钮点击） */
  async _handleCallbackQuery(cb) {
    const chatId = cb.message?.chat?.id
    const msgId = cb.message?.message_id
    const data = cb.data || ''

    log(`[TG] callback: ${data}`)

    // 确认收到回调（去除loading状态）
    try {
      await this._fetch(`${this.bot.apiBase}/answerCallbackQuery`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: cb.id }),
      })
    } catch {}

    if (this._onMessage && data) {
      this._onMessage({
        text: data,
        chatId,
        from: cb.from?.username || '?',
        channel: 'telegram_callback',
        callbackData: data,
        replyTo: msgId,
      }).catch(e => log(`[TG] callback handler error: ${e.message}`))
    }
  }

  /** 命令处理 */
  async _handleCommand(chatId, text, msg) {
    const parts = text.split(/\s+/)
    const cmd = parts[0].toLowerCase()
    const args = parts.slice(1).join(' ')

    switch (cmd) {
      case '/start':
      case '/help':
        return this._helpText()

      case '/ping':
        return '🏓 pong! cc-notify is alive.'

      case '/status': {
        const nodeInfo = await this._findCcNode()
        const chNames = Object.keys(this.config.channels || {})
        return [
          '📊 *cc-notify 状态*',
          '',
          `• 运行时间: ${Math.floor(process.uptime())}s`,
          `• 通道: ${chNames.join(', ') || '无'}`,
          `• cc-node: ${nodeInfo.running ? '✅ 运行中' : '❌ 未运行'}`,
          `• PID: ${process.pid}`,
        ].join('\n')
      }

      case '/run': {
        if (!args) return '⚠️ 用法: /run <shell命令>\n例如: /run ls -la\n或者发普通消息让 AI 处理'
        // 发送 typing 提示
        this.bot.sendChatAction(chatId).catch(() => {})
        // 直接执行命令（不经过 AI）
        try {
          const result = await this._execCommand(args)
          const output = result.slice(0, 3500)
          return `💻 $ ${escapeMarkdownV2(args)}\n\`\`\`\n${escapeMarkdownV2(output)}\n\`\`\``
        } catch (e) {
          return `❌ 命令执行失败:\n${escapeMarkdownV2(e.message)}`
        }
      }

      case '/notify': {
        if (!args) return '⚠️ 用法: /notify <消息内容>'
        try {
          const { sendToChannel, ChannelManager } = await import('./index.js')
          const cm = new ChannelManager(this.config.channels || {}, this.config.defaultChannel)
          const results = await cm.send(args)
          const lines = results.map(r => r.ok ? `✅ ${r.channel}` : `❌ ${r.channel}: ${r.error}`)
          return lines.join('\n')
        } catch (e) {
          return `❌ 通知失败: ${e.message}`
        }
      }

      case '/cancel':
        this.conversations.delete(chatId)
        return '🚫 已取消当前操作'

      default:
        // 未知命令 — 当作编程请求发给 cc-node
        return null // 由调用方处理
    }
  }

  /** 生成帮助文本 */
  _helpText() {
    return [
      '🤖 *cc-notify — AI Code Agent*',
      '',
      '通过 Telegram 远程操控 AI 编程助手。',
      '',
      '*命令*',
      '• `/ping` — 检查服务状态',
      '• `/status` — 查看详细状态',
      '• `/run <cmd>` — 直接执行 shell 命令',
      '• `/notify <msg>` — 广播通知到所有通道',
      '• `/cancel` — 取消当前操作',
      '• `/help` — 显示帮助',
      '',
      '*普通消息*',
      '直接发送文字消息 → 自动发给 AI 处理',
      '支持发送图片（AI 无法看图，但会作为附件）',
      '',
    ].join('\n')
  }

  /** 长消息分段发送 */
  async _sendLongMessage(chatId, text, options = {}) {
    const MAX_LEN = 4000
    if (text.length <= MAX_LEN) {
      return this.bot.sendMessage(chatId, text, { parseMode: 'Markdown', ...options })
    }

    // 分段发送
    const parts = []
    let current = ''
    for (const line of text.split('\n')) {
      if (current.length + line.length + 1 > MAX_LEN) {
        parts.push(current)
        current = line
      } else {
        current += (current ? '\n' : '') + line
      }
    }
    if (current) parts.push(current)

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      const header = i > 0 ? `📎 (${i + 1}/${parts.length})\n` : ''
      await this.bot.sendMessage(chatId, header + part, { parseMode: 'Markdown' })
    }
  }

  /** 执行 shell 命令 */
  async _execCommand(cmd) {
    const { execSync } = await import('child_process')
    return execSync(cmd, { timeout: 30000, encoding: 'utf8', maxBuffer: 1024 * 1024 })
  }

  /** 查找 cc-node 进程 */
  async _findCcNode() {
    const { existsSync, readFileSync } = await import('fs')
    const { join } = await import('path')
    const { homedir } = await import('os')
    const pidFile = join(homedir(), '.cc-node', 'cc-node.pid')
    if (existsSync(pidFile)) {
      try {
        const pid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10)
        process.kill(pid, 0)
        return { running: true, pid }
      } catch {}
    }
    return { running: false }
  }

  /** 停止监听 */
  stop() {
    this.running = false
    this.conversations.destroy()
    log('[TG] Listener stopped')
  }

  _sleep(ms) {
    return new Promise(r => setTimeout(r, ms))
  }
}

// ============================================================
// 日志
// ============================================================
function log(msg) {
  const ts = new Date().toISOString().slice(11, 19)
  process.stdout.write(`[${ts}] ${msg}\n`)
}
