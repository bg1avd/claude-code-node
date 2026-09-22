// ============================================================
//  scheduler.js — 按需定时任务(闹钟模型,跨平台零系统依赖)
// ------------------------------------------------------------
//  设计文档:SCHEDULER_DESIGN.md(v3)
//
//  模型:
//    - active.json  待办队列(tick 只看它)
//    - done.json    归档日志(done/failed/cancelled/missed/expired,100 条滚动)
//    - ID 生命周期:pending → running → 终态移入 done;daily/every 执行后
//      留在 active 重算窗口,直到用户显式 remove
//    - 短轮询对账:30s tick 比对绝对时刻(无 setTimeout 24.8 天溢出问题、
//      无漂移累积、休眠唤醒后自然补跑)
//    - 启停:有任务才 ensureTimer,队列空自动 stopTimer(零空转)
//    - 忙 ≠ 失败 ≠ 丢弃:engineBusy() 时保持 pending 下个 tick 重试,
//      出口仅"执行成功"或"过期"(grace 线)
//    - 多实例互斥:schedule.lock(wx 创建 + pid 探活清理)
//    - 原子写:temp + rename;写回前 reload 合并,不覆盖外部修改
//
//  接口:
//    createScheduler({ file, doneFile, lockFile, tgSend, runPrompt,
//                      engineBusy, mode, verbose })
//      → { start, dispose, addTask, cancel, remove, list, history,
//          tickNow, hasActive, isOwner }
// ============================================================

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync,
         openSync, writeSync, closeSync, unlinkSync, readSync, appendFileSync } from 'fs'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'
import { pid } from 'process'
import { spawn } from 'child_process'

const TICK_MS = 30_000            // 轮询间隔
const DONE_KEEP = 100             // 归档滚动上限
const GRACE_DEFAULT = 10          // once 默认宽限(分钟)
const LATE_DEFAULT = 120          // daily 默认迟到宽限(分钟)
const EXEC_DEFAULT_TIMEOUT = 60_000   // exec 默认超时(秒级动作)
const PROMPT_DEFAULT_TIMEOUT = 10 * 60_000 // prompt 默认超时
const CONFIRM_TIMEOUT_DEFAULT = 5 * 60_000  // 确认超时默认 5 分钟
const EXEC_LOG_KEEP = 2000        // exec.log 轮转保留行数(约 2000 条记录)

// ============================================================
// 工具函数
// ============================================================

function newId() {
  return 'r' + randomBytes(3).toString('hex')   // r7f3k2 风格,6 位
}

/** 解析相对时间 "90s" / "5m" / "1h30m" → 毫秒;非法返回 null */
export function parseRelativeTime(str) {
  if (!str || typeof str !== 'string') return null
  const m = str.trim().match(/^(?:(\d+)\s*d)?\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?$/i)
  if (!m) return null
  const [, d, h, mi, s] = m
  const ms = (+d || 0) * 86400e3 + (+h || 0) * 3600e3 + (+mi || 0) * 60e3 + (+s || 0) * 1e3
  return ms > 0 ? ms : null
}

/** 解析 "HH:MM"(今天已过则取明天)→ epoch ms(本地时区) */
export function parseTimeOfDay(str, now = Date.now()) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(str || '').trim())
  if (!m) return null
  const hh = +m[1], mm = +m[2]
  if (hh > 23 || mm > 59) return null
  const d = new Date(now)
  d.setHours(hh, mm, 0, 0)
  if (d.getTime() <= now) d.setDate(d.getDate() + 1)   // 已过 → 明天
  return d.getTime()
}

/** 今天的 HH:MM 窗口起点(可已过去) */
function todayWindow(hhmm, now = Date.now()) {
  const [hh, mm] = String(hhmm).split(':').map(Number)
  const d = new Date(now)
  d.setHours(hh || 0, mm || 0, 0, 0)
  return d.getTime()
}

