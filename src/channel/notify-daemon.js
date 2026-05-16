import { ChannelManager } from './index.js'
/**
 * cc-notify — 通知守护进程（C方案：智能路由）
 * 
 * 核心逻辑：
 *   手机发消息 → cc-notify 收到
 *   → 检查 cc-node 是否在运行
 *     → 在运行：转发消息给已运行的 cc-node（通过 Unix socket）
 *     → 没在运行：spawn 一个新的 cc-node 执行，完成后退出
 *
 * 用法：
 *   cc-notify                              # 前台运行
 *   cc-notify --daemon                     # 后台守护进程
 *   cc-notify --stop                       # 停止守护进程
 *   cc-notify --status                     # 查看状态
 */

import { createServer } from 'http'
import { readFileSync, writeFileSync, unlinkSync, existsSync, appendFileSync, mkdirSync } from 'fs'
import { resolve, join } from 'path'
import { homedir } from 'os'
import { spawn } from 'child_process'
import { createConnection } from 'net'
import { SOCK_DIR, SOCK_PATH, CC_NODE_PID, CC_CC_NOTIFY_PID, CC_CC_NOTIFY_LOG, DEFAULT_HTTP_PORT } from '../core/paths.js'

// ============================================================
// 常量
// ============================================================



// ============================================================
// 配置加载（同之前）
// ============================================================

