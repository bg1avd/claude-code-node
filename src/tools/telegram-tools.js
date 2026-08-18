/**
 * Telegram 工具 — 发送消息/媒体、通用 Bot API 调用、定时提醒
 *
 * 替代原 qqbot_* 工具（QQ 通道已放弃，统一改用 Telegram）。
 *
 * 配置：
 *   CC_NODE_CHANNEL_TELEGRAM_TOKEN   — Bot Token（必填）
 *   CC_NODE_CHANNEL_TELEGRAM_CHAT_ID — 默认聊天 ID（可选）
 *   CC_NODE_CHANNEL_TELEGRAM_PROXY   — SOCKS5 代理（可选）
 *   CC_NODE_CHANNEL_TELEGRAM_API_BASE— 自定义 API Base（可选）
 *
 * 依赖复用 src/channel/tg-listener.js 中的 TelegramBotClient，
 * 保证与 cc-node 双向通道使用同一套客户端逻辑（速率限制、代理、重试）。
 */

import { ToolDef } from '../types/index.js'
import { TelegramBotClient } from '../channel/tg-listener.js'
import { readFileSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const API_BASE = (token) => `https://api.telegram.org/bot${token}`

/**
 * 读取 Telegram 配置（环境变量优先，其次 config.json 的 channels.telegram）
 *
 * 配置优先级：
 *   1. 环境变量 CC_NODE_CHANNEL_TELEGRAM_*
 *   2. 用户级 ~/.claude-code/config.json → channels.telegram
 *   3. 项目级 .claude-code/config.json → channels.telegram（覆盖用户级）
 */
let _cachedTgConfig = null
let _cachedTgConfigMtime = null

function loadTgConfigFromFile() {
  const files = [
    join(homedir(), '.claude-code/config.json'),   // 用户级
    '.claude-code/config.json',                      // 项目级（覆盖用户级）
  ]
  let merged = {}
  for (const file of files) {
    try {
      const raw = readFileSync(file, 'utf-8')
      const data = JSON.parse(raw)
      if (data?.channels?.telegram) {
        merged = { ...merged, ...data.channels.telegram }
      }
    } catch { /* 文件不存在或解析失败则跳过 */ }
  }
  return merged
}

/** 读取 Telegram 配置（带缓存，文件 mtime 变化自动失效） */
function getTgConfig() {
  const userFile = join(homedir(), '.claude-code/config.json')
  const projectFile = '.claude-code/config.json'
  let mtimeKey = ''
  for (const f of [userFile, projectFile]) {
    try { mtimeKey += statSync(f).mtimeMs } catch {}
  }
  if (_cachedTgConfigMtime !== mtimeKey) {
    _cachedTgConfig = loadTgConfigFromFile()
    _cachedTgConfigMtime = mtimeKey
  }
  return _cachedTgConfig
}

/** 读取 token（环境变量优先，其次 config.json） */
function getToken() {
  return process.env.CC_NODE_CHANNEL_TELEGRAM_TOKEN || getTgConfig().token || ''
}

/** 读取默认聊天 ID（环境变量优先，其次 config.json） */
function getDefaultChatId() {
  return process.env.CC_NODE_CHANNEL_TELEGRAM_CHAT_ID || getTgConfig().chatId || ''
}

/** 读取代理（环境变量优先，其次 config.json） */
function getProxy() {
  return process.env.CC_NODE_CHANNEL_TELEGRAM_PROXY || getTgConfig().proxy || ''
}

/** 读取 API Base（环境变量优先，其次 config.json） */
function getApiBase(token) {
  return process.env.CC_NODE_CHANNEL_TELEGRAM_API_BASE || getTgConfig().apiBase || API_BASE(token)
}

/** 创建 TelegramBotClient 实例 */
function getClient() {
  const token = getToken()
  if (!token) {
    throw new Error('未配置 Telegram Token（请设置 CC_NODE_CHANNEL_TELEGRAM_TOKEN 或 config.json 的 channels.telegram.token）')
  }
  const proxy = getProxy()
  const apiBase = getApiBase(token)
  return new TelegramBotClient(token, { proxy, apiBase })
}

/** 通用执行器：包装为 ToolDef 的执行格式 */
function createExecutor(originalFunc) {
  return async (input) => {
    try {
      const result = await originalFunc(input)
      if (result && result.ok) {
        return typeof result.result !== 'undefined' ? result.result : result
      }
      return result
    } catch (e) {
      return `[ERROR] ${e.message}`
    }
  }
}

/** 校验聊天 ID（允许用默认值） */
function resolveChatId(chatId) {
  return chatId || getDefaultChatId()
}

// ============================================================
// 具体工具函数
// ============================================================

/** 发送文本消息 */
async function sendMessage(args) {
  const { chatId, text, parseMode, silent, disableWebPreview } = args
  const resolvedChatId = resolveChatId(chatId)
  if (!resolvedChatId) throw new Error('chatId 必填（或设置 CC_NODE_CHANNEL_TELEGRAM_CHAT_ID 作为默认）')
  if (!text) throw new Error('text 必填')

  const client = getClient()
  const result = await client.sendMessage(resolvedChatId, text, {
    parseMode: parseMode || 'HTML',
    silent: silent || false,
    disableWebPreview: disableWebPreview ?? true,
  })
  return { ok: true, messageId: result.message_id, chat: result.chat?.id }
}

/** 发送媒体文件（图片/文档/音频/视频） */
async function sendMedia(args) {
  const { chatId, path, caption, mediaType } = args
  const resolvedChatId = resolveChatId(chatId)
  if (!resolvedChatId) throw new Error('chatId 必填（或设置 CC_NODE_CHANNEL_TELEGRAM_CHAT_ID 作为默认）')
  if (!path) throw new Error('path 必填')

  const { readFileSync, existsSync } = await import('fs')
  const { resolve, basename } = await import('path')

  const absPath = resolve(path)
  if (!existsSync(absPath)) throw new Error(`文件不存在: ${path}`)

  const client = getClient()
  const token = getToken()
  const apiBase = client.apiBase || getApiBase(token)

  // 检测文件类型
  const ext = absPath.split('.').pop().toLowerCase()
  const type = mediaType || (
    ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'].includes(ext) ? 'photo'
    : ['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(ext) ? 'video'
    : ['mp3', 'ogg', 'm4a', 'wav', 'flac', 'aac'].includes(ext) ? 'audio'
    : 'document'
  )

  const form = new FormData()
  form.append('chat_id', String(resolvedChatId))
  if (caption) form.append('caption', String(caption).slice(0, 1024))

  // 上传文件
  const buf = readFileSync(absPath)
  const blob = new Blob([buf])
  // 不同文件类型的 multipart 字段名
  const fieldName = {
    photo: 'photo',
    video: 'video',
    audio: 'audio',
    document: 'document',
    sticker: 'sticker',
  }[type] || 'document'

  // 带文件名（用 File 形式，node 18+ 支持）
  const FileCtor = (typeof File !== 'undefined') ? File : null
  let filePart
  if (FileCtor) {
    filePart = new File([buf], basename(absPath))
  } else {
    // 兼容：手动组装 multipart
    form.append(fieldName, blob, basename(absPath))
    filePart = null
  }
  if (filePart) form.append(fieldName, filePart)

  const method = type === 'photo' ? 'sendPhoto'
    : type === 'video' ? 'sendVideo'
    : type === 'audio' ? 'sendAudio'
    : type === 'sticker' ? 'sendSticker'
    : 'sendDocument'

  const res = await client._fetch(`${apiBase}/${method}`, {
    method: 'POST',
    body: form,
  })
  const data = await res.json()
  if (!data.ok) {
    throw new Error(`Telegram ${method} ${data.error_code}: ${data.description?.slice(0, 200) || 'unknown'}`)
  }
  return { ok: true, type, messageId: data.result?.message_id, chat: data.result?.chat?.id }
}

/** 通用 Telegram Bot API 调用 */
async function channelApi(args) {
  const { method = 'POST', path, body = {}, query = {} } = args
  if (!path) throw new Error('path 必填（如 /sendMessage、/getMe、/getUpdates）')

  const client = getClient()
  const token = getToken()
  const apiBase = client.apiBase || getApiBase(token)

  const url = new URL(apiBase + (path.startsWith('/') ? path : '/' + path))
  for (const [k, v] of Object.entries(query)) url.searchParams.append(k, String(v))

  const res = await client._fetch(url.toString(), {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: ['POST', 'PUT', 'PATCH'].includes(method) ? JSON.stringify(body) : undefined,
  })
  const raw = await res.text()
  if (!res.ok) {
    throw new Error(`Telegram API ${method} ${path} → ${res.status}: ${raw.slice(0, 200)}`)
  }
  const data = raw.trim() ? JSON.parse(raw) : null
  if (data && !data.ok) {
    throw new Error(`Telegram API ${data.error_code}: ${data.description?.slice(0, 200) || 'unknown'}`)
  }
  return data?.result ?? data
}

/** 获取机器人信息 */
async function getMe() {
  const result = await channelApi({ method: 'POST', path: '/getMe' })
  return { ok: true, username: result?.username, id: result?.id, firstName: result?.first_name }
}

/** 定时提醒（复用 qqbot_remind 的调度占位，目标改为 Telegram chatId） */
async function remind(args) {
  const { action, content, time, chatId, jobId } = args
  if (!action || !['add', 'list', 'remove'].includes(action)) {
    throw new Error('action 必须为 add/list/remove')
  }
  const resolvedChatId = resolveChatId(chatId)
  if (!resolvedChatId) throw new Error('chatId 必填（或设置 CC_NODE_CHANNEL_TELEGRAM_CHAT_ID 作为默认）')

  // TODO: 与 cc-node 调度系统集成后实现真正的定时发送
  // 当前占位：返回需集成的提示
  return {
    ok: false,
    error: `telegram_remind 尚未完整集成定时任务系统。当前收到: action=${action}, content=${content}, time=${time}, chatId=${resolvedChatId}`
  }
}

// ============================================================
// 导出工具定义
// ============================================================

export const telegramTools = [
  new ToolDef(
    'telegram_send_message',
    `发送文本消息到 Telegram 聊天。
使用方法：
  chatId: 目标聊天 ID（数字或 @username；留空用 CC_NODE_CHANNEL_TELEGRAM_CHAT_ID 默认值）
  text: 消息内容（Telegram 单条上限 4096 字符，超长自动截断）
  parseMode: 解析模式（HTML 或 Markdown，默认 HTML）
  silent: 是否静默发送（可选）
  disableWebPreview: 是否禁用网页预览（可选）

示例：
- 发送文本: { "chatId": "123456789", "text": "任务完成 ✅" }`,
    {
      type: 'object',
      properties: {
        chatId: { type: 'string', description: '目标聊天 ID（数字或 @username，可省略用默认）' },
        text: { type: 'string', description: '消息内容' },
        parseMode: { type: 'string', enum: ['HTML', 'Markdown'], description: '解析模式' },
        silent: { type: 'boolean', description: '静默发送' },
        disableWebPreview: { type: 'boolean', description: '禁用网页预览' }
      },
      required: ['text']
    },
    createExecutor(sendMessage)
  ),

  new ToolDef(
    'telegram_send_media',
    `发送图片/文件/音频/视频到 Telegram 聊天。
使用方法：
  chatId: 目标聊天 ID（可省略用默认）
  path: 本地文件绝对路径
  caption: 附加说明文字（可选）
  mediaType: 文件类型 photo|video|audio|document|sticker（可选，自动检测）

示例：
{ "chatId": "123456789", "path": "/tmp/result.png", "caption": "结果截图" }`,
    {
      type: 'object',
      properties: {
        chatId: { type: 'string', description: '目标聊天 ID（可省略用默认）' },
        path: { type: 'string', description: '本地文件绝对路径' },
        caption: { type: 'string', description: '附加说明文字' },
        mediaType: { type: 'string', enum: ['photo', 'video', 'audio', 'document', 'sticker'], description: '文件类型' }
      },
      required: ['path']
    },
    createExecutor(sendMedia)
  ),

  new ToolDef(
    'telegram_channel_api',
    `调用 Telegram Bot API（通用）。
使用方法：
  method: HTTP 方法 (GET/POST)
  path: API 路径，如 /getMe、/getUpdates、/sendMessage（自动加 /bot<token> 前缀）
  body: 请求体 JSON（POST 使用）
  query: URL 查询参数对象

示例：
- 获取机器人信息: { "method": "POST", "path": "/getMe" }
- 获取更新: { "method": "POST", "path": "/getUpdates", "body": { "limit": 10 } }`,
    {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['GET', 'POST'], description: 'HTTP 方法' },
        path: { type: 'string', description: 'API 路径，如 /getMe、/sendMessage' },
        body: { type: 'object', description: '请求体 JSON（POST 使用）' },
        query: { type: 'object', additionalProperties: { type: 'string' }, description: 'URL 查询参数' }
      },
      required: ['method', 'path']
    },
    createExecutor(channelApi)
  ),

  new ToolDef(
    'telegram_get_me',
    '获取 Telegram 机器人自身信息（用户名、ID）。无需参数。',
    { type: 'object', properties: {} },
    createExecutor(getMe)
  ),

  new ToolDef(
    'telegram_remind',
    `Telegram 定时提醒（计划集成调度系统）。
使用方法：
  action: add|list|remove
  content: 提醒内容
  time: 相对时间 (5m, 1h30m) 或 cron 表达式
  chatId: 目标聊天 ID（可省略用默认）

注意：当前为占位实现，完整调度待集成。`,
    {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'list', 'remove'], description: '操作类型' },
        content: { type: 'string', description: '提醒内容' },
        time: { type: 'string', description: '相对时间 (5m, 1h30m) 或 cron 表达式 ("0 8 * * *")' },
        chatId: { type: 'string', description: '目标聊天 ID（可省略用默认）' },
        jobId: { type: 'string', description: '任务 ID（仅 remove 使用）' }
      },
      required: ['action']
    },
    createExecutor(remind)
  ),
]

export const metadata = {
  name: 'telegram-tools',
  description: 'Telegram 工具：发送消息/媒体、通用 Bot API 调用、定时提醒',
  tools: telegramTools.map(t => t.name)
}