/**
 * 解析 window 时段窗口 → 归一化为 [[startMin, endMin], ...]
 * 支持两种格式(设计 §P0-2):
 *   字符串多段: "09:20-11:30,13:00-15:00"
 *   数组:       ["09:20-11:30","13:00-15:00"]
 * 每段 "HH:MM-HH:MM"(end 必须 > start;跨午夜 22:00-02:00 视为次日归零段,见 §边界)
 * 返回空数组 = 无窗口限制(全天)。
 */
export function parseWindow(input) {
  if (input == null || input === '') return []
  const segs = Array.isArray(input) ? input : String(input).split(',')
  const out = []
  for (const raw of segs) {
    const seg = String(raw).trim()
    if (!seg) continue
    const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(seg)
    if (!m) return null                        // 非法格式 → 整体拒绝(调用方抛错)
    let [sh, sm, eh, em] = [ +m[1], +m[2], +m[3], +m[4] ]
    if (sh > 23 || eh > 23 || sm > 59 || em > 59) return null
    let s = sh * 60 + sm
    let e = eh * 60 + em
    if (e <= s) return null                    // end 必须 > start(拒绝同点/反向)
    out.push([s, e])
  }
  return out
}

/**
 * 判断某个时刻(now)是否落在 window 的任一窗口段内(基于当天 00:00 起的分钟数)。
 * window 为空 → 恒 true(全天无限制)。
 */
export function inWindow(win, now = Date.now()) {
  if (!win || win.length === 0) return true
  const d = new Date(now)
  const cur = d.getHours() * 60 + d.getMinutes()
  return win.some(([s, e]) => cur >= s && cur < e)
}

/** 原子写 JSON:temp + rename,防止半路崩溃留下半个文件 */
function atomicWriteJson(file, data) {
  const tmp = join(tmpdir(), `cc-sched-${randomBytes(4).toString('hex')}.tmp`)
  writeFileSync(tmp, JSON.stringify(data, null, 2))
  renameSync(tmp, file)
}

/** 安全读 JSON:坏文件返回 fallback */
function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf-8'))
  } catch {
    return fallback
  }
}

// ============================================================
// 主工厂
// ============================================================