function loadConfig() {
  const config = {
    channels: {},
    defaultChannel: process.env.CC_NODE_CHANNEL_DEFAULT || null,
    port: parseInt(process.env.CC_NOTIFY_PORT || String(DEFAULT_HTTP_PORT), 10),
    pidFile: process.env.CC_NOTIFY_CC_NODE_PID || CC_NOTIFY_PID,
    logFile: process.env.CC_CC_NOTIFY_LOG_FILE || CC_NOTIFY_LOG,
    ccNodePath: process.env.CC_NODE_PATH || 'cc-node',
  }

  for (const dir of [process.cwd(), homedir()]) {
    const cfgPath = join(dir, '.claude-code', 'config.json')
    if (existsSync(cfgPath)) {
      try {
        const data = JSON.parse(readFileSync(cfgPath, 'utf8'))
        if (data.channels) Object.assign(config.channels, data.channels)
        if (data.defaultChannel && !config.defaultChannel) config.defaultChannel = data.defaultChannel
        if (data.notify?.port) config.port = data.notify.port
        if (data.notify?.ccNodePath) config.ccNodePath = data.notify.ccNodePath
      } catch {}
    }
  }

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
// 通道发送
// ============================================================

// sendTelegram → 通过 ChannelManager 处理

// sendWebhook → 通过 ChannelManager 处理

async function sendToChannel(channels, defaultChannel, text) {
  const cm = new ChannelManager({ channels, defaultChannel })
  return await cm.send(text)
}

// ============================================================
// 进程发现 — cc-node 是否在跑？
// ============================================================

/**
 * 检查 cc-node 是否在运行
 * 优先级：Unix socket > PID 文件
 * 返回: { running: boolean, pid?: number, socketPath?: string }
 */
function findCcNode() {
  // 1. 检查 Unix socket
  if (existsSync(SOCK_PATH)) {
    // socket 文件存在不代表进程在跑，尝试连接验证
    return new Promise((resolve) => {
      const client = createConnection(SOCK_PATH, () => {
        // 连上了 = cc-node 确实在跑
        client.end()
        resolve({ running: true, socketPath: SOCK_PATH })
      })
      client.on('error', () => {
        // socket 文件残留但进程已死
        try { unlinkSync(SOCK_PATH) } catch {}
        resolve({ running: false })
      })
      // 超时 2 秒
      setTimeout(() => { client.destroy(); resolve({ running: false }) }, 2000)
    })
  }

  // 2. 检查 PID 文件
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
// 消息路由 — C方案核心
// ============================================================

/**
 * 向已运行的 cc-node 发送消息（通过 Unix socket）
 * 返回: cc-node 的回复文本
 */
function sendToExistingNode(socketPath, text) {
  return new Promise((resolve, reject) => {
    const client = createConnection(socketPath, () => {
      // 协议：发送 JSON 行，接收 JSON 行
      const msg = JSON.stringify({ type: 'user_input', text })
      client.write(msg + '\n')
    })

    let buffer = ''
    client.on('data', (data) => {
      buffer += data.toString()
      // 等完整 JSON 行
      const lines = buffer.split('\n')
      if (lines.length > 1) {
        try {
          const response = JSON.parse(lines[0])
          client.end()
          resolve(response)
        } catch {
          // 不是 JSON，可能是裸文本回复
          client.end()
          resolve({ type: 'reply', text: buffer.trim() })
        }
      }
    })

    client.on('error', (err) => reject(err))

    // 60 秒超时
    setTimeout(() => {
      client.destroy()
      reject(new Error('timeout waiting for cc-node reply'))
    }, 60000)
  })
}

/**
 * 启动新的 cc-node 执行一次性任务
 * 返回: cc-node 的输出
 */
function spawnNewNode(ccNodePath, text) {
  return new Promise((resolve) => {
    const timeout = 120000  // 2 分钟
    const timer = setTimeout(() => {
      child.kill()
      resolve({ type: 'reply', text: '⏰ 执行超时（2分钟）' })
    }, timeout)

    try {
      const child = spawn(ccNodePath, [text], { stdio: ['pipe', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (d) => { stdout += d.toString() })
      child.stderr.on('data', (d) => { stderr += d.toString() })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (stdout.trim()) {
          resolve({ type: 'reply', text: stdout.trim().slice(0, 4000) })
        } else if (stderr.trim()) {
          resolve({ type: 'reply', text: `❌ Error: ${stderr.trim().slice(0, 1000)}` })
        } else {
          resolve({ type: 'reply', text: '(no output)' })
        }
      })
    } catch (e) {
      clearTimeout(timer)
      resolve({ type: 'reply', text: `❌ Failed: ${e.message}` })
    }
  })
}

/**
 * C方案核心：智能路由消息
 * - cc-node 在跑 → 转发给已有实例
 * - cc-node 没跑 → spawn 新实例
 */
async function routeMessage(text, config) {
  const nodeInfo = await findCcNode()

  if (nodeInfo.running && nodeInfo.socketPath) {
    // 方案 C-1：转发给已运行的 cc-node
    log(`[route] cc-node running → forwarding via socket`)
    try {
      const reply = await sendToExistingNode(nodeInfo.socketPath, text)
      return reply.text || JSON.stringify(reply)
    } catch (e) {
      // socket 转发失败，降级到 spawn 新进程
      log(`[route] socket forward failed: ${e.message} → spawning new`)
      return (await spawnNewNode(config.ccNodePath, text)).text
    }
  } else if (nodeInfo.running && nodeInfo.pid) {
    // 有 PID 但没 socket → 可能是老版本 cc-node，不支持 socket
    log(`[route] cc-node running (PID ${nodeInfo.pid}) but no socket → spawning new (one-shot mode)`)
    return (await spawnNewNode(config.ccNodePath, text)).text
  } else {
    // 方案 C-2：cc-node 没在跑，起一个新的
    log(`[route] cc-node not running → spawning new`)
    return (await spawnNewNode(config.ccNodePath, text)).text
  }
}

// ============================================================
// Telegram Bot 长轮询
// ============================================================

class TelegramListener {
  constructor(config) {
    this.config = config
    this.lastUpdateId = 0
    this.running = false
  }

  async start(onMessage) {
    const ch = this.config.channels.telegram
    if (!ch?.token) { log('Telegram: no token, skipping'); return }
    this.running = true
    log('Telegram: started (long polling)')

    while (this.running) {
      try {
        const url = `https://api.telegram.org/bot${ch.token}/getUpdates`
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            offset: this.lastUpdateId + 1,
            timeout: 30,
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
                from: update.message.from?.username || update.message.from?.first_name || '?',
              }
              log(`TG ← ${msg.from}: ${msg.text.slice(0, 60)}`)
              try { await onMessage(msg) } catch (e) { log(`handler error: ${e.message}`) }
            }
          }
        }
      } catch (e) {
        log(`TG poll error: ${e.message}`)
        await sleep(5000)
      }
    }
  }

  stop() { this.running = false }
}

// ============================================================
// HTTP API
// ============================================================

class HttpServer {
  constructor(config, channels) {
    this.config = config
    this.channels = channels
    this.server = null
  }

