/**
 * QQ Bot 监听器 + 发送器 — 独立、零依赖
 *
 * 基于 QQ Bot API v2
 * 认证: appId + clientSecret → access_token (自动续期)
 * 发送: /v2/users/{openid}/messages (C2C) | /v2/groups/{group_openid}/messages (群)
 * 接收: WebSocket (wss://api.sgroup.qq.com/websocket/)
 *
 * 参考: qqbot-standalone (https://github.com/bg1avd/qqbot-standalone)
 *
 * 使用:
 *   const bot = new QQBot({ appId, clientSecret })
 *   await bot.sendText('group', 'GROUP_OPENID', '你好')
 *
 *   bot.onMessage = (msg) => { ... }
 *   await bot.listen()
 */

const API_BASE = 'https://api.sgroup.qq.com'
const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'

// ── Token 管理 ─────────────────────────────────────────────

class TokenCache {
  constructor() {
    this._token = null
    this._expireAt = 0
  }

  async get(appId, clientSecret) {
    if (this._token && Date.now() < this._expireAt - 300_000) return this._token

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

    this._token = data.access_token
    this._expireAt = Date.now() + (data.expires_in || 7200) * 1000
    return this._token
  }

  clear() {
    this._token = null
    this._expireAt = 0
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

// ── 富媒体上传 ────────────────────────────────────────────

async function uploadMedia(token, scope, targetId, { fileType, url, base64 }, timeoutMs = 120_000) {
  const path = scope === 'group'
    ? `/v2/groups/${targetId}/files`
    : `/v2/users/${targetId}/files`
  const body = { file_type: fileType, srv_send_msg: false }
  if (url) body.url = url
  if (base64) body.file_data = base64
  return apiCall(token, 'POST', path, body, timeoutMs)
}

// ── 主类 ────────────────────────────────────────────────────

export class QQBot {
  /**
   * @param {object} opts
   * @param {string} opts.appId        — QQ 机器人的 AppID
   * @param {string} opts.clientSecret — QQ 机器人的 AppSecret
   */
  constructor(opts = {}) {
    this.appId = opts.appId || process.env.CC_NODE_CHANNEL_QQBOT_APPID || ''
    this.clientSecret = opts.clientSecret || process.env.CC_NODE_CHANNEL_QQBOT_SECRET || ''
    if (!this.appId || !this.clientSecret) {
      throw new Error('QQBot: 需要 appId 和 clientSecret (或设置 CC_NODE_CHANNEL_QQBOT_APPID / CC_NODE_CHANNEL_QQBOT_SECRET)')
    }
    this._tokens = new TokenCache()
    this._token = null
    this.onMessage = null   // (msg) => void
    this._listening = false
    this._sessionId = null
    this._ws = null
    this._hbTimer = null
    this._seq = 0
  }

  async _t() {
    if (!this._token) this._token = await this._tokens.get(this.appId, this.clientSecret)
    return this._token
  }

  /** 刷新 token */
  async refreshToken() {
    this._tokens.clear()
    this._token = await this._tokens.get(this.appId, this.clientSecret)
    return this._token
  }

  // ── 发送消息 ────────────────────────────────────────────

  /**
   * 发送文本消息 (API v2)
   *
   * @param {'c2c'|'group'} scope — 'c2c' 单聊, 'group' 群聊
   * @param {string} targetId     — openid (c2c) 或 group_openid (group)
   * @param {string} content      — 消息文本
   * @param {object} [opts]
   * @param {string} [opts.msgId]   — 被动回复: 原消息 ID
   * @param {string} [opts.eventId] — 被动回复: 事件 ID
   * @param {number} [opts.msgSeq]  — 回复序号
   * @returns {{ id: string, timestamp: number }}
   */
  async sendText(scope, targetId, content, opts = {}) {
    const token = await this._t()
    const path = scope === 'group'
      ? `/v2/groups/${targetId}/messages`
      : `/v2/users/${targetId}/messages`
    const body = { content: content.slice(0, 2000), msg_type: 0 }
    if (opts.msgId) body.msg_id = opts.msgId
    if (opts.eventId) body.event_id = opts.eventId
    if (opts.msgSeq) body.msg_seq = opts.msgSeq
    return apiCall(token, 'POST', path, body)
  }

  /**
   * 发送图片
   *
   * @param {'c2c'|'group'} scope
   * @param {string} targetId
   * @param {string} source — URL 或本地路径
   * @param {object} [opts]
   */
  async sendImage(scope, targetId, source, opts = {}) {
    return this._sendMedia(scope, targetId, 1, source, opts)
  }

  /**
   * 发送文件 (仅 C2C)
   *
   * @param {'c2c'} scope
   * @param {string} targetId
   * @param {string} source — URL 或本地路径
   * @param {object} [opts]
   */
  async sendFile(scope, targetId, source, opts = {}) {
    return this._sendMedia(scope, targetId, 4, source, opts)
  }

  async _sendMedia(scope, targetId, fileType, source, opts = {}) {
    const token = await this._t()

    let mediaResult
    if (source.startsWith('http://') || source.startsWith('https://')) {
      mediaResult = await uploadMedia(token, scope, targetId, { fileType, url: source })
    } else {
      const { readFileSync } = await import('node:fs')
      const buf = readFileSync(source)
      mediaResult = await uploadMedia(token, scope, targetId, { fileType, base64: buf.toString('base64') })
    }

    if (!mediaResult?.file_info) {
      throw new Error(`上传失败: ${JSON.stringify(mediaResult)}`)
    }

    const path = scope === 'group'
      ? `/v2/groups/${targetId}/messages`
      : `/v2/users/${targetId}/messages`
    const body = { msg_type: 7, media: { file_info: mediaResult.file_info } }
    if (opts.msgId) body.msg_id = opts.msgId

    return apiCall(token, 'POST', path, body)
  }

  // ── WebSocket 监听 ──────────────────────────────────────

  /**
   * 启动 WebSocket 消息监听
   *
   * @param {function} [onMessage] — (msg) => void
   *  msg = { text, scope: 'c2c'|'group', chatId, from, messageId, raw }
   */
  async listen(onMessage) {
    if (onMessage) this.onMessage = onMessage
    this._listening = true
    log('[QQ] Starting WebSocket listener...')
    await this._connect()
  }

  async _connect() {
    let delay = 1000
    while (this._listening) {
      try {
        const token = await this._t()
        const url = await this._getWSURL()
        log(`[QQ] Connecting to WebSocket...`)
        const ws = await this._createWS(url)
        this._ws = ws
        delay = 1000

        ws.onopen = () => log('[QQ] WebSocket connected')
        ws.onmessage = (event) => {
          try { this._handleWS(JSON.parse(event.data)) } catch (e) {
            log(`[QQ] WS parse error: ${e.message}`)
          }
        }
        ws.onclose = (ev) => {
          log(`[QQ] WS closed: ${ev.code}`)
          this._hbTimer = null
          if (this._listening) setTimeout(() => this._connect(), delay)
        }
        ws.onerror = () => log('[QQ] WS error, reconnecting...')

        // 等待 Identify 完成
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Identify timeout')), 15000)
          const handler = (event) => {
            try {
              const msg = JSON.parse(event.data)
              if (msg.op === 0 && msg.t === 'READY') {
                clearTimeout(timeout)
                ws.removeEventListener('message', handler)
                resolve()
              }
            } catch {}
          }
          ws.addEventListener('message', handler)
        })
        log('[QQ] Ready!')
        return  // 连接成功
      } catch (e) {
        log(`[QQ] Connection error: ${e.message}, retry in ${delay}ms`)
        this._cleanupWS()
        await this._sleep(delay)
        delay = Math.min(delay * 2, 30000)
      }
    }
  }

