/**
 * cc-notify — 通知守护进程（v2.0 增强版）
 *
 * 架构：
 *   Telegram ← Bot API → cc-notify (长轮询) → cc-node
 *   QQ ← OpenClaw QQ Bot → cc-notify (HTTP API) → cc-node
 *   HTTP API → cc-notify → cc-node
 *
 * 支持：
 * - Telegram Bot 长轮询监听（增强版）
 * - QQ Bot 消息（通过 OpenClaw 转发到 HTTP API /chat 端点）
 * - HTTP API（带 API Key 认证）
 * - C 方案智能路由（运行中 → socket 转发，未运行 → 启动新进程）
 * - 多通道消息推送
 * - API Key 自动生成 + 持久化
 *
 * 用法：
 *   cc-notify             # 前台运行
 *   cc-notify --daemon    # 后台守护进程
 *   cc-notify --stop      # 停止守护进程
 *   cc-notify --status    # 查看状态
 */
import { createServer } from 'node:http'
import {
  readFileSync, writeFileSync, unlinkSync, existsSync, appendFileSync,
  mkdirSync, openSync, closeSync,
} from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { spawn, execSync } from 'node:child_process'
import { createConnection } from 'node:net'
import crypto from 'node:crypto'
import { SOCK_DIR, SOCK_PATH, CC_NODE_PID, CC_NOTIFY_PID, CC_NOTIFY_LOG, DEFAULT_HTTP_PORT } from '../core/paths.js'
import { ChannelManager } from './index.js'

// ============================================================
// 配置加载
// ============================================================

function loadConfig() {
  // 生成或加载 API Key
  let apiKey = process.env.CC_NOTIFY_API_KEY || ''
  if (!apiKey) {
    const configDir = join(process.cwd(), '.claude-code')
    const configPath = join(configDir, 'notify-api-key.txt')
    try {
      if (existsSync(configPath)) {
        apiKey = readFileSync(configPath, 'utf8').trim()
      } else {
        apiKey = crypto.randomBytes(32).toString('hex')
        mkdirSync(configDir, { recursive: true })
        writeFileSync(configPath, apiKey, 'utf8')
        log(`[config] Generated API Key: ${apiKey.slice(0, 8)}... (saved to ${configPath})`)
      }
    } catch (e) {
      log(`[config] API Key file error: ${e.message}`)
    }
  }

  const config = {
    channels: {},
    defaultChannel: process.env.CC_NODE_CHANNEL_DEFAULT || null,
    port: parseInt(process.env.CC_NOTIFY_PORT || String(DEFAULT_HTTP_PORT), 10),
    pidFile: process.env.CC_NOTIFY_CC_NODE_PID || CC_NOTIFY_PID,
    logFile: process.env.CC_NOTIFY_LOG_FILE || CC_NOTIFY_LOG,
    ccNodePath: process.env.CC_NODE_PATH || 'cc-node',
    apiKey,

  }

  // 从 .claude-code/config.json 加载
  for (const dir of [process.cwd(), homedir()]) {
    const cfgPath = join(dir, '.claude-code', 'config.json')
    if (existsSync(cfgPath)) {
      try {
        const data = JSON.parse(readFileSync(cfgPath, 'utf8'))
        if (data.channels) Object.assign(config.channels, data.channels)
        if (data.defaultChannel && !config.defaultChannel) config.defaultChannel = data.defaultChannel
        if (data.notify?.port) config.port = data.notify.port
        if (data.notify?.ccNodePath) config.ccNodePath = data.notify.ccNodePath
        if (data.notify?.apiKey) config.apiKey = data.notify.apiKey
        // (QQ Bot config handled via channels.qqbot)
      } catch {}
    }
  }

  // 从环境变量加载通道配置
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('CC_NODE_CHANNEL_')) continue
    const rest = key.slice('CC_NODE_CHANNEL_'.length)
    if (rest === 'DEFAULT') continue
    const parts = rest.split('_')
    const type = parts[0].toLowerCase()
    const param = parts.slice(1).join('_').toLowerCase()
    if (!config.channels[type]) config.channels[type] = { type }
    const camelKey = param.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
    config.channels[type][camelKey] = value
  }

  log(`[config] Channels: ${Object.keys(config.channels).join(', ') || 'none'}`)
  log(`[config] Default channel: ${config.defaultChannel || 'none'}`)
  log(`[config] QQ Bot appId: ${config.channels?.qqbot?.appId || process.env.CC_NODE_CHANNEL_QQBOT_APPID ? 'configured' : 'not set'}`)
  return config
}

