/**
 * QQ Bot 频道管理工具 — 调用 QQ Bot API v2
 *
 * 使用方式：在工具调用中指定 method、path、body、query
 *
 * 示例：
 *   qqbot_channel_api: {\n     method: 'GET',\n     path: '/users/@me/guilds',\n     query: { limit: '100' }\n   }
 *
 * 所有请求自动携带 Authorization 头，无需手动处理 Token
 */

const API_BASE = 'https://api.sgroup.qq.com'
const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'

/** 获取指定账户的 Token（通过环境变量或全局配置） */
async function getToken(appId, clientSecret) {
  if (!appId || !clientSecret) {
    throw new Error('QQBot 需要 appId 和 clientSecret（请配置 CC_NODE_CHANNEL_QQBOT_APPID / CC_NODE_CHANNEL_QQBOT_SECRET）')
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
  const data = await res.json()
  if (!data.access_token) throw new Error('Token API no access_token')
  return data.access_token
}

/** 核心 API 调用 */
async function qqbotChannelApiCall(params) {
  const { method = 'GET', path, body, query = {} } = params

  if (!path) throw new Error('path 是必填参数')

  // 从环境变量获取凭证（简化：使用全局默认账户）
  const appId = process.env.CC_NODE_CHANNEL_QQBOT_APPID || ''
  const clientSecret = process.env.CC_NODE_CHANNEL_QQBOT_SECRET || ''
  const token = await getToken(appId, clientSecret)

  // 构建 URL + 查询参数
  const url = new URL(API_BASE + path)
  for (const [k, v] of Object.entries(query)) {
    url.searchParams.append(k, String(v))
  }

  // 执行请求
  const res = await fetch(url.toString(), {
    method,
    headers: {
      'Authorization': `QQBot ${token}`,
      'Content-Type': 'application/json',
    },
    body: (body && ['POST', 'PUT', 'PATCH'].includes(method)) ? JSON.stringify(body) : undefined,
  })

  const raw = await res.text()
  if (!res.ok) {
    let detail = raw.slice(0, 200)
    try { detail = JSON.parse(raw).message || detail } catch {}
    throw new Error(`QQ API ${method} ${path} → ${res.status}: ${detail}`)
  }

  return raw.trim() ? JSON.parse(raw) : null
}

// ── 工具函数（具体操作封装） ───────────────────────────────

/** 获取机器人所在的频道列表 */
async function listGuilds(limit = 100, before, after) {
  const query = { limit: String(limit) }
  if (before) query.before = String(before)
  if (after) query.after = String(after)
  return await qqbotChannelApiCall({ method: 'GET', path: '/users/@me/guilds', query })
}

/** 获取频道的子频道列表 */
async function listChannels(guildId) {
  return await qqbotChannelApiCall({ method: 'GET', path: `/guilds/${guildId}/channels` })
}

/** 创建子频道 */
async function createChannel(guildId, { name, type = 0, position = 1, sub_type = 0, parent_id, private_type, private_user_ids, speak_permission, application_id }) {
  const body = { name, type: Number(type), position: Number(position), sub_type: Number(sub_type) }
  if (parent_id) body.parent_id = parent_id
  if (private_type !== undefined) body.private_type = private_type
  if (private_user_ids) body.private_user_ids = private_user_ids
  if (speak_permission !== undefined) body.speak_permission = speak_permission
  if (application_id) body.application_id = application_id
  return await qqbotChannelApiCall({ method: 'POST', path: `/guilds/${guildId}/channels`, body })
}

/** 获取频道成员列表（分页） */
async function listMembers(guildId, limit = 100, after = 0) {
  return await qqbotChannelApiCall({ method: 'GET', path: `/guilds/${guildId}/members`, query: { limit: String(limit), after: String(after) } })
}

/** 获取指定成员详情 */
async function getMember(guildId, userId) {
  return await qqbotChannelApiCall({ method: 'GET', path: `/guilds/${guildId}/members/${userId}` })
}

/** 发布公告 */
async function createAnnounce(guildId, { message_id, channel_id, announces_type = 0, recommend_channels = [] }) {
  const body = { announces_type, recommend_channels }
  if (message_id) body.message_id = message_id
  if (channel_id) body.channel_id = channel_id
  return await qqbotChannelApiCall({ method: 'POST', path: `/guilds/${guild_id}/announces`, body })
}

/** 删除公告 */
async function deleteAnnounce(guildId, message_id) {
  const messageId = message_id === 'all' ? 'all' : encodeURIComponent(message_id)
  return await qqbotChannelApiCall({ method: 'DELETE', path: `/guilds/${guildId}/announces/${messageId}` })
}

/** 获取子频道在线人数 */
async function getChannelOnlineCount(channelId) {
  return await qqbotChannelApiCall({ method: 'GET', path: `/channels/${channelId}/online_nums` })
}

// 导出工具函数作为工具接口
export const tools = {
  qqbot_channel_api: async (args) => {
    // 通用 API 调用
    return await qqbotChannelApiCall(args)
  },

  // 便捷函数
  qqbot_list_guilds: async (args = {}) => await listGuilds(args.limit, args.before, args.after),
  qqbot_list_channels: async (args) => await listChannels(args.guildId),
  qqbot_get_member: async (args) => await getMember(args.guildId, args.userId),
  qqbot_list_members: async (args) => await listMembers(args.guildId, args.limit, args.after),
  qqbot_get_channel_online: async (args) => await getChannelOnlineCount(args.channelId),
}

// 工具元数据
export const metadata = {
  name: 'qqbot-channel-api',
  description: 'QQ Bot 频道管理工具，调用 QQ Bot API v2，支持频道、成员、公告等操作',
  tools: Object.keys(tools)
}