export function createScheduler({
  file,                // active.json 绝对路径
  doneFile,            // done.json 绝对路径
  lockFile,            // schedule.lock 绝对路径
  execLog,             // exec.log 绝对路径(审计日志,可省略则用 doneFile 同级 .exec.log)
  confirmTimeoutMs,    // 确认超时(毫秒);0/undefined → 默认 5 分钟
  tgSend = null,       // async (text, chatId) => void — TG 通知/提醒发送
  runPrompt = null,    // async (text, task) => void — prompt 任务执行(走主循环)
  runExec = null,      // async (task) => {ok, error, exitCode, stdout, stderr} — exec 任务执行
  engineBusy = null,   // () => boolean — 引擎忙?(忙则任务延后,见 §十三)
  mode = 'internal',   // internal: 内置 timer;telegram: 只靠外部 /tick 心跳
  verbose = false,
} = {}) {
  let tasks = []           // 内存副本(active 队列)
  let timer = null
  let ticking = false      // tick 重入保护
  let disposed = false
  let owner = false        // 是否拿到多实例锁(唯一 tick 执行者)

  if (!file || !doneFile) throw new Error('scheduler: file/doneFile 必填')
  mkdirSync(dirname(file), { recursive: true })
  const execLogFile = execLog || join(dirname(doneFile), 'exec.log')
  const confirmMs = confirmTimeoutMs ?? CONFIRM_TIMEOUT_DEFAULT

  const log = (...a) => { if (verbose) console.log('[scheduler]', ...a) }

  // ----------------------------------------------------------
  // 多实例锁:wx 创建 + pid 探活清理陈旧锁
  // ----------------------------------------------------------
  function acquireLock() {
    if (!lockFile) return true
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(lockFile, 'wx')
        writeSync(fd, String(pid))
        closeSync(fd)
        return true
      } catch (e) {
        if (e.code !== 'EEXIST') return true   // 其他错误不阻塞调度(宽松降级)
        // 锁已存在:检测持有者是否存活
        const oldPid = parseInt(readJson(lockFile, '0'), 10)
        let alive = false
        if (oldPid > 0) {
          if (oldPid === pid) {
            alive = true                        // 理论不达(本进程已持有);保守让位
          } else {
            try { process.kill(oldPid, 0); alive = true } catch { alive = false }
          }
        }
        if (!alive) {
          try { unlinkSync(lockFile) } catch {}   // 陈旧锁 → 清理后重试
          continue
        }
        return false   // 持有者存活 → 让位
      }
    }
    return false
  }

  function releaseLock() {
    if (!lockFile || !owner) return
    try {
      if (parseInt(readJson(lockFile, '0'), 10) === pid) unlinkSync(lockFile)
    } catch {}
  }

  // ----------------------------------------------------------
  // 读写:每次 load 重新读盘(热更新);写以内存为准(锁保证唯一写者)
  // 注意:不做"写前 reload 合并"——合并会把内存中已删除的任务复活(僵尸),
  // 外部编辑的并发窗口由"每次 tick 开头 loadActive"吸收(30s 内生效)。
  // ----------------------------------------------------------
  function loadActive() {
    let raw = null
    let missing = false
    try {
      raw = readFileSync(file, 'utf-8')
    } catch {
      missing = true
    }
    if (missing) {
      tasks = []                                   // 首次启动:文件尚不存在
      return tasks
    }
    try {
      const data = JSON.parse(raw)
      tasks = Array.isArray(data.tasks) ? data.tasks : []
    } catch {
      // 文件存在但损坏:沿用内存副本,不覆盖不崩溃(§十四)
      if (tasks.length) log('WARN: schedule.json 解析失败,沿用内存副本')
    }
    return tasks
  }

  function saveActive() {
    atomicWriteJson(file, { version: 1, tasks })
  }

  function loadDone() {
    const data = readJson(doneFile, { version: 1, tasks: [] })
    return Array.isArray(data.tasks) ? data.tasks : []
  }

  function appendDone(entry) {
    const done = loadDone()
    done.unshift(entry)
    if (done.length > DONE_KEEP) done.length = DONE_KEEP
    atomicWriteJson(doneFile, { version: 1, tasks: done })
  }

  // ----------------------------------------------------------
  // 到期 / 过期判定(纯函数,见设计 §六/§九/§十)
  // ----------------------------------------------------------
  function graceMs(t)  { return (t.graceMinutes ?? GRACE_DEFAULT) * 60_000 }
  function lateMs(t)   { return (t.lateMinutes ?? LATE_DEFAULT) * 60_000 }

  function isDue(t, now) {
    // window 时段窗口:窗口外不触发(every/daily 生效;once 有 graceMinutes 兜底)
    // 设计 §P0-2 / 补充答复#3:窗口外 = 本轮跳过,不写 lastRun、不算错过
    if (t.kind !== 'once' && !inWindow(t.window, now)) return false
    if (t.kind === 'once') {
      return now >= t.dueAt && now <= t.dueAt + graceMs(t) && (t.lastRun ?? 0) < t.dueAt
    }
    if (t.kind === 'every') {
      if (t.lastRun == null) return now >= t.dueAt          // 首次:到达起始时刻即触发
      return now >= t.lastRun + (t.everyMs ?? 0)            // 之后:距上次执行满一个间隔
    }
    if (t.kind === 'daily') {
      const win = todayWindow(t.timeOfDay, now)
      return now >= win && now <= win + lateMs(t) && (t.lastRun ?? 0) < win
    }
    return false
  }

  function isExpired(t, now) {
    // 仅 once 有终态过期;daily/every 周期性,错过窗口自然等下一轮
    if (t.kind !== 'once') return false
    return now > t.dueAt + graceMs(t)
  }

  // ----------------------------------------------------------
  // 终态处理
  // ----------------------------------------------------------
  function summarize(text) {
    const s = String(text || '').replace(/\s+/g, ' ').trim()
    return s.length > 40 ? s.slice(0, 40) + '…' : s
  }

  /** 移出 active → 归档(once 的"删除 ID" = 移入 done) */
  function archiveTask(t, status, extra = {}) {
    tasks = tasks.filter(x => x.id !== t.id)
    appendDone({ ...t, status, finishedAt: Date.now(), ...extra })
    saveActive()
    log(`#${t.id} → ${status}`)
  }

  async function notify(channel, chatId, text) {
    if (channel !== 'telegram' || !tgSend) return
    try { await tgSend(text, chatId || null) } catch { /* 通知失败不影响主流程 */ }
  }

  // ----------------------------------------------------------
  // exec 审计日志(补充答复应用方 #1):追加写 + 行数轮转
  // ----------------------------------------------------------
  function appendExecLog(line) {
    try {
      appendFileSync(execLogFile, line + '\n')
      // 简单行数轮转:超上限则保留最近一半
      const raw = readFileSync(execLogFile, 'utf-8')
      const lines = raw.split('\n')
      if (lines.length > EXEC_LOG_KEEP) {
        const kept = lines.slice(-Math.floor(EXEC_LOG_KEEP / 2))
        writeFileSync(execLogFile, kept.join('\n'))
      }
    } catch { /* 审计日志写入失败不阻断任务 */ }
  }

  /** 默认 exec 执行器:spawn(cmd,{shell:true,timeout,cwd,env}) → 统一结果 + 审计 */
  async function defaultRunExec(task) {
    const cmd = task.action?.cmd || ''
    const cwd = task.action?.cwd || undefined
    const timeout = task.timeoutMs ?? EXEC_DEFAULT_TIMEOUT
    const startedAt = Date.now()
    const result = { ok: false, error: '', exitCode: null, stdout: '', stderr: '', durationMs: 0 }
    if (!cmd) { result.error = 'exec 任务缺少 action.cmd'; return result }

    await new Promise((resolve) => {
      let child
      try {
        child = spawn(cmd, { shell: true, cwd, timeout, env: { ...process.env, ...(task.action?.env || {}) } })
      } catch (e) { result.error = String(e.message || e); return resolve() }
      let out = '', err = ''
      child.stdout?.on('data', d => { out = (out + d).slice(-2048) })
      child.stderr?.on('data', d => { err = (err + d).slice(-2048) })
      child.on('error', e => { result.error = String(e.message || e); resolve() })
      child.on('close', (code, signal) => {
        result.exitCode = code
        result.error = signal ? `killed by ${signal}` : (code === 0 ? '' : `exit code ${code}`)
        resolve()
      })
    })
    result.ok = result.exitCode === 0 && !result.error
    result.stdout = result.stdout || ''
    result.stderr = result.stderr || ''
    result.durationMs = Date.now() - startedAt
    return result
  }

  const runExecFn = runExec || defaultRunExec

  function markExpired(t) {
    archiveTask(t, 'expired')
    if (t.onExpire === 'notify') {
      notify(t.channel, t.chatId, `⏰ 定时任务已过期未送达 [${t.id}]\n${summarize(t.action?.text)}`)
    }
  }

  function markMissed(t) {
    archiveTask(t, 'missed')
    if (t.onExpire === 'notify') {
      notify(t.channel, t.chatId, `⏰ 定时任务已错过(策略 skip)[${t.id}]\n${summarize(t.action?.text)}`)
    }
  }

  // ----------------------------------------------------------
  // 执行(先标记后执行;fire-and-forget,不阻塞 tick)
  // ----------------------------------------------------------
  /** 是否应通知本次执行结果(按 notifyOn 策略) */
  function shouldNotify(t, ok) {
    if (t.notifyOn === 'never') return false
    if (t.notifyOn === 'onError') return !ok            // 仅异常告警(高频巡检默认)
    return true                                          // always
  }

  async function execute(t) {
    let ok = false
    let error = ''
    let audit = null          // exec 审计记录(供 execute 统一落盘,无论 runExec 实现)
    try {
      if (t.action?.type === 'exec') {
        // exec 超时(设计 §P0-3):整个执行(含脚本内拉起+等待)总预算
        const to = t.timeoutMs ?? EXEC_DEFAULT_TIMEOUT
        let timer
        const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`timeout after ${to}ms`)), to); timer.unref?.() })
        let r
        try {
          r = await Promise.race([runExecFn(t), timeout])
        } finally { clearTimeout(timer) }
        ok = r.ok
        error = r.error || (r.stdout || r.stderr ? `stdout/stderr: ${(r.stdout || r.stderr).slice(0, 200)}` : '')
        // 审计日志(补充答复#1):命令全文 + 结果 + 退出码 + 时间戳 + 创建来源,统一在这里落盘
        audit = {
          ts: new Date().toISOString(), task: t.id, kind: 'exec',
          cmd: t.action.cmd, cwd: t.action.cwd || null,
          timeout: to, exitCode: r.exitCode ?? null, ok,
          durationMs: r.durationMs ?? null, createdBy: t.createdBy,
          stdout: (r.stdout || '').slice(0, 2048), stderr: (r.stderr || '').slice(0, 2048),
          lastError: error || null,
        }
        appendExecLog(JSON.stringify(audit))
        // exec 通知:仅 onError 时告警(正常静默,异常才响)—— 补充答复#6
        if (shouldNotify(t, ok)) {
          const head = ok ? '✅' : '❌'
          const detail = ok ? (r.stdout || '(无输出)').slice(0, 300) : (r.error || r.stderr || '(无错误信息)').slice(0, 300)
          await notify(t.channel, t.chatId, `${head} exec [${t.id}] ${t.action.cmd}\n${detail}`)
        }
      } else if (t.action?.type === 'prompt' && runPrompt) {
        // prompt 超时(设计 §P0-3):超过 timeoutMs 即视为失败(走失败/重试路径)
        const to = t.timeoutMs ?? PROMPT_DEFAULT_TIMEOUT
        let timer
        const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`timeout after ${to}ms`)), to); timer.unref?.() })
        try {
          await Promise.race([runPrompt(t.action.text || '', t), timeout])
        } finally {
          clearTimeout(timer)
        }
        ok = true
      } else {
        // tg 类(默认):直接发提醒文本
        await notify(t.channel, t.chatId, `⏰ 提醒 [${t.id}]\n${t.action?.text || ''}`)
        ok = true
      }
      if (!ok && !error) error = 'exec 返回非零退出码'
      finish(t, ok ? 'done' : 'failed', { lastError: error })
    } catch (err) {
      const msg = err?.message || String(err)
      // exec 超时/异常:补一条审计(命令全文 + 失败原因),保证审计闭环在超时场景也不缺(补充答复#1)
      if (t.action?.type === 'exec') {
        appendExecLog(JSON.stringify({
          ts: new Date().toISOString(), task: t.id, kind: 'exec',
          cmd: t.action.cmd, cwd: t.action.cwd || null,
          timeout: t.timeoutMs ?? EXEC_DEFAULT_TIMEOUT,
          exitCode: null, ok: false, durationMs: null,
          createdBy: t.createdBy, stdout: '', stderr: '',
          lastError: msg,
        }))
      }
      finish(t, 'failed', { lastError: msg })
    }
  }

  /** 完成处理:once 移入 done;daily/every 留在 active 重算窗口。
   *  failed 且还有重试配额 & 仍处窗口内 → 延迟重试(设计 §P1-2 / 补充答复#3) */
  function finish(t, status, extra = {}) {
    const cur = tasks.find(x => x.id === t.id)
    const now = Date.now()

    // 失败且允许重试 & 仍在窗口内(窗口外本轮放弃)→ 回滚到 pending + 延后 dueAt
    if (status === 'failed' && (cur?.maxRetries ?? 0) > (cur?.retried ?? 0) && inWindow(cur?.window, now)) {
      if (cur) {
        cur.status = 'pending'
        cur.retried = (cur.retried ?? 0) + 1
        cur.lastError = extra.lastError || null
        cur.dueAt = now + (cur.retryDelayMs ?? 60_000)   // 延迟重试(设计 §P1-2)
        saveActive()
        scheduleWake()                                   // 对齐新到期时刻(秒级重试)
        log(`#${t.id} failed, retry ${cur.retried}/${cur.maxRetries} in ${(cur.retryDelayMs ?? 60_000) / 1000}s`)
        return
      }
    }

    if (t.kind === 'once') {
      archiveTask(t, status, extra)
      return
    }
    // recurring:留在 active,续期
    if (cur) {
      cur.status = 'pending'
      cur.lastRun = now
      cur.retried = 0
      if (t.kind === 'every') cur.dueAt = cur.lastRun + (cur.everyMs ?? 0)
      cur.lastError = extra.lastError || null
      saveActive()
    }
    if (status !== 'done') {
      log(`#${t.id} recurring ${status}: ${extra.lastError || ''}`)
    }
  }

  // ----------------------------------------------------------
  // tick 核心(见设计 §六)
  // ----------------------------------------------------------
  function tickNow() {
    if (ticking || disposed || !owner) return
    ticking = true
    try {
      loadActive()                                 // 每次重新读盘 → 热更新
      const now = Date.now()

      // 1) 过期分流(与忙闲无关,先行处理)
      const expired = tasks.filter(t => t.status === 'pending' && isExpired(t, now))
      for (const t of expired) markExpired(t)

      // 2) skip 策略的 once:窗口内到达即放弃(不执行)
      const skipped = tasks.filter(t =>
        t.status === 'pending' && t.kind === 'once' &&
        t.missPolicy === 'skip' && isDue(t, now))
      for (const t of skipped) markMissed(t)

      // 3) 到期任务
      let due = tasks.filter(t =>
        t.status === 'pending' && t.kind === 'once' &&
        t.missPolicy !== 'skip' && isDue(t, now))
      due = due.concat(tasks.filter(t =>
        t.status === 'pending' && t.kind !== 'once' && isDue(t, now)))

      if (due.length) {
        if (engineBusy?.()) {
          // 忙 ≠ 失败 ≠ 丢弃:保持 pending,30s 后重试(§十三.1)
          log(`busy, defer ${due.length} task(s)`)
          return
        }
        // 先标记后执行(防 tick 重入 / 崩溃重复)
        for (const t of due) { t.status = 'running'; t.lastRun = now }
        saveActive()
        for (const t of due) {
          execute(t).catch(e => log(`execute error: ${e.message}`))   // fire-and-forget
        }
      }

      // 4) 队列空 → 自动熄火(§五)
      if (tasks.length === 0) stopTimer()
    } catch (e) {
      log(`tick error: ${e.message}`)
    } finally {
      ticking = false
      scheduleWake()                                   // 到期时刻可能已变,重新对齐
    }
  }

  // ----------------------------------------------------------
  // 启停(§五:有任务才点燃,烧完自灭)
  // ----------------------------------------------------------
  // 秒级精确唤醒(设计 §P1-1):轮询兜底 30s,这里再加一个对齐最近到期时刻的 setTimeout
  // 醒来后 tickNow 走对账;任务取消/队列空时 clear。>24.8 天溢出线拆链(<30s 也不拆,由轮询兜底)。
  let wakeTimer = null
  function scheduleWake() {
    if (disposed || mode === 'telegram' || !owner) return
    clearTimeout(wakeTimer)
    // 找最近一次到期时刻,若比轮询间隔近则用精确定时
    let nearest = Infinity
    const now = Date.now()
    for (const t of tasks) {
      if (t.status !== 'pending') continue
      if (t.kind === 'once') nearest = Math.min(nearest, t.dueAt)
      else if (t.kind === 'every') nearest = Math.min(nearest, (t.lastRun ?? 0) + (t.everyMs ?? 0))
      else if (t.kind === 'daily') nearest = Math.min(nearest, todayWindow(t.timeOfDay, now))
    }
    const delay = nearest - now
    if (Number.isFinite(delay) && delay > 0 && delay < TICK_MS - 1000) {
      // 对齐最近到期,且不设过长的定时(拆链阈值 21 天)
      const capped = Math.min(delay, 21 * 86400e3)
      wakeTimer = setTimeout(() => { wakeTimer = null; tickNow(); scheduleWake() }, Math.max(capped, 1))
      wakeTimer.unref?.()
    }
  }

  function ensureTimer() {
    if (timer || disposed || mode === 'telegram' || !owner) return
    timer = setInterval(tickNow, TICK_MS)
    timer.unref?.()   // 不阻止进程自然退出
    scheduleWake()
    log(`timer started (every ${TICK_MS / 1000}s)`)
  }

  function stopTimer() {
    if (timer) { clearInterval(timer); timer = null; log('timer stopped (queue empty)') }
    if (wakeTimer) { clearTimeout(wakeTimer); wakeTimer = null }
  }

  // ----------------------------------------------------------
  // 对外接口
  // ----------------------------------------------------------
  /** 添加任务并持久化;返回 id */
  function addTask(spec = {}) {
    const now = Date.now()
    // window 归一化:非法格式直接抛错(防静默忽略)
    const window = parseWindow(spec.window)
    if (window === null) throw new Error(`window 格式非法: ${JSON.stringify(spec.window)}(应为 "HH:MM-HH:MM" 或 ["HH:MM-HH:MM",...])`)
    // exec 动作校验
    if ((spec.actionType === 'exec') && !spec.cmd) throw new Error('exec 任务需要 cmd(要执行的命令)')
    const t = {
      id: newId(),
      kind: spec.kind || 'once',                       // once | daily | every
      dueAt: spec.dueAt ?? (spec.kind === 'every' ? now + (spec.everyMs || 0) : now),
      everyMs: spec.everyMs || null,
      timeOfDay: spec.timeOfDay || null,               // "HH:MM"
      tz: spec.tz || '',                               // 预留;空=本地时区
      window,                                          // [[startMin,endMin],...];空=全天
      action: { type: spec.actionType || 'tg', text: spec.text || '', cmd: spec.cmd || '' },
      channel: spec.channel || 'telegram',
      chatId: spec.chatId || null,
      missPolicy: spec.missPolicy || 'run',            // run | skip
      graceMinutes: spec.graceMinutes,
      lateMinutes: spec.lateMinutes,
      onExpire: spec.onExpire || 'notify',
      timeoutMs: spec.timeoutMs ?? null,               // 执行超时(exec 默认 60s / prompt 默认 10min)
      notifyOn: spec.notifyOn || 'always',             // always | onError | never(exec 高频用 onError)
      maxRetries: spec.maxRetries ?? 0,                // 失败重试次数
      retryDelayMs: spec.retryDelayMs ?? 60_000,       // 重试间隔(默认 60s)
      retried: 0,
      status: 'pending',
      lastRun: null,
      lastError: null,
      createdAt: now,
      createdBy: spec.createdBy || 'repl',             // repl | telegram | agent
    }
    // 校验
    if (t.kind === 'once' && !t.dueAt) throw new Error('once 任务需要 dueAt')
    if (t.kind === 'daily' && !parseTimeOfDay(t.timeOfDay + '')) throw new Error('daily 任务需要 timeOfDay "HH:MM"')
    if (t.kind === 'every' && !(t.everyMs > 0)) throw new Error('every 任务需要 everyMs > 0')
    if (!t.action.text && t.action.type !== 'exec') throw new Error('action.text 必填')

    loadActive()                                       // 先读盘,防止覆盖外部新增
    tasks.push(t)
    saveActive()
    log(`+ task ${t.id} (${t.kind}) — ${summarize(t.action.text || t.action.cmd)}`)
    ensureTimer()
    scheduleWake()                                     // 对齐最近到期时刻(秒级精确唤醒)
    tickNow()                                          // 立即查一次(处理"10 秒后"的超短任务)
    return t.id
  }

  /** 取消:pending → cancelled,移入 done;队列空则停 timer */
  function cancel(id) {
    loadActive()
    const t = tasks.find(x => x.id === id)
    if (!t) return false
    archiveTask(t, 'cancelled')
    if (tasks.length === 0) stopTimer()
    return true
  }

  /** 列出 active(附人可读的到期描述) */
  function list() {
    loadActive()
    const now = Date.now()
    return tasks.map(t => ({ ...t, dueDesc: describeDue(t, now) }))
  }

  function describeDue(t, now) {
    const winDesc = t.window?.length
      ? `(时段 ${t.window.map(([s, e]) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}-${String(Math.floor(e / 60)).padStart(2, '0')}:${String(e % 60).padStart(2, '0')}`).join(' ')}`
      : ''
    if (t.kind === 'once') {
      return t.status === 'running' ? '执行中'
        : `${new Date(t.dueAt).toLocaleString()}${winDesc}${isExpired(t, now) ? '(已过期)' : ''}`
    }
    if (t.kind === 'every') {
      const next = t.lastRun == null ? t.dueAt : t.lastRun + (t.everyMs ?? 0)
      return `每 ${Math.round((t.everyMs ?? 0) / 60000)} 分钟,下次 ${new Date(next).toLocaleTimeString()}${winDesc}`
    }
    if (t.kind === 'daily') {
      return `每天 ${t.timeOfDay},下次 ${new Date(todayWindow(t.timeOfDay, now) <= (t.lastRun ?? 0) ? todayWindow(t.timeOfDay, now) + 86400e3 : todayWindow(t.timeOfDay, now)).toLocaleString()}${winDesc}`
    }
    return ''
  }

  /** 归档历史(最近 N 条) */
  function history(n = 20) { return loadDone().slice(0, n) }

  function hasActive() { return loadActive().length > 0 }

  function isOwner() { return owner }

  /** 启动:拿锁 → 加载 → 有任务则恢复 timer → 立即对账一次 */
  function start() {
    if (disposed) return
    owner = acquireLock()
    if (!owner) {
      log('another instance owns the scheduler — passive mode')
      return
    }
    loadActive()
    // 崩溃残留 running:提醒类不可重入,标 failed 归档(§十状态机)
    const stuck = tasks.filter(t => t.status === 'running')
    for (const t of stuck) {
      if (t.kind === 'once') archiveTask(t, 'failed', { lastError: 'interrupted by restart' })
      else { t.status = 'pending'; t.lastError = 'interrupted by restart' }
    }
    if (stuck.length) saveActive()
    if (mode !== 'telegram') ensureTimer()
    tickNow()                                          // 启动对账:含过期分流/补跑
  }

  function dispose() {
    disposed = true
    stopTimer()
    releaseLock()
  }

  return { start, dispose, addTask, cancel, remove: cancel, list, history, tickNow, hasActive, isOwner }
}

// ============================================================
// 全局单例(供 MCP 工具层调用,cli.js 负责创建)
// ============================================================
let _global = null
export function setGlobalScheduler(s) { _global = s }
export function getGlobalScheduler() { return _global }
