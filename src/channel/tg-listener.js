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

// 静态导入用于 offset 持久化（ESM 顶层导入，可在构造函数内同步使用）
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join, dirname } from 'path'

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

export class TelegramBotClient {
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
      // parseMode: null 表示降级为纯文本（去掉 parse_mode 字段）；
      // 否则默认 HTML，或用显式指定的 parseMode。
      ...(parseMode === null ? {} : { parse_mode: parseMode || 'HTML' }),
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
      // 400 可能是消息太长或格式问题 — 降级为纯文本（parseMode: null 去掉 parse_mode）
      if (data.error_code === 400 && parseMode) {
        return this.sendMessage(chatId, text, { ...options, parseMode: null })
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

  /** 获取文件下载信息（代理安全）
   *  返回对象包含 download() 方法，内部走 this._fetch（支持代理），
   *  避免直连 URL 在 SOCKS5 代理环境下无法访问的问题。
   */
  async getFile(fileId) {
    const res = await this._fetch(`${this.apiBase}/getFile`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_id: fileId }),
    })
    const data = await res.json()
    if (!data.ok) throw new Error(`TG getFile error: ${data.description}`)
    const fileUrl = `https://api.telegram.org/file/bot${this.token}/${data.result.file_path}`
    return {
      file_id: fileId,
      file_path: data.result.file_path,
      file_size: data.result.file_size,
      // 通过代理下载文件（返回原始 Response，调用方自行处理 body）
      download: async () => this._fetch(fileUrl, { method: 'GET' }),
      // 兼容旧版：直连 URL（不推荐在代理环境下使用）
      url: fileUrl,
    }
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
    // 从磁盘恢复持久化的 offset，避免进程重启后重放旧消息（含 /quit 等历史命令）
    this.lastUpdateId = this._loadOffset()
    this.running = false
    this._pollTimer = null
    this._retryDelay = 1000
    this.maxRetryDelay = 30000
    this._lastPollError = null      // 最近一次轮询错误消息（用于去抖刷屏）
    this._lastPollErrorAt = 0       // 最近一次轮询错误时间戳
    this._msgQueue = Promise.resolve()  // 消息串行处理队列（避免阻塞轮询循环）
    // 排他锁 — 解决 flushOffset 与 _poll 长轮询并发触发 getUpdates 导致 409 Conflict。
    // Telegram 同一 bot token 同一时刻只允许一个 getUpdates 长轮询。
    this._pollAbort = null          // 当前 _poll 挂起请求的 AbortController（供 flush 取消）
    this._flushLock = false         // true = flushOffset 正在独占 bot 连接
    this._polling = false           // 是否正处于 _poll 请求挂起中（await 未返回）
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

    // 设置命令菜单（Telegram 输入框 / 提示，最多 100 个命令）
    try {
      await this.bot.setMyCommands([
        // —— 系统命令（本进程处理）——
        { command: 'ping', description: '🏓 检查服务状态' },
        { command: 'status', description: '📊 查看 cc-node 状态' },
        { command: 'run', description: '💻 执行 shell 命令（如 /run ls -la）' },
        { command: 'notify', description: '📢 广播通知消息' },
        { command: 'cancel', description: '🚫 取消当前操作' },
        { command: 'help', description: '❓ 查看帮助' },
        // —— AI 编程命令（转发给 cc-node）——
        { command: 'model', description: '🤖 切换模型（如 /model gpt-4o）' },
        { command: 'models', description: '📋 列出可用模型' },
        { command: 'window', description: '🧠 查看/设置上下文窗口（如 /window 128k）' },
        { command: 'budget', description: '💰 查看 token 预算使用' },
        { command: 'compact', description: '🗜️ 手动压缩上下文' },
        { command: 'clear', description: '🧹 清空当前对话' },
        { command: 'session', description: '🗂️ 查看会话信息' },
        { command: 'sessions', description: '📂 列出所有会话' },
        { command: 'resume', description: '↩️ 恢复会话（/resume <id>）' },
        { command: 'config', description: '⚙️ 查看配置（/config model）' },
        { command: 'cost', description: '💲 查看 API 费用' },
        { command: 'channel', description: '🔔 管理通知通道' },
        { command: 'cd', description: '📁 切换工作目录' },
        { command: 'tools', description: '🛠️ 列出可用工具' },
        { command: 'stop', description: '⏹️ 停止当前 AI 任务' },
        { command: 'allow', description: '🔓 工具权限管理' },
      ])
    } catch {}

    this._poll()
  }

  /** 内部轮询 */
  async _poll() {
    while (this.running) {
      // flushOffset 持有排他锁时，不发起新的 getUpdates，避免与 flush 并发导致 409。
      // flush 会 abort 当前挂起请求并设置锁，这里等待锁释放后再继续。
      if (this._flushLock) {
        await this._sleep(50)
        continue
      }

      // 为本次请求创建 AbortController，flushOffset 可通过它取消挂起的长轮询，
      // 从而独占 bot 连接、消除 409 竞态。
      this._pollAbort = new AbortController()
      this._polling = true
      try {
        const url = `${this.bot.apiBase}/getUpdates`
        const res = await this._fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: this._pollAbort.signal,
          // 长轮询本身最多等 30s（Telegram API 参数），HTTP 层超时必须更长，
          // 否则代理路径（fetchViaSocks5）30s 硬超时会误杀长轮询 → HTTP request timeout 刷屏。
          timeout: 60000,
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
            // 推进 offset 后立即持久化到磁盘，保证进程异常退出（如 /quit）
            // 重启后从正确位置继续，不重放旧消息。
            this._saveOffset()

            // 处理回调查询（按钮点击）— 快速操作，直接 await
            if (update.callback_query) {
              await this._handleCallbackQuery(update.callback_query)
              continue
            }

            // 处理消息 — 加入串行队列异步处理，不阻塞轮询循环。
            // 否则 AI 处理上一条消息时（可能很久），getUpdates 无法继续接收
            // 新消息（如权限确认回复 a、/quit 等）。
            if (update.message) {
              this._enqueueMessage(update.message)
            }
          }
        }

        // 成功 — 重置退避
        this._retryDelay = 1000

      } catch (e) {
        // flushOffset 通过 abort 取消挂起请求以独占连接 — 属于预期中断，静默处理不告警。
        // 回到循环顶部，等待 flushOffset 释放 _flushLock 后继续轮询。
        if (this._flushLock && e.name === 'AbortError') {
          continue
        }
        // 错误去抖：连续相同的错误（如长轮询超时）只在首次/状态变化时打印，
        // 避免 AI 处理长任务时 getUpdates 空转超时不断刷屏。
        const msg = e.message || 'unknown'
        const now = Date.now()
        const isSame = msg === this._lastPollError
        const isRecent = (now - (this._lastPollErrorAt || 0)) < 60000
        if (!isSame || !isRecent) {
          log(`[TG] Poll error: ${msg} (retry in ${this._retryDelay}ms)`)
          this._lastPollError = msg
          this._lastPollErrorAt = now
        }
        await this._sleep(this._retryDelay)
        this._retryDelay = Math.min(this._retryDelay * 2, this.maxRetryDelay)
      } finally {
        // 请求结束（成功/失败/abort）— 清理挂起状态，供 flushOffset 判断 poll 已让出
        this._polling = false
        this._pollAbort = null
      }
    }
  }

  /** 异步处理一条消息（不串行排队，避免权限确认死锁） */
  _enqueueMessage(msg) {
    // 关键：不能串行排队等待前一条消息处理完。
    // 若第一条消息触发权限确认而挂起（await pendingConfirm），
    // 后续的权限确认回复 a 会排在后面积压，造成死锁（a 永远处理不到）。
    // 因此每条消息独立异步处理：权限确认回复能立即响应，普通消息由
    // processInputLine 内部处理"引擎忙"的情况。
    this._handleMessage(msg).catch((e) => {
      log(`[TG] handle error: ${e.message}`)
    })
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
        const fileInfo = await this.bot.getFile(best.file_id)
        files.push({
          type: 'photo',
          file_id: best.file_id,
          file_path: fileInfo.file_path,
          file_size: fileInfo.file_size,
          download: fileInfo.download,
          url: fileInfo.url, // 兼容保留
        })
      } catch {}
    }

    // 文档
    if (msg.document) {
      try {
        const fileInfo = await this.bot.getFile(msg.document.file_id)
        files.push({
          type: 'document',
          file_id: msg.document.file_id,
          file_path: fileInfo.file_path,
          file_size: fileInfo.file_size,
          name: msg.document.file_name,
          mime_type: msg.document.mime_type,
          download: fileInfo.download,
          url: fileInfo.url, // 兼容保留
        })
      } catch {}
    }

    log(`[TG] ← ${fromName} (${chatType}): ${text.slice(0, 60) || '(media)'}`)

    // 处理命令
    if (text.startsWith('/')) {
      const reply = await this._handleCommand(chatId, text, msg)
      if (reply) {
        // 如果回复很长，分多条发送
        await this._sendLongMessage(chatId, reply, { replyTo: msg.message_id })
        return
      }
      // _handleCommand 返回 null = 未知命令（如 /stop、/resume 等）
      // 需要转发给 cc-node 的 processInputLine 处理，不能吞掉。
      // 落到下方普通消息分支继续转发。
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
        return this._helpText()

      case '/help':
        // 无参数 → 返回完整帮助；带参数（/help <cmd>）→ 转发给 cc-node 输出详细用法
        if (!args) return this._helpText()
        return null // 交由 cli.js processInputLine 处理 /help <cmd> 详细帮助

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

  /** 生成帮助文本（含 cc-notify 系统命令 + cc-node AI 编程命令） */
  _helpText() {
    return [
      '🤖 *cc-notify — AI Code Agent*',
      '',
      '通过 Telegram 远程操控 AI 编程助手。',
      '直接发消息 → AI 处理；发 / 开头命令 → 执行对应操作。',
      '',
      '*🔧 系统命令*',
      '• `/ping` — 检查服务状态',
      '• `/status` — 查看详细状态',
      '• `/run <cmd>` — 直接执行 shell 命令',
      '• `/notify <msg>` — 广播通知到所有通道',
      '• `/cancel` — 取消当前操作',
      '',
      '*🤖 AI 编程命令*（转发给 cc-node 处理）',
      '• `/model NAME` — 切换模型（如 /model gpt-4o）',
      '• `/models` — 列出可用模型',
      '• `/window [N]` — 查看/设置上下文窗口（/window 128k、/window auto）',
      '• `/budget` — 查看 token 预算使用',
      '• `/compact` — 手动压缩上下文',
      '• `/clear` — 清空当前对话',
      '• `/session` — 查看会话信息',
      '• `/sessions` — 列出所有会话',
      '• `/resume <id>` — 恢复历史会话',
      '• `/config KEY` — 查看配置（如 /config model）',
      '• `/cost` — 查看 API 费用',
      '• `/channel` — 管理通知通道',
      '• `/cd PATH` — 切换工作目录',
      '• `/tools` — 列出可用工具',
      '• `/stop` — 停止当前 AI 任务',
      '• `/allow` — 工具权限管理',
      '',
      '*普通消息*',
      '直接发送文字 → 自动发给 AI 处理',
      '支持发送图片（AI 无法看图，但会作为附件）',
      '',
      '💡 任意 `/help <命令>` 查看某个命令的详细用法。',
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

  // ============================================================
  // Offset 持久化 — 防止进程重启后重放旧消息（含 /quit 等）
  // Telegram 的 getUpdates 用 offset 确认消费；若 offset 只存内存，
  // 进程异常退出（如 /quit 的 process.exit）后重启 lastUpdateId 归零，
  // 会重放服务器上所有未确认的 update，导致 /quit 死循环起不来。
  // 将 offset 持久化到磁盘，重启后从正确位置继续，彻底根治此问题。
  // ============================================================

  /** offset 状态文件路径 */
  _offsetFile() {
    return join(homedir(), '.cc-node', 'tg-offset.json')
  }

  /** 从磁盘加载已持久化的 offset */
  _loadOffset() {
    try {
      const file = this._offsetFile()
      if (!existsSync(file)) return 0
      const raw = readFileSync(file, 'utf8').trim()
      if (!raw) return 0
      const data = JSON.parse(raw)
      const id = Number(data.lastUpdateId) || 0
      if (id > 0) log(`[TG] Restored offset ${id} (persisted, skip replayed updates)`)
      return id
    } catch {
      return 0
    }
  }

  /** 持久化当前 offset 到磁盘 */
  _saveOffset() {
    try {
      const file = this._offsetFile()
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify({ lastUpdateId: this.lastUpdateId, updatedAt: Date.now() }), 'utf8')
    } catch (e) {
      log(`[TG] Failed to persist offset: ${e.message}`)
    }
  }

  /**
   * 退出前确认消费已接收的 update（双保险）。
   * 正常路径下 next poll 会提交 offset，但 /quit 等命令走 process.exit
   * 同步强杀进程，没有机会再 poll 一次 → 未确认的 update 残留在服务器。
   * 调用 getUpdates(offset=lastUpdateId+1) 可让 Telegram 立即确认消费。
   * 返回 Promise，调用方应 await 后再退出。
   *
   * 加固：Telegram 同一 bot token 同时只允许一个 getUpdates 长轮询，
   * 若 flush 与 _poll 正在挂起的长轮询并发，会触发 409 Conflict。
   * 因此 flush 先通过 AbortController 取消当前 _poll 请求、独占 bot 连接，
   * 再发起自己的 getUpdates，彻底消除 409 竞态。
   */
  async flushOffset() {
    if (!this.bot) return
    // 已持有排他锁（理论上不会重入，防御性直接返回）
    if (this._flushLock) return

    // 1. 取得排他锁：先取消正在挂起的 _poll 长轮询，再等它完全让出连接。
    this._flushLock = true
    try {
      if (this._pollAbort) this._pollAbort.abort()
      // 等待 _poll 从 await 返回并清理 _polling（最长 2s，防止极端情况下卡死退出）
      const deadline = Date.now() + 2000
      while (this._polling && Date.now() < deadline) {
        await this._sleep(20)
      }

      // 2. 独占发起 getUpdates 确认消费（timeout:0 立即返回，不挂长轮询）
      const url = `${this.bot.apiBase}/getUpdates`
      const res = await this._fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
        body: JSON.stringify({
          offset: this.lastUpdateId + 1,
          timeout: 0,
          allowed_updates: ['message', 'callback_query', 'edited_message'],
        }),
      })
      if (res.ok) {
        const data = await res.json()
        if (data.ok) {
          log(`[TG] Flushed offset ${this.lastUpdateId + 1} before exit`)
          return
        }
      }
    } catch {
      // flush 失败不影响退出，offset 已持久化到磁盘，双保险兜底
    } finally {
      // 3. 释放排他锁，_poll 循环顶部检测到后继续轮询（进程随即退出，正常路径用不到）
      this._flushLock = false
    }
  }
}

// ============================================================
// 日志
// ============================================================
function log(msg) {
  const ts = new Date().toISOString().slice(11, 19)
  process.stdout.write(`[${ts}] ${msg}\n`)
}
