/**
 * QQ Bot 工具包装器 — 将新工具适配到 claude-code-node 工具系统
 *
 * 将以下工具包装为标准 ToolDef 格式：
 * - qqbot_channel_api
 * - qqbot_remind
 * - qqbot_media
 */

import { ToolDef } from '../types/index.js'
import { tools as qqbotChannelApiTools } from './qqbot-channel-api.js'
import { tools as qqbotRemindTools } from './qqbot-remind.js'
import { tools as qqbotMediaTools } from './qqbot-media.js'

// 通用执行器：将原始函数包装为 ToolDef 的执行格式
function createExecutor(originalFunc) {
  return async (input, ctx) => {
    try {
      // 合并上下文配置（如 targetId, scope, accountId）
      const args = { ...input, ...ctx }
      const result = await originalFunc(args)
      // 保持与现有工具一致的返回格式
      if (result.ok) {
        return typeof result.result !== 'undefined' ? result.result : result
      }
      return `[ERROR] ${result.error || 'Unknown error'}`
    } catch (e) {
      return `[ERROR] ${e.message}`
    }
  }
}

// 导出所有工具（使用 ToolDef 格式）
export const qqbotTools = [
  // qqbot_channel_api — 通用 API 调用
  new ToolDef(
    'qqbot_channel_api',
    `调用 QQ Bot API v2。自动携带鉴权 Token，无需手动处理。
使用方法：
  method: HTTP 方法 (GET/POST/PUT/PATCH/DELETE)
  path: API 路径（不含域名），如 /guilds/{guild_id}/channels
  body: 请求体 JSON（POST/PUT/PATCH 使用）
  query: URL 查询参数对象（值必须是字符串）

示例：
- 获取频道列表: { "method": "GET", "path": "/users/@me/guilds", "query": { "limit": "100" } }
- 获取子频道: { "method": "GET", "path": "/guilds/123/channels" }`,
    {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], description: 'HTTP 方法' },
        path: { type: 'string', description: 'API 路径（不含域名），如 /guilds/{guild_id}/channels' },
        body: { type: 'object', description: '请求体 JSON（POST/PUT/PATCH 使用）' },
        query: { type: 'object', additionalProperties: { type: 'string' }, description: 'URL 查询参数（值必须是字符串）' }
      },
      required: ['method', 'path']
    },
    createExecutor(qqbotChannelApiTools.qqbot_channel_api)
  ),

  // qqbot_list_guilds — 获取频道列表
  new ToolDef(
    'qqbot_list_guilds',
    '获取机器人所在的频道列表（GUILD 列表）',
    {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '返回数量，最大100' },
        before: { type: 'string', description: '分页游标（上一页最后一条的 id）' },
        after: { type: 'string', description: '分页游标（上一页第一条的 id）' }
      }
    },
    createExecutor(qqbotChannelApiTools.qqbot_list_guilds)
  ),

  // qqbot_list_channels — 获取子频道列表
  new ToolDef(
    'qqbot_list_channels',
    '获取指定频道的子频道列表',
    {
      type: 'object',
      properties: {
        guildId: { type: 'string', description: '频道 ID' }
      },
      required: ['guildId']
    },
    createExecutor(qqbotChannelApiTools.qqbot_list_channels)
  ),

  // qqbot_get_member — 获取成员详情
  new ToolDef(
    'qqbot_get_member',
    '获取指定成员详情',
    {
      type: 'object',
      properties: {
        guildId: { type: 'string', description: '频道 ID' },
        userId: { type: 'string', description: '用户 ID' }
      },
      required: ['guildId', 'userId']
    },
    createExecutor(qqbotChannelApiTools.qqbot_get_member)
  ),

  // qqbot_list_members — 获取成员列表（分页）
  new ToolDef(
    'qqbot_list_members',
    '获取频道成员列表（分页），首次调用 after=0',
    {
      type: 'object',
      properties: {
        guildId: { type: 'string', description: '频道 ID' },
        limit: { type: 'number', description: '每页数量（1-400）' },
        after: { type: 'string', description: '上一页最后一条的 user.id，首次填 0' }
      },
      required: ['guildId']
    },
    createExecutor(qqbotChannelApiTools.qqbot_list_members)
  ),

  // qqbot_get_channel_online — 获取在线人数
  new ToolDef(
    'qqbot_get_channel_online',
    '获取子频道在线人数',
    {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: '子频道 ID' }
      },
      required: ['channelId']
    },
    createExecutor(qqbotChannelApiTools.qqbot_get_channel_online)
  ),

  // qqbot_remind — 定时提醒
  new ToolDef(
    'qqbot_remind',
    `QQ Bot 定时提醒。支持：
- 一次性：time = "5m"（5分钟）、"1h30m"（1.5小时）
- 周期性：time = "0 8 * * *"（每天8点），需设置 tz = "Asia/Shanghai"

注意：必须提供 targetId（openid 或 group_openid）和 content。

示例：
{ "action": "add", "content": "喝水", "time": "5m", "targetId": "群OPENID" }`,
    {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'list', 'remove'], description: '操作类型' },
        content: { type: 'string', description: '提醒内容' },
        time: { type: 'string', description: '相对时间 (5m, 1h30m) 或 cron 表达式 ("0 8 * * *")' },
        targetId: { type: 'string', description: '目标 openid 或 group_openid' },
        accountId: { type: 'string', description: '使用的 QQ 账户 ID（可选）' },
        jobId: { type: 'string', description: '任务 ID（仅 remove 使用）' }
      },
      required: ['action']
    },
    createExecutor(qqbotRemindTools.qqbotRemind)
  ),

  // qqbot_media_upload — 富媒体上传
  new ToolDef(
    'qqbot_media_upload',
    `上传并发送图片/文件/语音。
重要：文件必须位于 ~/.openclaw/media/qqbot/ 或 ~/.openclaw/media/ 目录下（安全限制）。
自动检测文件类型：图片（jpg/png/gif）、视频（mp4/mkv）、语音（mp3/silk）、文件（其他）。

示例：
{ "path": "/home/user/.openclaw/media/qqbot/result.png", "scope": "group", "targetId": "群OPENID" }`,
    {
      type: 'object',
      properties: {
        path: { type: 'string', description: '本地文件绝对路径' },
        scope: { type: 'string', enum: ['c2c', 'group'], description: '发送范围' },
        targetId: { type: 'string', description: '目标 ID' },
        accountId: { type: 'string', description: '使用的 QQ 账户 ID（可选）' },
        appId: { type: 'string', description: 'QQ Bot AppID（可选，默认使用环境变量）' },
        clientSecret: { type: 'string', description: 'QQ Bot ClientSecret（可选）' }
      },
      required: ['path', 'scope', 'targetId']
    },
    createExecutor(qqbotMediaTools.qqbot_media_upload)
  )
]