// ============================================================
// 通道发送
// ============================================================

async function sendToChannel(channels, defaultChannel, text) {
  const cm = new ChannelManager({ channels }, defaultChannel)
  return await cm.send(text)
}

// ============================================================
// 进程发现 — cc-node 是否在跑？
// ============================================================

function findCcNode() {
  if (existsSync(SOCK_PATH)) {
    return new Promise((resolve) => {
      const client = createConnection(SOCK_PATH, () => {
        client.end()
        resolve({ running: true, socketPath: SOCK_PATH })
      })
      client.on('error', () => {
        try { unlinkSync(SOCK_PATH) } catch {}
        resolve({ running: false })
      })
      setTimeout(() => {
        client.destroy()
        resolve({ running: false })
      }, 2000)
    })
  }
  if (existsSync(CC_NODE_PID)) {
    const pid = parseInt(readFileSync(CC_NODE_PID, 'utf8').trim(), 10)
    try {
      process.kill(pid, 0)
      return { running: true, pid }
    } catch {
      try { unlinkSync(CC_NODE_PID) } catch {}
    }
  }
  return { running: false }
}

// ============================================================
// 消息路由 — C 方案核心
// ============================================================

function sendToExistingNode(socketPath, text) {
  return new Promise((resolve, reject) => {
    const client = createConnection(socketPath, () => {
      const msg = JSON.stringify({ type: 'user_input', text })
      client.write(msg + '\n')
    })
    let buffer = ''
    client.on('data', (data) => {
      buffer += data.toString()
      const lines = buffer.split('\n')
      if (lines.length > 1) {
        try {
          const response = JSON.parse(lines[0])
          client.end()
          resolve(response)
        } catch {
          client.end()
          resolve({ type: 'reply', text: buffer.trim() })
        }
      }
    })
    client.on('error', (err) => reject(err))
    setTimeout(() => {
      client.destroy()
      reject(new Error('timeout waiting for cc-node reply'))
    }, 120000)
  })
}

function spawnNewNode(ccNodePath, text) {
  return new Promise((resolve) => {
    const timeout = 180000  // 3分钟超时
    let timer = setTimeout(() => {
      child.kill()
      resolve({ type: 'reply', text: '⏰ 执行超时（3 分钟）' })
    }, timeout)
    try {
      const child = spawn(ccNodePath, [text], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, CC_NODE_ONESHOT: '1' },
        timeout,
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (d) => (stdout += d.toString()))
      child.stderr.on('data', (d) => (stderr += d.toString()))
      child.on('close', (code) => {
        clearTimeout(timer)
        timer = null
        if (stdout.trim()) {
          resolve({ type: 'reply', text: stdout.trim().slice(0, 4000) })
        } else if (stderr.trim()) {
          resolve({ type: 'reply', text: `❌ Error: ${stderr.trim().slice(0, 1000)}` })
        } else {
          resolve({ type: 'reply', text: `(completed with code ${code})` })
        }
      })
      child.on('error', (e) => {
        clearTimeout(timer)
        timer = null
        resolve({ type: 'reply', text: `❌ Failed: ${e.message}` })
      })
    } catch (e) {
      clearTimeout(timer)
      timer = null
      resolve({ type: 'reply', text: `❌ Failed: ${e.message}` })
    }
  })
}

async function routeMessage(text, config) {
  const nodeInfo = await findCcNode()
  if (nodeInfo.running && nodeInfo.socketPath) {
    log(`[route] cc-node running → forwarding via socket`)
    try {
      const reply = await sendToExistingNode(nodeInfo.socketPath, text)
      return reply.text || JSON.stringify(reply)
    } catch (e) {
      log(`[route] socket forward failed: ${e.message} → spawning new`)
      return (await spawnNewNode(config.ccNodePath, text)).text
    }
  } else if (nodeInfo.running && nodeInfo.pid) {
    log(`[route] cc-node running (PID ${nodeInfo.pid}) but no socket → spawning new (one-shot mode)`)
    return (await spawnNewNode(config.ccNodePath, text)).text
  } else {
    log(`[route] cc-node not running → spawning new`)
    return (await spawnNewNode(config.ccNodePath, text)).text
  }
}

