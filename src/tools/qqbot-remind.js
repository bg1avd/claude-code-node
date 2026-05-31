/**
 * QQ Bot 定时提醒工具 — 基于 cron 的定时任务（简化版）
 *
 * 注意：此工具依赖主项目的定时任务系统。当前实现为占位符，
 * 实际功能待后续与 cc-node 的调度系统集成后完成。
 */

// 时间解析器
function parseRelativeTime(timeStr) {
  const match = timeStr.match(/^(\d+)(h|m|s)$/)
  if (!match) return null
  const [, value, unit] = match
  const num = parseInt(value, 10)
  const multipliers = { s: 1000, m: 60000, h: 3600000 }
  return num * multipliers[unit]
}

/** 主工具函数 */
async function qqbotRemind(args) {
  const { action, content, time, targetId, accountId, jobId } = args

  if (!action || !['add', 'list', 'remove'].includes(action)) {
    return { ok: false, error: 'action 必须为 add/list/remove' }
  }

  // 占位：说明需要集成调度系统
  return {
    ok: false,
    error: `qqbot_remind 尚未完整集成定时任务系统。当前收到: action=${action}, content=${content}, time=${time}, targetId=${targetId}`
  }
}

// 导出
export const tools = {
  qqbotRemind
}

export const metadata = {
  name: 'qqbot-remind',
  description: 'QQ Bot 定时提醒工具 —— 支持一次性/周期性提醒（待集成调度系统）',
  tools: ['qqbot_remind']
}
