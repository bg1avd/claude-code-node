#!/usr/bin/env node
/**
 * cc-notify — 轻量通知守护进程
 * 
 * 独立于 cc-node 运行，常驻后台，提供：
 *   1. Telegram Bot 长轮询监听（手机发消息 → 处理 → 回复）
 *   2. HTTP API 接口（其他程序调用发通知）
 *   3. Webhook 接收器（接收外部事件触发通知）
 * 
 * 用法：
 *   cc-notify                              # 前台运行
 *   cc-notify --daemon                     # 后台守护进程
 *   cc-notify --daemon --pidfile /tmp/cc.pid  # 指定 PID 文件
 *   cc-notify --stop                       # 停止守护进程
 *   cc-notify --status                     # 查看状态
 *   
 *   # HTTP API（守护模式可用）
 *   curl -X POST http://localhost:3456/send -d '{"text":"hello"}'
 *   curl http://localhost:3456/status
 */

import { createServer } from 'http'
import { readFileSync, writeFileSync, unlinkSync, existsSync, appendFileSync } from 'fs'
import { resolve, join } from 'path'
import { homedir } from 'os'
import { spawn, execSync } from 'child_process'

// ============================================================
// 配置
// ============================================================

const DEFAULT_PORT = 3456
const DEFAULT_PID_FILE = join(homedir(), '.cc-notify.pid')
const DEFAULT_LOG_FILE = join(homedir(), '.cc-notify.log')
const POLL_INTERVAL_MS = 3000 // Telegram 长轮询间隔

function loadConfig() {
  // 1. 环境变量
  const config = {
    channels: {},
    defaultChannel: process.env.CC_NODE_CHANNEL_DEFAULT || null,
    port: parseInt(process.env.CC_NOTIFY_PORT || '3456', 10),
    pidFile: process.env.CC_NOTIFY_PID_FILE || DEFAULT_PID_FILE,
    logFile: process.env.CC_NOTIFY_LOG_FILE || DEFAULT_LOG_FILE,
    ccNodePath: process.env.CC_NODE_PATH || 'cc-node',
  }

  // 2. 从 .claude-code/config.json 加载
  for (const dir of [process.cwd(), homedir()]) {
    const cfgPath = join(dir, '.claude-code', 'config.json')
    if (existsSync(cfgPath)) {
      try {
        const data = JSON.parse(readFileSync(cfgPath, 'utf8'))
        if (data.channels) {
          Object.assign(config.channels, data.channels)
        }
        if (data.defaultChannel && !config.defaultChannel) {
          config.defaultChannel = data.defaultChannel
        }
        if (data.notify?.port) config.port = data.notify.port
        if (data.notify?.ccNodePath) config.ccNodePath = data.notify.ccNodePath
      } catch {}
    }
  }

  // 3. 环境变量覆盖（CC_NODE_CHANNEL_*）
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

  return config
}

// ============================================================
// 通道适配器（复用 cc-node 的逻辑，独立实现避免依赖）
// ============================================================

async function sendTelegram(config, text) {
  const url = `https://api.telegram.org/bot${config.token}/sendMessage`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: config.chatId, text, parse_mode: 'Markdown' }),
  })
  return res.json()
}

async function sendWebhook(url, text, parseMode) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, msgtype: parseMode === 'markdown' ? 'markdown' : 'text' }),
  })
  return res.text()
}

async function sendToChannel(channels, defaultChannel, text) {
  const targets = defaultChannel ? [defaultChannel] : Object.keys(channels)
  const results = []
  for (const name of targets) {
    const ch = channels[name]
    if (!ch) { results.push({ channel: name, ok: false, error: 'not configured' }); continue }
    try {
      if (ch.type === 'telegram') {
        const r = await sendTelegram(ch, text)
        results.push({ channel: name, ok: r.ok || false, result: r })
      } else if (ch.webhookUrl) {
        const r = await sendWebhook(ch.webhookUrl, text)
        results.push({ channel: name, ok: true, result: r })
      } else {
        results.push({ channel: name, ok: false, error: 'unknown type' })
      }
    } catch (e) {
      results.push({ channel: name, ok: false, error: e.message })
    }
  }
  return results
}

// ============================================================
// Telegram Bot 长轮询（接收手机消息）
// ============================================================

class TelegramListener {
  constructor(config) {
    this.config = config
    this.lastUpdateId = 0
    this.running = false
    this.handlers = []  // 消息处理器
  }

  onMessage(handler) {
    this.handlers.push(handler)
  }