// ============================================================
// Telegram 监听器（动态加载）
// ============================================================

async function createTelegramListener(config) {
  try {
    const { TelegramListener } = await import('./tg-listener.js')
    const listener = new TelegramListener(config)
    return listener
  } catch (e) {
    log(`[TG] Failed to load tg-listener: ${e.message}`)
    return null
  }
}

// ============================================================
// ============================================================



// ============================================================
// 统一消息处理器
// ============================================================

function createMessageHandler(config) {
  return async (msg) => {
    const { text, channel, chatId, from, replyTo, messageId } = msg

    if (!text) return

    log(`[msg] ${channel} ← ${from || '?'}: ${text.slice(0, 60)}`)

    const isTelegram = channel === 'telegram' || channel === 'telegram_callback'
    const isQQBot = channel === 'qqbot'

    const lowerText = text.trim().toLowerCase()

    // /ping
    if (lowerText === '/ping' || lowerText === 'ping') {
      const reply = '🏓 pong! cc-notify is alive.'
      if (isTelegram) {
        const { TelegramListener } = await import('./tg-listener.js')
        const tl = new TelegramListener(config)
        if (tl.bot) await tl.bot.sendMessage(chatId, reply, { replyTo })
      }
      if (isQQBot) {
        await sendToChannel(config.channels, 'qqbot', reply)
      }
      return
    }

    // /status
    if (lowerText === '/status' || lowerText === 'status') {
      const nodeInfo = await findCcNode()
      const chNames = Object.keys(config.channels || {})
      const reply = [
        '📊 cc-notify status',
        `• Uptime: ${Math.floor(process.uptime())}s`,
        `• Channels: ${chNames.join(', ') || 'none'}`,
        `• cc-node: ${nodeInfo.running ? '✅ running' : '❌ not running'}`,
        `• PID: ${process.pid}`,
      ].join('\n')

      if (isTelegram) {
        const { TelegramListener } = await import('./tg-listener.js')
        const tl = new TelegramListener(config)
        if (tl.bot) await tl.bot.sendMessage(chatId, reply, { replyTo })
      }
      if (isQQBot) {
        await sendToChannel(config.channels, 'qqbot', reply)
      }
      return
    }

    // /help
    if (lowerText === '/help' || lowerText === 'help' || lowerText === '/start') {
      const reply = [
        '🤖 cc-notify — Remote AI Code Agent',
        '',
        'Send any message → AI processes it as a programming task.',
        '',
        'Commands:',
        '  /ping    — Check service status',
        '  /status  — View detailed status',
        '  /run cmd — Execute shell command directly',
        '  /notify  — Broadcast notification to all channels',
        '  /cancel  — Cancel current operation',
      ].join('\n')

      if (isTelegram) {
        const { TelegramListener } = await import('./tg-listener.js')
        const tl = new TelegramListener(config)
        if (tl.bot) await tl.bot.sendMessage(chatId, reply, { replyTo })
      }
      if (isQQBot) {
        await sendToChannel(config.channels, 'qqbot', reply)
      }
      return
    }

    // /run — 直接执行命令
    if (lowerText.startsWith('/run ') || lowerText.startsWith('run ')) {
      const cmd = text.replace(/^\/(run|run)\s+/i, '').trim()
      try {
        const output = execSync(cmd, { timeout: 30000, encoding: 'utf8', maxBuffer: 1024 * 1024 })
        const reply = `💻 $ ${cmd}\n\n${output.trim().slice(0, 3500)}`

        if (isTelegram) {
          const { TelegramListener } = await import('./tg-listener.js')
          const tl = new TelegramListener(config)
          if (tl.bot) {
            const escaped = '```\n' + output.trim().slice(0, 3500) + '\n```'
            await tl.bot.sendMessage(chatId, `💻 $ ${cmd}\n${escaped}`, { replyTo })
          }
        }
        if (isQQBot) {
          await sendToChannel(config.channels, 'qqbot', reply.slice(0, 2000))
        }
      } catch (e) {
        const reply = `❌ Command failed:\n${e.message}`
        if (isTelegram) {
          const { TelegramListener } = await import('./tg-listener.js')
          const tl = new TelegramListener(config)
          if (tl.bot) await tl.bot.sendMessage(chatId, reply, { replyTo })
        }
        if (isQQBot) {
          await sendToChannel(config.channels, 'qqbot', reply)
        }
      }
      return
    }

    // /notify — 广播
    if (lowerText.startsWith('/notify ')) {
      const notifyText = text.replace('/notify ', '')
      try {
        const results = await sendToChannel(config.channels, null, notifyText)
        const reply = results.map(r => r.ok ? `✅ ${r.channel}` : `❌ ${r.channel}: ${r.error}`).join('\n')
        if (isTelegram) {
          const { TelegramListener } = await import('./tg-listener.js')
          const tl = new TelegramListener(config)
          if (tl.bot) await tl.bot.sendMessage(chatId, reply, { replyTo })
        }
        if (isQQBot) {
          await sendToChannel(config.channels, 'qqbot', reply)
        }
      } catch (e) {
        log(`[notify] broadcast error: ${e.message}`)
      }
      return
    }

    // /cancel
    if (lowerText === '/cancel') {
      const reply = '🚫 Cancelled.'
      if (isTelegram) {
        const { TelegramListener } = await import('./tg-listener.js')
        const tl = new TelegramListener(config)
        if (tl.bot) await tl.bot.sendMessage(chatId, reply, { replyTo })
      }
      if (isQQBot) {
        await sendToChannel(config.channels, 'qqbot', reply)
      }
      return
    }

    // ============================================================
    // 普通消息 → C 方案路由：发给 cc-node 处理
    // ============================================================
    log(`[route] processing: "${text.slice(0, 50)}${text.length > 50 ? '...' : ''}"`)

    // 发送"处理中"提示
    if (isTelegram && config.channels.telegram?.token) {
      try {
        await fetch(`https://api.telegram.org/bot${config.channels.telegram.token}/sendChatAction`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
        })
      } catch {}
    }
    if (isQQBot) {
      await sendToChannel(config.channels, 'qqbot', '🤖 收到，正在处理...')
    }

    try {
      const result = await routeMessage(text, config)
      const reply = result || '(no response)'

      if (isTelegram && config.channels.telegram?.token) {
        const { TelegramListener } = await import('./tg-listener.js')
        const tl = new TelegramListener(config)
        if (tl.bot) {
          if (reply.length > 4000) {
            const parts = []
            let cur = ''
            for (const line of reply.split('\n')) {
              if (cur.length + line.length > 3800) { parts.push(cur); cur = line }
              else { cur += (cur ? '\n' : '') + line }
            }
            if (cur) parts.push(cur)
            for (let i = 0; i < parts.length; i++) {
              const header = i > 0 ? `📎 (${i + 1}/${parts.length})\n` : ''
              await tl.bot.sendMessage(chatId, header + parts[i], { replyTo: i === 0 ? replyTo : undefined })
              await new Promise(r => setTimeout(r, 300))
            }
          } else {
            await tl.bot.sendMessage(chatId, reply, { replyTo })
          }
        }
      }

      if (isQQBot) {
        await sendToChannel(config.channels, 'qqbot', reply.slice(0, 2000))
      }

      log(`[route] done (${reply.length} chars)`)

    } catch (e) {
      log(`[route] error: ${e.message}`)
      const errMsg = `❌ Error processing: ${e.message}`
      if (isTelegram && config.channels.telegram?.token) {
        try {
          const { TelegramListener } = await import('./tg-listener.js')
          const tl = new TelegramListener(config)
          if (tl.bot) await tl.bot.sendMessage(chatId, errMsg, { replyTo })
        } catch {}
      }
      if (isQQBot) {
        try { await sendToChannel(config.channels, 'qqbot', errMsg) } catch {}
      }
    }
  }
}

