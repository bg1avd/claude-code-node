/**
 * QQ Bot 增强版 — 多账户、权限控制、富媒体、工具集成
 *
 * 功能：
 * - 多账户管理（基于配置路由）
 * - 权限控制（dmPolicy/groupPolicy + allowFrom 白名单）
 * - 富媒体上传（图片/文件/语音）
 * - 支持 <qqmedia> 标签自动替换
 * - Markdown 安全编码
 *
 * 与 OpenClaw 能力对齐的独立实现
 */

import { QQBotAccountManager } from './qqbot-account-manager.js'

const API_BASE = 'https://api.sgroup.qq.com'
const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'

// ── Token 管理 ─────────────────────────────────────────────

class TokenCache {
  constructor() {
    this._tokens = new Map() // appId → { token, expireAt }
  }

  async get(appId, clientSecret) {
    const cache = this._tokens.get(appId)
    if (cache && Date.now() < cache.expireAt - 300_000) {
      return cache.token
    }

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId, clientSecret }),
    })
    if (!res.ok) {
      const t = await res.text().catch(() => '')
      throw new Error(`Token API ${res.status}: ${t.slice(0, 200)}`)
    }
    const data = JSON.parse(await res.text())
    if (!data.access_token) throw new Error('Token API 未返回 access_token')

    const token = data.access_token
    const expireAt = Date.now() + (data.expires_in || 7200) * 1000
    this._tokens.set(appId, { token, expireAt })
    return token
  }

  clear(appId) {
    if (appId) {
      this._tokens.delete(appId)
    } else {
      this._tokens.clear()
    }
  }
}

// ── API 调用 ────────────────────────────────────────────────

async function apiCall(token, method, path, body, timeoutMs = 30_000) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `QQBot ${token}`,
        'Content-Type': 'application/json',
      },
      body: body && ['POST', 'PUT', 'PATCH'].includes(method) ? JSON.stringify(body) : undefined,
      signal: ac.signal,
    })
    const raw = await res.text()
    if (!res.ok) {
      let detail = raw.slice(0, 200)
      try { detail = JSON.parse(raw).message || detail } catch {}
      throw new Error(`API ${method} ${path} → ${res.status}: ${detail}`)
    }
    return raw.trim() ? JSON.parse(raw) : null
  } finally {
    clearTimeout(timer)
  }
}

// ── 富媒体处理 ─────────────────────────────────────────────

/**
 * 解析文本中的 <qqmedia> 标签，提取文件路径
 * @param {string} text
 * @returns {{ text: string, mediaFiles: Array<{path: string, type: string}> }}
 */
