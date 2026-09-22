/**
 * 定时任务工具 — schedule_add / schedule_list / schedule_remove / schedule_history
 *
 * 与 telegram_* 等工具并列的 MCP 工具集(设计文档 SCHEDULER_DESIGN.md §十二)。
 * 底层是 src/core/scheduler.js(按需闹钟模型):
 *   - active.json 待办队列 + done.json 归档(双文件)
 *   - ID 生命周期:pending → running → done/failed/cancelled/missed/expired
 *   - 有任务才启动 30s tick,队列空自动熄火(零空转、零 token)
 *   - 忙时延后(保持 pending),绝不让任务因 AI 忙而丢失
 *
 * 依赖 cli.js 启动时调用 setGlobalScheduler() 注入单例。
 */

import { ToolDef } from '../types/index.js'
import { getGlobalScheduler, parseRelativeTime, parseTimeOfDay } from '../core/scheduler.js'

function scheduler() {
  const s = getGlobalScheduler()
  if (!s) throw new Error('定时任务系统未初始化(scheduler 未启动)')
  return s
}

/** 统一执行包装:异常转为结构化错误(与 telegram-tools 的 createExecutor 风格一致) */
function executor(fn) {
  return async (input) => {
    try {
      return await fn(input || {})
    } catch (e) {
      return { ok: false, error: e.message }
    }
  }
}

/** 解析任务的触发时间:支持相对时间("30m")、时刻("14:30")、绝对 epoch(ms) */
function resolveDueAt(input) {
  const { time, dueAt } = input
  if (dueAt) {
    const n = Number(dueAt)
    if (!Number.isFinite(n) || n <= 0) throw new Error(`dueAt 非法: ${dueAt}(应为 UTC epoch 毫秒)`)
    return { dueAt: n }
  }
  if (!time) throw new Error('需要 time(相对 "30m"/"1h30m" 或时刻 "HH:MM")或 dueAt(epoch ms)')
  const rel = parseRelativeTime(String(time))
  if (rel) return { dueAt: Date.now() + rel }
  const tod = parseTimeOfDay(String(time))
  if (tod) return { dueAt: tod, kind: 'once-timeofday' }
  throw new Error(`无法解析 time: "${time}"(支持 "30m"/"1h30m"/"2d"/"HH:MM")`)
}

/** schedule_add 执行体 */
function add(input) {
  const s = scheduler()
  const {
    text, actionType = 'tg', channel = 'telegram', chatId,
    missPolicy = 'run', graceMinutes, lateMinutes, onExpire,
    createdBy = 'agent',
    window, cmd, cwd, timeoutMs, notifyOn, maxRetries, retryDelayMs,
  } = input
  if (!text && actionType !== 'exec') throw new Error('text 必填(提醒内容或要执行的指令);exec 任务需 cmd')
  if (actionType === 'exec' && !cmd) throw new Error('exec 任务需要 cmd(要执行的命令)')

  // 显式 kind 优先(every/daily),否则按 time 解析为 once
  let spec
  if (input.kind === 'every' || input.kind === 'daily') {
    if (input.kind === 'every') {
      const ms = parseRelativeTime(String(input.every || '')) ?? Number(input.everyMs)
      if (!(ms > 0)) throw new Error('every 任务需要 every("30m"/"2h")或 everyMs(毫秒)')
      spec = { kind: 'every', everyMs: ms, dueAt: Date.now() + ms }
    } else {
      if (!parseTimeOfDay(String(input.timeOfDay || ''))) throw new Error('daily 任务需要 timeOfDay("HH:MM")')
      spec = { kind: 'daily', timeOfDay: input.timeOfDay }
    }
  } else {
    const r = resolveDueAt(input)
    spec = { kind: 'once', dueAt: r.dueAt }
  }

  const id = s.addTask({
    ...spec,
    text, actionType, channel, chatId,
    missPolicy, graceMinutes, lateMinutes, onExpire,
    createdBy: input.createdBy || 'agent',
    window, cmd, cwd, timeoutMs, notifyOn, maxRetries, retryDelayMs,
  })
  const kindDesc = spec.kind === 'once' ? '一次性' : spec.kind === 'daily' ? `每天 ${input.timeOfDay}` : `每 ${spec.everyMs / 60000} 分钟`
  const actDesc = actionType === 'exec' ? `执行: ${cmd}` : text
  return {
    ok: true, id,
    desc: `${kindDesc} — ${actDesc}`,
    hint: '到期自动执行;remove 用 schedule_remove + 此 id',
  }
}