// ============================================================
// HTTP API — 带 API Key 认证
// ============================================================

class HttpServer {
  constructor(config) {
    this.config = config
    this.server = null
  }

  _validateApiKey(req) {
    const authHeader = req.headers['x-api-key'] || ''
    const url = new URL(req.url, `http://localhost`)
    const queryKey = url.searchParams.get('api_key') || ''
    const providedKey = authHeader || queryKey

    if (!providedKey) {
      return { valid: false, error: 'API Key required. Use X-API-Key header or ?api_key=xxx' }
    }
    if (providedKey !== this.config.apiKey) {
      return { valid: false, error: 'Invalid API Key' }
    }
    return { valid: true }
  }

  start(onMessage) {
    this.server = createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:${this.config.port}`)
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key')

      if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
      }

      // /status 端点无需认证
      const needsAuth = !(req.method === 'GET' && url.pathname === '/status')
      if (needsAuth) {
        const authResult = this._validateApiKey(req)
        if (!authResult.valid) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: authResult.error }))
          return
        }
      }

      try {
        if (req.method === 'GET' && url.pathname === '/status') {
          const nodeInfo = await findCcNode()
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            status: 'running',
            version: '2.0',
            channels: Object.keys(this.config.channels),
            defaultChannel: this.config.defaultChannel,
            uptime: Math.floor(process.uptime()),
            ccNodeRunning: nodeInfo.running,
            pid: process.pid,
            apiKeyPrefix: this.config.apiKey.slice(0, 8) + '...',
            qqbot: this.config.channels?.qqbot?.appId ? 'configured' : 'not set',
          }))

        } else if (req.method === 'POST' && url.pathname === '/send') {
          const body = JSON.parse(await readBody(req))
          const { text, channel } = body
          if (!text) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'text is required' }))
            return
          }
          const results = await sendToChannel(this.config.channels, channel || this.config.defaultChannel, text)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ results }))

        } else if (req.method === 'POST' && url.pathname === '/chat') {
          const body = JSON.parse(await readBody(req))
          const { text, channel, from, replyTo, messageId, target } = body
          if (!text) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'text is required' }))
            return
          }

          // 构建消息对象
          const msg = {
            text,
            channel: channel || 'http',
            chatId: target || '',
            from: from || 'API',
            replyTo: replyTo || undefined,
            messageId: messageId || undefined,
          }

          await onMessage(msg)
          // onMessage 自己发送回复，这里只返回 ack
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ status: 'processing' }))

        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'not found' }))
        }
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: e.message }))
      }
    })

    this.server.listen(this.config.port, () => {
      log(`[http] API: http://localhost:${this.config.port} (API Key protected)`)
    })
  }

  stop() {
    this.server?.close()
  }
}