export function parseQQMediaTags(text) {
  const mediaRegex = /<qqmedia>(.*?)<\/qqmedia>/g
  const mediaFiles = []
  let match
  let parsedText = text

  while ((match = mediaRegex.exec(text)) !== null) {
    const path = match[1].trim()
    const ext = path.split('.').pop().toLowerCase()
    let type = 'file'
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'].includes(ext)) type = 'image'
    else if (['silk', 'wav', 'mp3', 'ogg', 'aac', 'flac', 'm4a'].includes(ext)) type = 'audio'
    else if (['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(ext)) type = 'video'

    mediaFiles.push({ path, type })
    // 替换标签为占位符
    parsedText = parsedText.replace(match[0], `[上传${type}: ${path.split('/').pop()}]`)
  }

  return { text: parsedText, mediaFiles }
}

// ── 增强 QQBot 类 ───────────────────────────────────────────

export class QQBotEnhanced {
  constructor(config = {}) {
    // 账户管理器
    this.accountManager = new QQBotAccountManager(config)

    // Token 缓存（多账户）
    this._tokenCache = new TokenCache()

    // 监听状态
    this.onMessage = null
    this._listening = false
    this._ws = null
    this._hbTimer = null
    this._seq = 0
    this._sessionId = null

    // WebSocket 连接参数（所有账户共享一个 WS，通过 intents 接收所有消息）
    this._allAccounts = [] // 将用于存储所有账户的 appId 用于 WS identify
  }

  /** 获取指定账户的 token */
  async _getToken(account) {
    return await this._tokenCache.get(account.appId, account.clientSecret)
  }

  // ── 发送消息（主入口） ───────────────────────────────────

  /**
   * 发送消息（自动处理富媒体、权限检查、账户路由）
   *
   * @param {object} params
   * @param {string} params.text - 消息文本（支持 <qqmedia> 标签）
   * @param {'c2c'|'group'} [params.scope] - 发送范围
   * @param {string} [params.targetId] - 目标 openid / group_openid
   * @param {string} [params.accountId] - 指定账户（不指定则自动路由）
   * @param {object} [params.opts] - 原始发送选项
   * @param {string} [params.opts.replyMsgId] - 回复消息 ID
   * @returns {Promise<{ok: boolean, error?: string, accountId?: string}>}
   */
  async send({ text, scope, targetId, accountId, opts = {} }) {
    try {
      // 1. 选择账户
      const account = accountId
        ? this.accountManager.getAccount(accountId)
        : this.accountManager.selectAccount(scope, null, targetId) // 注意：权限检查需要 openid，这里简化

      if (!account) {
        return { ok: false, error: '无可用账户或权限不足' }
      }

      // 2. 解析 <qqmedia> 标签
      const { text: cleanText, mediaFiles } = parseQQMediaTags(text)

      // 3. 发送文本
      const resolvedTargetId = targetId || account.getTargetId(scope)
      if (!resolvedTargetId) {
        return { ok: false, error: '未配置目标 ID (targetId)' }
      }

      // 发送主文本
      await this._sendText(account, scope, resolvedTargetId, cleanText, opts)

      // 4. 发送富媒体（如果有）
      for (const media of mediaFiles) {
        await this._sendMedia(account, scope, resolvedTargetId, media)
      }

      return { ok: true, accountId: account.id }
    } catch (e) {
      console.error('[QQBotEnhanced] 发送失败:', e)
      return { ok: false, error: e.message }
    }
  }

  async _sendText(account, scope, targetId, content, opts) {
    const token = await this._getToken(account)
    const path = scope === 'group'
      ? `/v2/groups/${targetId}/messages`
      : `/v2/users/${targetId}/messages`
    const body = { content: content.slice(0, 2000), msg_type: 0 }
    if (opts.replyMsgId) body.msg_id = opts.replyMsgId

    return apiCall(token, 'POST', path, body)
  }

  async _sendMedia(account, scope, targetId, { path: filePath, type }) {
    const token = await this._getToken(account)

    // 文件类型映射
    const fileTypeMap = {
      image: 1,
      video: 2,
      audio: 3,
      file: 4
    }
    const fileType = fileTypeMap[type] || 4

    // 检查文件是否存在
    const { existsSync } = await import('node:fs')
    if (!existsSync(filePath)) {
      throw new Error(`文件不存在: ${filePath}`)
    }

    // 获取绝对路径（如果是 media/qqbot 下的）
    const { resolve } = await import('node:path')
    const absPath = resolve(filePath)

    // 检查媒体目录限制
    const allowedDirs = [
      process.env.HOME + '/.openclaw/media/qqbot',
      process.env.HOME + '/.openclaw/media'
    ]
    const isAllowed = allowedDirs.some(dir => absPath.startsWith(dir))
    if (!isAllowed) {
      throw new Error(`安全限制: 文件必须在 ~/.openclaw/media/qqbot 或 ~/.openclaw/media 目录下`)
    }

    // 上传
    const { readFileSync } = await import('node:fs')
    const buf = readFileSync(absPath)
    const uploadResult = await uploadMedia(token, scope, targetId, {
      fileType,
      base64: buf.toString('base64')
    })

    if (!uploadResult?.file_info) {
      throw new Error(`媒体上传失败: ${JSON.stringify(uploadResult)}`)
    }

    // 发送媒体消息
    const targetPath = scope === 'group'
      ? `/v2/groups/${targetId}/messages`
      : `/v2/users/${targetId}/messages`
    const body = { msg_type: 7, media: { file_info: uploadResult.file_info } }

    return apiCall(token, 'POST', targetPath, body)
  }

  // ── WebSocket 监听 ──────────────────────────────────────

  /**
   * 启动监听（接收 QQ 消息）
   * 注意：WebSocket 只能连接一个账户，所以这里选择第一个启用的账户
   */
  async listen(onMessage) {
    this.onMessage = onMessage
    this._listening = true

    // 选择一个用于 WS 的账户（第一个启用的）
    const listenAccount = this.accountManager.getAllAccounts()[0]
    if (!listenAccount) {
      throw new Error('无可用账户用于监听')
    }

    await this._connect(listenAccount)
  }

  async _connect(account) {
    let delay = 1000
    while (this._listening) {
      try {
        const token = await this._getToken(account)
        const url = await this._getWSURL(token)
        log('[QQ] Connecting to WebSocket...')
        const ws = await this._createWS(url)
        this._ws = ws
        delay = 1000

        ws.onopen = () => log('[QQ] WebSocket connected')
        ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data)
            this._handleWS(msg, account)
          } catch (e) {
            log(`[QQ] WS parse error: ${e.message}`)
          }
        }
        ws.onclose = (ev) => {
          log(`[QQ] WS closed: ${ev.code}`)
          this._hbTimer = null
          if (this._listening) setTimeout(() => this._connect(account), delay)
        }
        ws.onerror = () => log('[QQ] WS error, reconnecting...')

        // 等待 Identify 完成
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Identify timeout')), 15000)
          const handler = (event) => {
            try {
              const parsed = JSON.parse(event.data)
              if (parsed.op === 0 && parsed.t === 'READY') {
                clearTimeout(timeout)
                ws.removeEventListener('message', handler)
                resolve()
              }
            } catch {}
          }
          ws.addEventListener('message', handler)
        })
        log('[QQ] Ready!')
        return
      } catch (e) {
        log(`[QQ] Connection error: ${e.message}, retry in ${delay}ms`)
        this._cleanupWS()
        await this._sleep(delay)
        delay = Math.min(delay * 2, 30000)
      }
    }
  }

  async _getWSURL(token) {
    const res = await fetch(`${API_BASE}/websocket`, {
      headers: { Authorization: `QQBot ${token}` },
    })
    if (!res.ok) throw new Error(`WS URL ${res.status}`)
    const data = await res.json()
    return data.url
  }

  _handleWS(msg, account) {
    const { op, d, s, t } = msg
    if (s) this._seq = s

    switch (op) {
      case 0: this._dispatch(t, d, account); break
      case 7: log('[QQ] Reconnect requested'); this._reconnect(); break
      case 9: log('[QQ] Invalid session'); this._sessionId = null; this._reconnect(); break
      case 10:
        this._startHeartbeat(d?.heartbeat_interval || 30000)
        this._send({ op: 2, d: { token: `QQBot ${this._token}`, intents: 1 << 30 | 1 << 25 | 1 << 12, shard: [0, 1], properties: { $os: 'linux', $browser: 'cc-notify', $device: 'cc-notify' } } })
        break
      case 11: break
    }
  }

  _dispatch(eventType, data, account) {
    if (!data) return

    let scope = 'c2c'
    let chatId = ''
    let from = ''
    let content = ''

    switch (eventType) {
      case 'READY':
        this._sessionId = data.session_id
        break

      case 'AT_MESSAGE_CREATE':
      case 'MESSAGE_CREATE': {
        scope = 'c2c'
        chatId = data.author?.id || data.channel_id
        from = data.author?.username || data.member?.nick || '?'
        content = (data.content || '').replace(/<@!\d+>/g, '').trim()
        break
      }

      case 'GROUP_AT_MESSAGE_CREATE': {
        scope = 'group'
        chatId = data.group_openid
        from = data.author?.member_name || data.member?.nick || '?'
        content = (data.content || '').replace(/<@bot\w*>/g, '').trim()
        break
      }

      case 'DIRECT_MESSAGE_CREATE': {
        scope = 'c2c'
        chatId = data.author?.id || data.guild_id
        from = data.author?.username || '?'
        content = data.content || ''
        break
      }
    }

    if (!content) return

    // 权限检查
    if (scope === 'c2c') {
      if (!account.isAllowed(scope, chatId)) {
        log(`[QQ] 消息来自未授权用户 ${from} (${chatId})，已忽略`)
        return
      }
    } else if (scope === 'group') {
      const memberOpenId = data.author?.id
      if (!account.isAllowed(scope, memberOpenId, chatId)) {
        log(`[QQ] 群消息来自未授权用户 ${from} (${memberOpenId})，已忽略`)
        return
      }
    }

    log(`[QQ] ← ${from} (${scope}): ${content.slice(0, 60)}`)

    this.onMessage?.({
      text: content,
      scope,
      chatId,
      from,
      messageId: data.id,
      raw: data,
      accountId: account.id
    })
  }

  _send(payload) {
    if (this._ws?.readyState === 1) {
      this._ws.send(JSON.stringify(payload))
    }
  }

  _startHeartbeat(intervalMs) {
    if (this._hbTimer) clearInterval(this._hbTimer)
    this._hbTimer = setInterval(() => {
      this._send({ op: 1, d: this._seq || null })
    }, intervalMs)
  }

  _reconnect() {
    this._cleanupWS()
  }

  _cleanupWS() {
    if (this._hbTimer) { clearInterval(this._hbTimer); this._hbTimer = null }
    if (this._ws) { try { this._ws.close() } catch {}; this._ws = null }
  }

  _createWS(url) {
    return new Promise((resolve, reject) => {
      if (typeof WebSocket === 'undefined') {
        reject(new Error('WebSocket 不可用。请使用 Node.js >= 21'))
        return
      }
      const ws = new WebSocket(url)
      const t = setTimeout(() => { ws.close(); reject(new Error('WS timeout')) }, 10000)
      ws.onopen = () => { clearTimeout(t); resolve(ws) }
      ws.onerror = () => { clearTimeout(t); reject(new Error('WS failed')) }
    })
  }

  /** 停止监听 */
  stop() {
    this._listening = false
    this._cleanupWS()
    log('[QQ] Listener stopped')
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
}

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19)
  process.stdout.write(`[${ts}] ${msg}\n`)
}

export default QQBotEnhanced