/** schedule_list 执行体 */
function list() {
  const s = scheduler()
  const tasks = s.list()
  if (!tasks.length) return { ok: true, count: 0, tasks: [], hint: '当前没有待办定时任务' }
  return {
    ok: true,
    count: tasks.length,
    tasks: tasks.map(t => ({
      id: t.id, kind: t.kind, status: t.status,
      due: t.dueDesc, text: t.action?.text,
      actionType: t.action?.type, cmd: t.action?.cmd || undefined,
      window: t.window?.length ? t.window.map(([s, e]) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}-${String(Math.floor(e / 60)).padStart(2, '0')}:${String(e % 60).padStart(2, '0')}`).join(',') : undefined,
      channel: t.channel, createdBy: t.createdBy, missPolicy: t.missPolicy,
      notifyOn: t.notifyOn, maxRetries: t.maxRetries, retried: t.retried,
    })),
  }
}

/** schedule_remove 执行体 */
function remove(input) {
  const s = scheduler()
  const { id } = input
  if (!id) throw new Error('id 必填(可从 schedule_list 获得)')
  const ok = s.cancel(id)
  if (!ok) {
    const ids = s.list().map(t => t.id)
    return { ok: false, error: `未找到任务 ${id}`, activeIds: ids }
  }
  return { ok: true, removed: id }
}

/** schedule_history 执行体 */
function history(input) {
  const s = scheduler()
  const n = Math.min(Math.max(Number(input?.limit) || 20, 1), 100)
  const done = s.history(n)
  return {
    ok: true, count: done.length,
    tasks: done.map(t => ({
      id: t.id, status: t.status, text: t.action?.text,
      finishedAt: t.finishedAt ? new Date(t.finishedAt).toLocaleString() : undefined,
      lastError: t.lastError || undefined,
    })),
  }
}

// ============================================================
// 工具定义
// ============================================================

export const scheduleTools = [
  new ToolDef(
    'schedule_add',
    `添加定时任务(一次性闹钟 / 每日任务 / 固定间隔)。
使用方法:
  text: 提醒内容,或要 AI 执行的指令(actionType="prompt" 时到期会作为输入送进主循环)
  actionType: "tg"(默认,到期发 Telegram 提醒)| "prompt"(到期让 AI 执行 text)| "exec"(确定性命令,不经 LLM,需 cmd)
  cmd: exec 任务要执行的命令(如 "python check.py");创建时固定,执行时零确认(结构性免确认)
  cwd: exec 工作目录(可选);timeoutMs: 执行超时毫秒(可选,exec 默认 60000 / prompt 默认 600000)
  notifyOn: "always"(默认,成败都通知)| "onError"(仅异常告警,高频巡检推荐)| "never"(纯记录)
  window: 时段窗口(可选),"HH:MM-HH:MM" 或数组 ["09:20-11:30","13:00-15:00"];窗口外不执行
  maxRetries: 失败重试次数(默认 0);retryDelayMs: 重试间隔毫秒(默认 60000);重试限窗口内
  time: 一次性触发点 — 相对时间 "30m"/"1h30m"/"2d" 或今天/明天时刻 "HH:MM"
  dueAt: 或直接给 UTC epoch 毫秒(与 time 二选一)
  kind: 可选 "every"(固定间隔,配 every)| "daily"(每日,配 timeOfDay)
  every: 间隔,"30m"/"2h"(kind="every" 时必填)
  timeOfDay: "HH:MM"(kind="daily" 时必填)
  channel: telegram(默认)| repl
  chatId: Telegram 聊天 ID(可省略用默认)
  missPolicy: run(默认,错过补跑一次)| skip(过期即弃,适合"几点开会提醒我")
  graceMinutes: 一次性任务过期宽限分钟(默认 10)

示例:
- 10 分钟后提醒我: { "text": "起来走走", "time": "10m" }
- 明早 8 点查行情: { "text": "查询A股早盘行情并汇总", "time": "08:00", "actionType": "prompt" }
- 每 30 分钟盯一次回测日志: { "text": "检查回测 log,完成则汇总发我", "kind": "every", "every": "30m", "actionType": "prompt" }
- 交易时段每5分钟拉起runner看护: { "kind": "every", "every": "5m", "window": ["09:20-11:30","13:00-15:00"], "actionType": "exec", "cmd": "python watchdog.py", "notifyOn": "onError", "maxRetries": 2 }`,
    {
      type: 'object',
      properties: {
        text: { type: 'string', description: '提醒内容或要执行的指令' },
        actionType: { type: 'string', enum: ['tg', 'prompt', 'exec'], description: 'tg=发提醒;prompt=让 AI 执行;exec=确定性命令(不经LLM)' },
        cmd: { type: 'string', description: 'exec 命令(创建时固定,执行时零确认)' },
        cwd: { type: 'string', description: 'exec 工作目录(可选)' },
        timeoutMs: { type: 'number', description: '执行超时毫秒(exec 默认60000/prompt 默认600000)' },
        notifyOn: { type: 'string', enum: ['always', 'onError', 'never'], description: '通知策略,默认 always;高频巡检用 onError' },
        window: { type: 'string', description: '时段窗口,如 "09:20-11:30" 或数组(见描述)' },
        maxRetries: { type: 'number', description: '失败重试次数,默认 0' },
        retryDelayMs: { type: 'number', description: '重试间隔毫秒,默认 60000' },
        time: { type: 'string', description: '一次性:相对时间或 HH:MM' },
        dueAt: { type: 'number', description: '一次性:UTC epoch 毫秒(与 time 二选一)' },
        kind: { type: 'string', enum: ['once', 'every', 'daily'], description: '任务类型,默认 once' },
        every: { type: 'string', description: '间隔(every):"30m"/"2h"' },
        timeOfDay: { type: 'string', description: '每日时刻(daily):"HH:MM"' },
        channel: { type: 'string', enum: ['telegram', 'repl'], description: '结果送达渠道' },
        chatId: { type: 'string', description: 'Telegram 聊天 ID(可省略)' },
        missPolicy: { type: 'string', enum: ['run', 'skip'], description: '错过补跑策略,默认 run' },
        graceMinutes: { type: 'number', description: 'once 过期宽限分钟,默认 10' },
        lateMinutes: { type: 'number', description: 'daily 迟到宽限分钟,默认 120' },
        createdBy: { type: 'string', description: '创建来源标记,默认 agent' },
      },
      required: [],
    },
    executor(add)
  ),

  new ToolDef(
    'schedule_list',
    '列出当前所有待办定时任务(含下次触发时间)。',
    { type: 'object', properties: {} },
    executor(list)
  ),

  new ToolDef(
    'schedule_remove',
    `取消/删除一个定时任务。
使用方法: id: 任务 ID(从 schedule_list 获得)`,
    {
      type: 'object',
      properties: { id: { type: 'string', description: '任务 ID' } },
      required: ['id'],
    },
    executor(remove)
  ),

  new ToolDef(
    'schedule_history',
    `查询已完成/失败/取消的定时任务归档。
使用方法: limit: 返回条数(默认 20,最大 100)`,
    {
      type: 'object',
      properties: { limit: { type: 'number', description: '返回条数,默认 20' } },
    },
    executor(history)
  ),
]

export const metadata = {
  name: 'schedule-tools',
  description: '定时任务工具:添加/列出/取消/查历史(按需闹钟模型,跨平台)',
  tools: scheduleTools.map(t => t.name),
}