// ============================================================
// 守护进程管理
// ============================================================

function startDaemon(config) {
  if (existsSync(config.pidFile)) {
    const pid = parseInt(readFileSync(config.pidFile, 'utf8').trim(), 10)
    try {
      process.kill(pid, 0)
      console.error(`cc-notify already running (PID ${pid})`)
      process.exit(1)
    } catch {
      try { unlinkSync(config.pidFile) } catch {}
    }
  }
  const child = spawn(process.execPath, [import.meta.url], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, CC_NOTIFY_DAEMON: '1' },
  })
  child.unref()
  console.log(`cc-notify daemon started (PID ${child.pid})`)
  console.log(`PID: ${config.pidFile}`)
  console.log(`Log: ${config.logFile}`)
  console.log(`HTTP: http://localhost:${config.port}`)
  console.log(`API Key: ${config.apiKey.slice(0, 8)}...`)
  process.exit(0)
}

function stopDaemon(config) {
  if (!existsSync(config.pidFile)) {
    console.log('cc-notify not running')
    process.exit(0)
  }
  const pid = parseInt(readFileSync(config.pidFile, 'utf8').trim(), 10)
  try {
    process.kill(pid, 'SIGTERM')
    console.log(`cc-notify stopped (PID ${pid})`)
  } catch {
    console.log(`PID ${pid} not found`)
  }
  try { unlinkSync(config.pidFile) } catch {}
  process.exit(0)
}

function showStatus(config) {
  if (!existsSync(config.pidFile)) {
    console.log('cc-notify not running')
    process.exit(0)
  }
  const pid = parseInt(readFileSync(config.pidFile, 'utf8').trim(), 10)
  try {
    process.kill(pid, 0)
    console.log(`cc-notify running (PID ${pid})`)
    fetch(`http://localhost:${config.port}/status`)
      .then(r => r.json())
      .then(d => console.log(JSON.stringify(d, null, 2)))
      .catch(() => console.log('(HTTP API not responding)'))
  } catch {
    console.log(`PID ${pid} is dead`)
    try { unlinkSync(config.pidFile) } catch {}
  }
}

// ============================================================
// 工具函数
// ============================================================

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function readBody(req) {
  return new Promise((r) => {
    let b = ''
    req.on('data', (d) => (b += d))
    req.on('end', () => r(b))
  })
}

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19)
  const line = `[${ts}] ${msg}\n`
  process.stdout.write(line)
  try { appendFileSync(CC_NOTIFY_LOG, line) } catch {}
}