  async _getWSURL() {
    const token = await this._t()
    const res = await fetch(`${API_BASE}/websocket`, {
      headers: { Authorization: `QQBot ${token}` },
    })
    if (!res.ok) throw new Error(`WS URL ${res.status}`)
    const data = await res.json()
    return data.url
  }

  _handleWS(msg) {
    const { op, d, s, t } = msg
    if (s) this._seq = s

    switch (op) {
      case 0: this._dispatch(t, d); break
      case 7: log('[QQ] Reconnect requested'); this._reconnect(); break
      case 9: log('[QQ] Invalid session'); this._sessionId = null; this._reconnect(); break
      case 10:
        this._startHeartbeat(d?.heartbeat_interval || 30000)
        this._send({ op: 2, d: { token: `QQBot ${this._token}`, intents: 1 << 30 | 1 << 25 | 1 << 12, shard: [0, 1], properties: { $os: 'linux', $browser: 'cc-notify', $device: 'cc-notify' } } })
        break
      case 11: break
    }
  }

  _dispatch(eventType, data) {
    if (!data) return
    switch (eventType) {
      case 'READY':
        this._sessionId = data.session_id
        break
      case 'AT_MESSAGE_CREATE':
      case 'MESSAGE_CREATE': {
        const content = (data.content || '').replace(/<@!\d+>/g, '').trim()
        if (!content) return
        this._emitMsg({
          text: content,
          scope: 'c2c',
          chatId: data.author?.id || data.channel_id,
          from: data.author?.username || data.member?.nick || '?',
          messageId: data.id,
          raw: data,
        })
        break
      }
      case 'GROUP_AT_MESSAGE_CREATE': {
        const content = (data.content || '').replace(/<@bot\w*>/g, '').trim()
        if (!content) return
        this._emitMsg({
          text: content,
          scope: 'group',
          chatId: data.group_openid,
          from: data.author?.member_name || '?',
          messageId: data.id,
          raw: data,
        })
        break
      }
      case 'DIRECT_MESSAGE_CREATE': {
        const content = data.content || ''
        if (!content) return
        this._emitMsg({
          text: content,
          scope: 'c2c',
          chatId: data.author?.id || data.guild_id,
          from: data.author?.username || '?',
          messageId: data.id,
          raw: data,
        })
        break
      }
    }
  }

  _emitMsg(msg) {
    log(`[QQ] ← ${msg.from} (${msg.scope}): ${msg.text.slice(0, 60)}`)
    this.onMessage?.(msg)
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
    // _cleanupWS() 会触发 onclose → onclose 里已有重连逻辑
    // 这里不再重复调用 _connect()，避免双重连接循环
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

export default QQBot
