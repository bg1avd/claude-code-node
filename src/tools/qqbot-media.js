/**
 * QQ Bot 富媒体工具 — 图片/语音/文件上传与发送
 *
 * 功能：
 * - 验证文件路径（必须在 ~/.openclaw/media/qqbot 或 ~/.openclaw/media）
 * - 自动检测文件类型
 * - 上传并通过 QQ Bot 发送
 *
 * 使用方式：
 *   qqbot_media: { action: 'upload', path: '/home/.../image.png', scope: 'group', targetId: '群OPENID' }
 */

import { QQBotEnhanced } from '../channel/qqbot-enhanced.js'
import { parseQQMediaTags } from '../channel/qqbot-enhanced.js'

const API_BASE = 'https://api.sgroup.qq.com'

async function getToken(appId, clientSecret) {
  const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId, clientSecret }),
  })
  if (!res.ok) throw new Error(`Token API ${res.status}`)
  const data = await res.json()
  if (!data.access_token) throw new Error('No access_token')
  return data.access_token
}

async function uploadFileToQQ(token, scope, targetId, filePath, fileType) {
  const { readFileSync, existsSync } = await import('fs')
  const { resolve } = await import('path')

  const absPath = resolve(filePath)
  if (!existsSync(absPath)) {
    throw new Error(`文件不存在: ${filePath}`)
  }

  // 安全检查：必须在 media/qqbot 或 media 目录下
  const allowedDirs = [
    process.env.HOME + '/.openclaw/media/qqbot',
    process.env.HOME + '/.openclaw/media'
  ]
  const isAllowed = allowedDirs.some(dir => absPath.startsWith(dir))
  if (!isAllowed) {
    throw new Error(`安全限制: 文件必须在 ~/.openclaw/media/qqbot 或 ~/.openclaw/media 目录下`)
  }

  const path = scope === 'group'
    ? `/v2/groups/${targetId}/files`
    : `/v2/users/${targetId}/files`

  const body = {
    file_type: fileType,
    srv_send_msg: false
  }

  // 读取文件并转为 base64
  const buf = readFileSync(absPath)
  body.file_data = buf.toString('base64')

  const res = await fetch(API_BASE + path, {
    method: 'POST',
    headers: {
      'Authorization': `QQBot ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const err = await res.text().catch(() => '')
    throw new Error(`上传失败 ${res.status}: ${err.slice(0, 100)}`)
  }

  const result = await res.json()
  if (!result.file_info) {
    throw new Error(`上传响应异常: ${JSON.stringify(result)}`)
  }

  return result.file_info
}

async function sendMediaMessage(token, scope, targetId, fileInfo) {
  const path = scope === 'group'
    ? `/v2/groups/${targetId}/messages`
    : `/v2/users/${targetId}/messages`

  const body = {
    msg_type: 7,  // 媒体消息
    media: { file_info: fileInfo }
  }

  const res = await fetch(API_BASE + path, {
    method: 'POST',
    headers: {
      'Authorization': `QQBot ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const err = await res.text().catch(() => '')
    throw new Error(`发送失败 ${res.status}: ${err.slice(0, 100)}`)
  }

  return res.json()
}

/** 工具函数 */

async function uploadAndSendMedia(params) {
  const { path: filePath, scope, targetId, appId, clientSecret } = params

  if (!filePath) throw new Error('path 必填')
  if (!scope || !targetId) throw new Error('scope 和 targetId 必填')

  // 获取凭证
  const resolvedAppId = appId || process.env.CC_NODE_CHANNEL_QQBOT_APPID || ''
  const resolvedSecret = clientSecret || process.env.CC_NODE_CHANNEL_QQBOT_SECRET || ''
  const token = await getToken(resolvedAppId, resolvedSecret)

  // 检测文件类型
  const ext = filePath.split('.').pop().toLowerCase()
  let fileType
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'].includes(ext)) fileType = 1
  else if (['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(ext)) fileType = 2
  else if (['silk', 'wav', 'mp3', 'ogg', 'aac', 'flac', 'm4a'].includes(ext)) fileType = 3
  else fileType = 4

  // 上传
  const fileInfo = await uploadFileToQQ(token, scope, targetId, filePath, fileType)

  // 发送
  const result = await sendMediaMessage(token, scope, targetId, fileInfo)

  return { ok: true, fileInfo, result }
}

/** 解析文本中的 <qqmedia> 标签并批量处理 */
async function processQQMediaText(text, context) {
  const { mediaFiles } = parseQQMediaTags(text)
  const scope = context.scope || 'group'
  const targetId = context.targetId

  const results = []
  for (const media of mediaFiles) {
    try {
      const result = await uploadAndSendMedia({
        path: media.path,
        scope,
        targetId,
        appId: context.appId,
        clientSecret: context.clientSecret
      })
      results.push({ ok: true, path: media.path, result })
    } catch (e) {
      results.push({ ok: false, path: media.path, error: e.message })
    }
  }

  return results
}

// 导出
export const tools = {
  qqbot_media_upload: async (args) => await uploadAndSendMedia(args),
  qqbot_media_process_text: async (args) => await processQQMediaText(args.text, args.context)
}

export const metadata = {
  name: 'qqbot-media',
  description: 'QQ Bot 富媒体上传工具，支持图片、文件、语音',
  tools: ['qqbot_media_upload', 'qqbot_media_process_text']
}