// ============================================================
// 主入口
// ============================================================

async function main() {
  const config = loadConfig()
  const args = process.argv.slice(2)

  if (args.includes('--stop')) return stopDaemon(config)
  if (args.includes('--status')) return showStatus(config)
  if (args.includes('--daemon')) return startDaemon(config)

  // 确保 socket 目录存在
  mkdirSync(SOCK_DIR, { recursive: true })

  // PID 文件 — 原子锁
  let pidAcquired = false
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(config.pidFile, 'wx')
      writeFileSync(fd, String(process.pid))
      closeSync(fd)
      pidAcquired = true
      break
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      const oldPid = parseInt(readFileSync(config.pidFile, 'utf8').trim(), 10)
      try {
        process.kill(oldPid, 0)
        console.error(`cc-notify already running (PID ${oldPid}). Use --stop first.`)
        process.exit(1)
      } catch {
        try { unlinkSync(config.pidFile) } catch {}
        if (attempt < 2) await sleep(100)
      }
    }
  }
  if (!pidAcquired) writeFileSync(config.pidFile, String(process.pid))

  // 创建统一消息处理器
  const onMessage = createMessageHandler(config)

  // 清理函数
  const cleanup = () => {
    log('[main] Shutting down...')
    tgListener?.stop()
    httpServer?.stop()
    try { unlinkSync(config.pidFile) } catch {}
    log('[main] Goodbye!')
    process.exit(0)
  }
  process.on('SIGTERM', cleanup)
  process.on('SIGINT', cleanup)

  log('╔══════════════════════════════════════╗')
  log('║     cc-notify v2.0 — 启动中...      ║')
  log('╚══════════════════════════════════════╝')

  // ============================================================
  // 启动 Telegram 监听器
  // ============================================================
  let tgListener = null
  if (config.channels.telegram?.token) {
    tgListener = await createTelegramListener(config)
    if (tgListener) {
      tgListener.start(async (msg) => {
        msg.channel = 'telegram'
        await onMessage(msg)
      }).catch(e => log(`[main] TG listener error: ${e.message}`))
      log('[main] ✅ Telegram listener started')
    }
  }

  // ============================================================
  // 启动 QQ Bot 监听器
  // ============================================================
  let qqBot = null
  const qqAppId = (
    config.channels?.qqbot?.appId
    || process.env.CC_NODE_CHANNEL_QQBOT_APPID
    || ''
  )
  const qqSecret = (
    config.channels?.qqbot?.secret
    || config.channels?.qqbot?.clientSecret
    || process.env.CC_NODE_CHANNEL_QQBOT_SECRET
    || ''
  )

  if (qqAppId && qqSecret) {
    try {
      const { QQBot } = await import('./qqbot-listener.js')
      qqBot = new QQBot({ appId: qqAppId, clientSecret: qqSecret })
      qqBot.listen(async (msg) => {
        await onMessage(msg)
      }).catch(e => log('[main] QQ listener error: ' + e.message))
      log('[main] ✅ QQ Bot WebSocket listener started')
    } catch (e) {
      log('[main] ⚠️  QQ Bot load failed: ' + e.message)
    }
  } else {
    log('[main] ℹ️  QQ Bot not configured (set CC_NODE_CHANNEL_QQBOT_APPID + CC_NODE_CHANNEL_QQBOT_SECRET)')
  }

  // 启动 HTTP API
  // ============================================================
  const httpServer = new HttpServer(config)
  httpServer.start(onMessage)

  // ============================================================
  // 状态报告
  // ============================================================
  const activeListeners = []
  if (tgListener) activeListeners.push('Telegram')
  if (qqBot) activeListeners.push('QQBot')

  log('╔══════════════════════════════════════╗')
  log('║   cc-notify v2.0  READY ✅          ║')
  log('╠══════════════════════════════════════╣')
  log(`║ Listeners: ${activeListeners.join(', ') || 'HTTP only'}`)
  log(`║ HTTP API: http://localhost:${config.port}`)
  log(`║ API Key:  ${config.apiKey.slice(0, 8)}...`)
  log(`║ PID:      ${process.pid}`)
  log('╚══════════════════════════════════════╝')

  // Keep alive
  setInterval(() => {}, 60000)
}

main().catch((err) => {
  console.error('Fatal error:', err.message)
  process.exit(1)
})