  async start() {
    const ch = this.config.channels.telegram
    if (!ch?.token) {
      log('Telegram listener: no token, skipping')
      return
    }
    this.running = true
    log('Telegram listener: started (long polling)')
    this._poll()
  }

  stop() {
    this.running = false
  }

  async _poll() {
    while (this.running) {
      try {
        const url = `https://api.telegram.org/bot${this.config.channels.telegram.token}/getUpdates`
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            offset: this.lastUpdateId + 1,
            timeout: 30, // 长轮询超时
            allowed_updates: ['message'],
          }),
        })
        const data = await res.json()

        if (data.ok && data.result?.length) {
          for (const update of data.result) {
            this.lastUpdateId = update.update_id
            if (update.message?.text) {
              const msg = {
                text: update.message.text,
                chatId: update.message.chat.id,
                from: update.message.from?.username || update.message.from?.first_name || 'unknown',
                date: new Date(update.message.date * 1000),
              }
              log(`Telegram msg from ${msg.from}: ${msg.text.slice(0, 80)}`)
              for (const handler of this.handlers) {
                try { await handler(msg) } catch (e) { log(`Handler error: ${e.message}`) }
              }
            }
          }
        }
      } catch (e) {
        log(`Telegram poll error: ${e.message}`)
        await sleep(5000) // 出错后等 5 秒重试
      }
    }
  }
}

// ============================================================
// HTTP API 服务
// ============================================================

class HttpServer {
  constructor(config, channels) {
    this.config = config
    this.channels = channels
    this.server = null
  }

  start() {
    this.server = createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:${this.config.port}`)

      // CORS
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

      try {
        if (req.method === 'GET' && url.pathname === '/status') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            status: 'running',
            channels: Object.keys(this.channels),
            defaultChannel: this.config.defaultChannel,
            uptime: process.uptime(),
          }))
        } else if (req.method === 'POST' && url.pathname === '/send') {
          const body = await readBody(req)
          const { text, channel, parseMode } = JSON.parse(body)
          if (!text) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'text is required' }))
            return
          }
          const results = await sendToChannel(
            this.channels,
            channel || this.config.defaultChannel,
            text
          )
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ results }))
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
      log(`HTTP API listening on http://localhost:${this.config.port}`)
    })
  }

  stop() {
    this.server?.close()
  }
}

// ============================================================
// 消息处理（收到的消息如何处理）
// ============================================================

async function handleIncomingMessage(msg, config, channels) {
  const text = msg.text

  // 命令处理
  if (text.startsWith('/')) {
    const [cmd, ...args] = text.split(' ')
    switch (cmd) {
      case '/start':
      case '/help':
        return `🤖 *cc-notify* — AI Code Agent 通知服务\n\nCommands:\n/ping — 检查服务状态\n/run <cmd> — 执行一次性命令\n/notify <text> — 发送通知到所有通道\n/status — 查看状态`
      case '/ping':
        return '🏓 pong!'
      case '/status':
        return `📊 cc-notify status\nChannels: ${Object.keys(channels).join(', ') || 'none'}\nUptime: ${Math.floor(process.uptime())}s`
      case '/notify':
        const notifyText = args.join(' ')
        if (!notifyText) return 'Usage: /notify <text>'
        const results = await sendToChannel(channels, config.defaultChannel, notifyText)
        return results.map(r => r.ok ? `✅ ${r.channel}` : `❌ ${r.channel}: ${r.error}`).join('\n')
      case '/run':
        const cmd = args.join(' ')
        if (!cmd) return 'Usage: /run <command>'
        return await runOneShot(config.ccNodePath, cmd)
      default:
        return `Unknown command: ${cmd}\nType /help for available commands`
    }
  }

  // 普通消息 → 当作一次性任务执行
  return await runOneShot(config.ccNodePath, text)
}

/** 调用 cc-node 执行一次性命令 */
function runOneShot(ccNodePath, input) {
  return new Promise((resolve) => {
    const timeout = 60000 // 60 秒超时
    const timer = setTimeout(() => {
      child.kill()
      resolve('⏰ 执行超时（60秒）')
    }, timeout)

    try {
      const child = spawn(ccNodePath, [], { stdio: ['pipe', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (d) => { stdout += d.toString() })
      child.stderr.on('data', (d) => { stderr += d.toString() })
      child.stdin.write(input + '\n')
      child.stdin.end()
      child.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0 && stdout.trim()) {
          resolve(stdout.trim().slice(0, 4000)) // Telegram 消息长度限制
        } else if (stderr.trim()) {
          resolve(`❌ Error: ${stderr.trim().slice(0, 1000)}`)
        } else {
          resolve(stdout.trim().slice(0, 4000) || '(no output)')
        }
      })
    } catch (e) {
      clearTimeout(timer)
      resolve(`❌ Failed to run cc-node: ${e.message}`)
    }
  })
}