  start(onMessage) {
    this.server = createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:${this.config.port}`)
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

      try {
        if (req.method === 'GET' && url.pathname === '/status') {
          const nodeInfo = await findCcNode()
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            status: 'running',
            channels: Object.keys(this.channels),
            defaultChannel: this.config.defaultChannel,
            uptime: Math.floor(process.uptime()),
            ccNodeRunning: nodeInfo.running,
          }))
        } else if (req.method === 'POST' && url.pathname === '/send') {
          const body = JSON.parse(await readBody(req))
          const { text, channel } = body
          if (!text) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'text is required' }))
            return
          }
          const results = await sendToChannel(this.channels, channel || this.config.defaultChannel, text)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ results }))
        } else if (req.method === 'POST' && url.pathname === '/chat') {
          // C方案：智能路由
          const body = JSON.parse(await readBody(req))
          const { text } = body
          if (!text) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'text is required' }))
            return
          }
          const reply = await routeMessage(text, this.config)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ reply }))
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
      log(`HTTP API: http://localhost:${this.config.port}`)
    })
  }

  stop() { this.server?.close() }
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
    } catch { try { unlinkSync(config.pidFile) } catch {} }
  }

  const child = spawn(process.execPath, [import.meta.url], {
    detached: true, stdio: 'ignore',
    env: { ...process.env, CC_NOTIFY_DAEMON: '1' },
  })
  child.unref()
  console.log(`cc-notify daemon started (PID ${child.pid})`)
  console.log(`PID: ${config.pidFile}`)
  console.log(`Log: ${config.logFile}`)
  console.log(`HTTP: http://localhost:${config.port}`)
  process.exit(0)
}

function stopDaemon(config) {
  if (!existsSync(config.pidFile)) { console.log('cc-notify not running'); process.exit(0) }
  const pid = parseInt(readFileSync(config.pidFile, 'utf8').trim(), 10)
  try { process.kill(pid, 'SIGTERM'); console.log(`cc-notify stopped (PID ${pid})`) }
  catch { console.log(`PID ${pid} not found`) }
  try { unlinkSync(config.pidFile) } catch {}
  process.exit(0)
}

function showStatus(config) {
  if (!existsSync(config.pidFile)) { console.log('cc-notify not running'); process.exit(0) }
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
// 工具
// ============================================================

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
function readBody(req) { return new Promise(r => { let b = ''; req.on('data', d => b += d); req.on('end', () => r(b)) }) }

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

  writeFileSync(config.pidFile, String(process.pid))

  const cleanup = () => {
    log('Shutting down...')
    try { unlinkSync(config.pidFile) } catch {}
    process.exit(0)
  }
  process.on('SIGTERM', cleanup)
  process.on('SIGINT', cleanup)

  log('cc-notify starting...')
  log(`Channels: ${Object.keys(config.channels).join(', ') || 'none'}`)

  // Telegram 监听
  const tg = new TelegramListener(config)
  tg.start(async (msg) => {
    const text = msg.text

    // 内部命令
    if (text.startsWith('/')) {
      const [cmd, ...rest] = text.split(' ')
      let reply
      switch (cmd) {
        case '/start': case '/help':
          reply = '🤖 *cc-notify* — AI Code Agent 通知服务\n\nCommands:\n/ping — 检查服务\n/status — 状态\n/notify <text> — 广播通知\n其他消息 → 自动发给 cc-node 处理'
          break
        case '/ping': reply = '🏓 pong!'; break
        case '/status': {
          const nodeInfo = await findCcNode()
          reply = `📊 cc-notify\nChannels: ${Object.keys(config.channels).join(', ')}\ncc-node: ${nodeInfo.running ? '✅ running' : '❌ not running'}\nUptime: ${Math.floor(process.uptime())}s`
          break
        }
        case '/notify': {
          const notifyText = rest.join(' ')
          if (!notifyText) { reply = 'Usage: /notify <text>'; break }
          const results = await sendToChannel(config.channels, config.defaultChannel, notifyText)
          reply = results.map(r => r.ok ? `✅ ${r.channel}` : `❌ ${r.channel}: ${r.error}`).join('\n')
          break
        }
        default:
          // 未知命令也当普通消息处理
          reply = await routeMessage(text, config)
          break
      }
      // 回复到 Telegram
      if (config.channels.telegram?.token) {
        await sendToChannel(config.channels, 'telegram', reply)
      }
      return
    }

    // 普通消息 → C方案路由
    log(`[route] processing: "${text.slice(0, 50)}"`)
    const reply = await routeMessage(text, config)
    if (config.channels.telegram?.token) {
      await sendToChannel(config.channels, 'telegram', reply)
    }
  })

  // HTTP API
  const http = new HttpServer(config, config.channels)
  http.start()

  log('cc-notify ready ✅')
  setInterval(() => {}, 60000) // keep alive
}

main().catch(err => { console.error('Fatal:', err); process.exit(1) })