// ============================================================
// 守护进程管理
// ============================================================

function startDaemon(config) {
  log('Starting cc-notify daemon...')

  // 检查是否已在运行
  if (existsSync(config.pidFile)) {
    const pid = parseInt(readFileSync(config.pidFile, 'utf8').trim(), 10)
    try {
      process.kill(pid, 0) // 检查进程是否存活
      console.error(`cc-notify already running (PID ${pid})`)
      console.log('Use --stop to stop it first')
      process.exit(1)
    } catch {
      // 进程已死，清理旧 PID 文件
      unlinkSync(config.pidFile)
    }
  }

  // 用子进程启动自己
  const child = spawn(process.execPath, [import.meta.url], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, CC_NOTIFY_DAEMON: '1' },
  })
  child.unref()
  console.log(`cc-notify daemon started (PID ${child.pid})`)
  console.log(`PID file: ${config.pidFile}`)
  console.log(`Log file: ${config.logFile}`)
  console.log(`HTTP API: http://localhost:${config.port}`)
  process.exit(0)
}

function stopDaemon(config) {
  if (!existsSync(config.pidFile)) {
    console.log('cc-notify is not running')
    process.exit(0)
  }
  const pid = parseInt(readFileSync(config.pidFile, 'utf8').trim(), 10)
  try {
    process.kill(pid, 'SIGTERM')
    console.log(`cc-notify stopped (PID ${pid})`)
  } catch {
    console.log(`Process ${pid} not found, cleaning PID file`)
  }
  try { unlinkSync(config.pidFile) } catch {}
  process.exit(0)
}

function showStatus(config) {
  if (!existsSync(config.pidFile)) {
    console.log('cc-notify is not running')
    process.exit(0)
  }
  const pid = parseInt(readFileSync(config.pidFile, 'utf8').trim(), 10)
  try {
    process.kill(pid, 0)
    console.log(`cc-notify running (PID ${pid})`)
    // 尝试从 HTTP API 获取详细状态
    fetch(`http://localhost:${config.port}/status`)
      .then(r => r.json())
      .then(data => console.log('Status:', JSON.stringify(data, null, 2)))
      .catch(() => console.log('(HTTP API not responding)'))
  } catch {
    console.log(`PID ${pid} is dead, cleaning up`)
    try { unlinkSync(config.pidFile) } catch {}
  }
}

// ============================================================
// 工具函数
// ============================================================

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function readBody(req) {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', (d) => { body += d })
    req.on('end', () => resolve(body))
  })
}

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19)
  const line = `[${ts}] ${msg}\n`
  process.stdout.write(line)
  try {
    const config = loadConfig()
    if (config.logFile) {
      appendFileSync(config.logFile, line)
    }
  } catch {}
}

// ============================================================
// 主入口
// ============================================================

async function main() {
  const config = loadConfig()

  // 解析命令行
  const args = process.argv.slice(2)
  const isDaemon = args.includes('--daemon')
  const isStop = args.includes('--stop')
  const isStatus = args.includes('--status')

  if (isStop) return stopDaemon(config)
  if (isStatus) return showStatus(config)
  if (isDaemon) return startDaemon(config)

  // 写 PID 文件
  writeFileSync(config.pidFile, String(process.pid))

  // 优雅退出
  const cleanup = () => {
    log('Shutting down...')
    try { unlinkSync(config.pidFile) } catch {}
    process.exit(0)
  }
  process.on('SIGTERM', cleanup)
  process.on('SIGINT', cleanup)

  log('cc-notify starting...')
  log(`Channels: ${Object.keys(config.channels).join(', ') || 'none'}`)
  log(`Default: ${config.defaultChannel || 'none'}`)

  // 启动 Telegram 监听
  const tgListener = new TelegramListener(config)
  tgListener.onMessage(async (msg) => {
    const reply = await handleIncomingMessage(msg, config, config.channels)
    // 回复到 Telegram
    if (config.channels.telegram?.token && msg.chatId) {
      await sendTelegram(
        { token: config.channels.telegram.token, chatId: msg.chatId },
        reply
      )
    }
  })
  await tgListener.start()

  // 启动 HTTP API
  const httpServer = new HttpServer(config, config.channels)
  httpServer.start()

  log('cc-notify ready ✅')

  // 保持进程存活
  setInterval(() => {}, 60000)
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
