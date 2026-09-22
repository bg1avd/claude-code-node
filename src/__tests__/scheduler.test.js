// ============================================================
//  scheduler.test.js — 按需定时任务单测(对应 SCHEDULER_DESIGN.md)
//  运行:node --test src/__tests__/scheduler.test.js
// ============================================================
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createScheduler, parseRelativeTime, parseTimeOfDay, parseWindow, inWindow } from '../core/scheduler.js'

let dir
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cc-sched-test-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

// exec 测试用的 TG 收集
const tgSentArr = []
beforeEach(() => { tgSentArr.length = 0 })

function make(overrides = {}) {
  const tgSent = []
  const prompts = []
  const s = createScheduler({
    file: join(dir, 'schedule.json'),
    doneFile: join(dir, 'schedule.done.json'),
    lockFile: join(dir, 'schedule.lock'),
    tgSend: async (text, chatId) => tgSent.push({ text, chatId }),
    runPrompt: async (text, task) => prompts.push({ text, task }),
    engineBusy: () => overrides.busy?.() ?? false,
    mode: overrides.mode || 'internal',
    verbose: false,
    ...overrides.ctor,
  })
  return { s, tgSent, prompts }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ============================================================
// 时间解析
// ============================================================
test('parseRelativeTime: 各式相对时间', () => {
  assert.equal(parseRelativeTime('90s'), 90_000)
  assert.equal(parseRelativeTime('5m'), 300_000)
  assert.equal(parseRelativeTime('1h30m'), 5_400_000)
  assert.equal(parseRelativeTime('2d'), 172_800_000)
  assert.equal(parseRelativeTime('1h 30m'), 5_400_000)   // 允许空格
  assert.equal(parseRelativeTime('abc'), null)
  assert.equal(parseRelativeTime('0m'), null)
  assert.equal(parseRelativeTime(''), null)
})

test('parseTimeOfDay: 今天已过 → 明天;未过 → 今天', () => {
  const now = new Date(); now.setHours(10, 0, 0, 0)
  const past = parseTimeOfDay('09:00', now.getTime())
  const future = parseTimeOfDay('11:00', now.getTime())
  assert.equal(past - now.getTime() > 0, true)
  assert.ok(past - now.getTime() <= 86400e3 + 3600e3)      // 明天 9 点
  assert.equal(future - now.getTime(), 3600_000)            // 今天 11 点
  assert.equal(parseTimeOfDay('25:00'), null)
  assert.equal(parseTimeOfDay('xx'), null)
})

// ============================================================
// once 任务:执行 → 归档 → 队列空自停
// ============================================================
test('once 任务到期执行(tg 提醒),归档 done,timer 自停', async () => {
  const { s, tgSent } = make()
  s.start()
  const id = s.addTask({ kind: 'once', dueAt: Date.now() - 1000, text: '查股票', actionType: 'tg', channel: 'telegram', chatId: '123' })
  await sleep(80)   // execute fire-and-forget,等一下

  assert.equal(s.list().length, 0)                    // 移出 active
  const hist = s.history()
  assert.equal(hist.length, 1)
  assert.equal(hist[0].id, id)
  assert.equal(hist[0].status, 'done')
  assert.equal(tgSent.length, 1)
  assert.match(tgSent[0].text, /查股票/)
  assert.equal(tgSent[0].chatId, '123')
  s.dispose()
})

test('once prompt 任务走 runPrompt,失败标 failed', async () => {
  const prompts = []
  const s = createScheduler({
    file: join(dir, 'a.json'), doneFile: join(dir, 'b.json'), lockFile: join(dir, 'c.lock'),
    runPrompt: async (text) => { prompts.push(text); if (prompts.length === 1) throw new Error('boom') },
    engineBusy: () => false, verbose: false,
  })
  s.start()
  s.addTask({ kind: 'once', dueAt: Date.now() - 1000, text: '检查log', actionType: 'prompt', channel: 'repl' })
  await sleep(80)
  let hist = s.history()
  assert.equal(hist[0].status, 'failed')
  assert.equal(hist[0].lastError, 'boom')
  assert.equal(prompts[0], '检查log')
  s.dispose()
})

// ============================================================
// 防重:两个 tick 不双跑
// ============================================================
test('once 任务窗口内多次 tick 只执行一次', async () => {
  const { s, tgSent } = make()
  s.start()
  s.addTask({ kind: 'once', dueAt: Date.now() - 1000, text: 'x', actionType: 'tg', graceMinutes: 10 })
  await sleep(80)
  s.tickNow(); s.tickNow(); s.tickNow()               // 窗口内重复 tick
  await sleep(80)
  assert.equal(tgSent.length, 1)
  assert.equal(s.history().length, 1)
  s.dispose()
})

// ============================================================
// 忙时延后:忙 → pending 不动;空闲后执行
// ============================================================
test('engineBusy 时任务延后不执行,空闲后下次 tick 执行', async () => {
  let busy = true
  const { s, tgSent } = make({ busy: () => busy })
  s.start()
  s.addTask({ kind: 'once', dueAt: Date.now() - 1000, text: '晚点跑', actionType: 'tg' })
  await sleep(80)
  assert.equal(tgSent.length, 0)                       // 忙:不执行
  assert.equal(s.list().length, 1)                     // 仍在 active
  assert.equal(s.list()[0].status, 'pending')          // 未被标 running
  busy = false
  s.tickNow()
  await sleep(80)
  assert.equal(tgSent.length, 1)                       // 空闲后执行
  assert.equal(s.history()[0].status, 'done')
  s.dispose()
})

// ============================================================
// 过期:grace 外 → expired + notify;grace 内 skip → missed
// ============================================================
test('once 超过 grace 未执行 → expired,onExpire=notify 发通知', async () => {
  const { s, tgSent } = make()
  s.start()
  // 直接写入一个 20 分钟前到期的任务(grace 默认 10 分钟)
  s.addTask({ kind: 'once', dueAt: Date.now() - 20 * 60_000, text: '过期任务', actionType: 'tg', onExpire: 'notify' })
  // addTask 后立即 tickNow 已处理:应已归档为 expired
  const hist = s.history()
  assert.equal(hist[0].status, 'expired')
  assert.equal(s.list().length, 0)
  assert.equal(tgSent.length, 1)
  assert.match(tgSent[0].text, /过期/)
  s.dispose()
})

test('once + missPolicy=skip 在 grace 内到达 → missed 不执行', async () => {
  const { s, tgSent } = make()
  s.start()
  // onExpire:'silent' 聚焦测试"不执行提醒"本身(missed 默认也有通知,见 notify 设计)
  s.addTask({ kind: 'once', dueAt: Date.now() - 60_000, text: '开会提醒', actionType: 'tg', missPolicy: 'skip', onExpire: 'silent' })
  const hist = s.history()
  assert.equal(hist[0].status, 'missed')
  assert.equal(tgSent.length, 0)                       // skip:不发提醒
  s.dispose()
})

test('once + missPolicy=run 在 grace 内到达 → 补跑', async () => {
  const { s, tgSent } = make()
  s.start()
  s.addTask({ kind: 'once', dueAt: Date.now() - 5 * 60_000, text: '迟到的提醒', actionType: 'tg' })
  await sleep(80)                                      // execute fire-and-forget,等归档完成
  const hist = s.history()
  assert.equal(hist[0].status, 'done')
  assert.equal(tgSent.length, 1)
  s.dispose()
})

// ============================================================
// daily:窗口判定 + 防重 + 续期
// ============================================================
test('daily 窗口执行后留在 active,lastRun 防重', async () => {
  const { s, tgSent } = make()
  s.start()
  const now = new Date()
  now.setHours(now.getHours(), now.getMinutes() - 1, 0, 0)   // 1 分钟前的 HH:MM(今天窗口已过,允许补跑)
  const hh = String(now.getHours()).padStart(2, '0')
  const mm = String(now.getMinutes()).padStart(2, '0')
  s.addTask({ kind: 'daily', timeOfDay: `${hh}:${mm}`, text: '日报', actionType: 'tg' })
  await sleep(80)
  assert.equal(tgSent.length, 1)
  const act = s.list()
  assert.equal(act.length, 1)                          // 留在 active
  assert.equal(act[0].status, 'pending')
  assert.ok(act[0].lastRun > 0)
  const lastRun1 = act[0].lastRun
  s.tickNow(); s.tickNow()
  await sleep(60)
  assert.equal(tgSent.length, 1)                       // 同窗口不重复
  assert.equal(s.list()[0].lastRun, lastRun1)
  s.dispose()
})

// ============================================================
// every:按间隔触发
// ============================================================
test('every 任务按 everyMs 间隔触发并续期', async () => {
  const { s, tgSent } = make()
  s.start()
  s.addTask({ kind: 'every', everyMs: 2000, text: '心跳检查', actionType: 'tg', dueAt: Date.now() - 100 })
  await sleep(80)
  assert.equal(tgSent.length, 1)
  assert.equal(s.list().length, 1)                     // 续期留 active
  const after1 = s.list()[0].dueAt
  assert.ok(after1 > Date.now() + 1000)                // dueAt = lastRun + everyMs
  s.dispose()
})

// ============================================================
// cancel / remove
// ============================================================
test('cancel:pending → cancelled 归档', async () => {
  const { s } = make()
  s.start()
  const id = s.addTask({ kind: 'once', dueAt: Date.now() + 3600_000, text: '以后的事', actionType: 'tg' })
  assert.equal(s.list().length, 1)
  assert.equal(s.cancel(id), true)
  assert.equal(s.list().length, 0)
  assert.equal(s.history()[0].status, 'cancelled')
  assert.equal(s.cancel('nonexist'), false)
  s.dispose()
})

// ============================================================
// 多实例锁:第二个实例 passive,不抢任务
// ============================================================
test('第二个实例拿不到锁,被动模式不执行任务', async () => {
  const { s: s1, tgSent: sent1 } = make()
  s1.start()
  s1.addTask({ kind: 'once', dueAt: Date.now() - 1000, text: '只跑一次', actionType: 'tg' })
  await sleep(80)

  const { s: s2, tgSent: sent2 } = make()
  s2.start()
  assert.equal(s2.isOwner(), false)                    // 让位
  assert.equal(sent2.length, 0)
  s2.dispose()

  assert.equal(sent1.length, 1)                        // 任务由 s1 执行,且只一次
  s1.dispose()
  assert.equal(existsSync(join(dir, 'schedule.lock')), false)  // 释放锁
})

// ============================================================
// 归档滚动上限 100
// ============================================================
test('done.json 超过 100 条丢最旧', async () => {
  const { s } = make()
  // 直接写 105 条归档(old104 在最前、old0 在最末 = 最旧)
  const done = { version: 1, tasks: Array.from({ length: 105 }, (_, i) => ({ id: `old${104 - i}`, status: 'done' })) }
  writeFileSync(join(dir, 'schedule.done.json'), JSON.stringify(done))
  s.start()
  s.addTask({ kind: 'once', dueAt: Date.now() - 1000, text: '新任务', actionType: 'tg' })
  await sleep(80)                                      // 等 execute 完成后 appendDone 生效
  const hist = s.history(200)
  assert.equal(hist.length, 100)
  assert.equal(hist[0].status, 'done')                 // 新的在前
  assert.ok(!hist.some(h => h.id === 'old0'))          // 最旧的被挤掉
  s.dispose()
})

// ============================================================
// 崩溃残留 running → 启动时标 failed
// ============================================================
test('启动发现 running 残留 → once 标 failed 归档', async () => {
  // 预置一个 running 残留
  const pre = { version: 1, tasks: [{ id: 'stuck1', kind: 'once', dueAt: Date.now() - 1000,
    action: { type: 'tg', text: '残留' }, channel: 'telegram', status: 'running',
    missPolicy: 'run', lastRun: Date.now() - 5000, createdAt: Date.now() - 6000 }] }
  writeFileSync(join(dir, 'schedule.json'), JSON.stringify(pre))

  const { s } = make()
  s.start()
  assert.equal(s.list().length, 0)
  const hist = s.history()
  assert.equal(hist[0].id, 'stuck1')
  assert.equal(hist[0].status, 'failed')
  assert.match(hist[0].lastError, /interrupted/)
  s.dispose()
})

// ============================================================
// 热更新:外部改 JSON → 下次 tick 生效;坏 JSON 不崩
// ============================================================
test('外部删除任务 → 下次 tick 不再执行', async () => {
  const { s, tgSent } = make()
  s.start()
  const id = s.addTask({ kind: 'once', dueAt: Date.now() + 3600_000, text: '会被外部删', actionType: 'tg' })
  // 模拟外部编辑:从盘上删除该任务
  const disk = JSON.parse(readFileSync(join(dir, 'schedule.json'), 'utf-8'))
  disk.tasks = disk.tasks.filter(t => t.id !== id)
  writeFileSync(join(dir, 'schedule.json'), JSON.stringify(disk))
  await sleep(30)
  s.tickNow()
  assert.equal(s.list().length, 0)                     // 内存已被盘上内容刷新
  assert.equal(tgSent.length, 0)
  s.dispose()
})

test('坏 JSON 不崩,沿用内存副本', async () => {
  const { s, tgSent } = make()
  s.start()
  s.addTask({ kind: 'once', dueAt: Date.now() + 3600_000, text: '任务A', actionType: 'tg' })
  writeFileSync(join(dir, 'schedule.json'), '{oops broken')   // 外部写坏
  s.tickNow()                                          // 不应抛
  assert.equal(s.list().length, 1)                     // 内存副本还在
  assert.equal(tgSent.length, 0)
  s.dispose()
})

// ============================================================
// telegram 档:不开内置 timer,只响应 tickNow
// ============================================================
test('mode=telegram 不启 timer,tickNow 仍可驱动', async () => {
  const { s, tgSent } = make({ mode: 'telegram' })
  s.start()
  s.addTask({ kind: 'once', dueAt: Date.now() - 1000, text: '外部驱动', actionType: 'tg' })
  await sleep(80)
  assert.equal(tgSent.length, 1)                       // addTask 内部调用了 tickNow
  assert.equal(s.list().length, 0)
  s.dispose()
})

// ============================================================
// 原子写:盘上文件是完整 JSON
// ============================================================
test('saveActive 后盘上 JSON 完整可解析', () => {
  const { s } = make()
  s.start()
  s.addTask({ kind: 'once', dueAt: Date.now() + 3600_000, text: '原子性', actionType: 'tg' })
  const raw = readFileSync(join(dir, 'schedule.json'), 'utf-8')
  const data = JSON.parse(raw)                          // 不抛即完整
  assert.equal(data.tasks.length, 1)
  assert.equal(data.version, 1)
  s.dispose()
})

// ============================================================
// window 时段窗口(设计 §P0-2 / 补充答复#3)
// ============================================================
test('parseWindow: 字符串多段 / 数组 / 非法', () => {
  assert.deepEqual(parseWindow('09:20-11:30,13:00-15:00'), [[560, 690], [780, 900]])
  assert.deepEqual(parseWindow(['09:20-11:30', '13:00-15:00']), [[560, 690], [780, 900]])
  assert.deepEqual(parseWindow(''), [])
  assert.deepEqual(parseWindow(undefined), [])
  assert.equal(parseWindow('09:20-11:30,abc'), null)     // 整体拒绝
  assert.equal(parseWindow('11:30-09:20'), null)          // end < start
  assert.equal(parseWindow('25:00-26:00'), null)
})

test('inWindow 纯函数:窗口内/外判定', () => {
  const now = new Date(); now.setHours(10, 30, 0, 0)      // 10:30
  assert.equal(inWindow([[630, 700]], now.getTime()), true)   // 10:30 ∈ [10:30,11:40)
  assert.equal(inWindow([[0, 630]], now.getTime()), false)    // 10:30 ∉ [00:00,10:30)
  assert.equal(inWindow([], now.getTime()), true)             // 空 = 全天
  assert.equal(inWindow(undefined, now.getTime()), true)
})

test('window 窗口外 every 不触发,窗口内触发', async () => {
  // 窗口内:用 once(确定性只跑一次)验证"窗口内可触发"
  const { s, tgSent } = make()
  s.start()
  const d = new Date()
  const sm = d.getMinutes() - 1
  const em = d.getMinutes() + 5
  const pad = n => String(Math.max(0, Math.min(59, n))).padStart(2, '0')
  const winStr = `${pad(d.getHours())}:${pad(sm)}-${pad(d.getHours())}:${pad(em)}`
  s.addTask({ kind: 'once', dueAt: Date.now() - 100, text: '窗口内', actionType: 'tg', window: winStr })
  await sleep(80)
  assert.equal(tgSent.length, 1)                         // 窗口内 → 触发
  // 窗口外:every 完全排除当前时刻(明早 2 点),不触发
  const { s: s2, tgSent: tg2 } = make()
  s2.start()
  s2.addTask({ kind: 'every', everyMs: 1000, text: '不触发', actionType: 'tg', window: '02:00-02:30', dueAt: Date.now() - 100 })
  s2.tickNow()
  await sleep(80)
  assert.equal(tg2.length, 0)                            // 窗口外 → 不触发
  assert.equal(s2.list().length, 1)                      // 任务仍在,等窗口
  s.dispose(); s2.dispose()
})

// ============================================================
// exec 动作轨道(设计 §P0-1 / 补充答复#1/#6)
// ============================================================
test('exec 动作执行成功走 runExec,写审计日志,notifyOn=onError 静默', async () => {
  const execResults = []
  const s = createScheduler({
    file: join(dir, 'e1.json'), doneFile: join(dir, 'e1.done.json'), lockFile: join(dir, 'e1.lock'),
    execLog: join(dir, 'exec.log'),
    runExec: async (task) => { const r = { ok: true, exitCode: 0, stdout: 'OK', stderr: '', error: '' }; execResults.push(task); return r },
    tgSend: async (t, c) => tgSentPush(t, c),
    engineBusy: () => false, verbose: false,
  })
  s.start()
  s.addTask({ kind: 'once', dueAt: Date.now() - 100, actionType: 'exec', cmd: 'echo hi', notifyOn: 'onError', createdBy: 'agent' })
  await sleep(80)
  assert.equal(execResults.length, 1)                    // exec 被执行
  assert.equal(s.history()[0].status, 'done')
  assert.equal(tgSentArr.length, 0)                      // onError + 成功 → 静默
  const logRaw = readFileSync(join(dir, 'exec.log'), 'utf-8')
  assert.match(logRaw, /echo hi/)                        // 审计含命令全文
  assert.match(logRaw, /createdBy.*agent/)
  s.dispose()
})

test('exec 失败 → failed 归档 + onError 告警', async () => {
  const s = createScheduler({
    file: join(dir, 'e2.json'), doneFile: join(dir, 'e2.done.json'), lockFile: join(dir, 'e2.lock'),
    execLog: join(dir, 'e2.log'),
    runExec: async () => ({ ok: false, exitCode: 1, stdout: '', stderr: 'boom', error: 'exit code 1' }),
    tgSend: async (t, c) => tgSentPush(t, c),
    engineBusy: () => false, verbose: false,
  })
  s.start()
  s.addTask({ kind: 'once', dueAt: Date.now() - 100, actionType: 'exec', cmd: 'false', notifyOn: 'onError', channel: 'telegram' })
  await sleep(80)
  assert.equal(s.history()[0].status, 'failed')
  assert.equal(tgSentArr.length, 1)                      // 异常 → 告警
  assert.match(tgSentArr[0].text, /exec/)
  s.dispose()
})

// ============================================================
// 执行超时(设计 §P0-3)
// ============================================================
test('exec 超时 → failed + lastError 含 timeout', async () => {
  const s = createScheduler({
    file: join(dir, 't1.json'), doneFile: join(dir, 't1.done.json'), lockFile: join(dir, 't1.lock'),
    runExec: async () => new Promise(() => {}),          // 永不 resolve
    tgSend: async () => {}, engineBusy: () => false, verbose: false,
  })
  s.start()
  s.addTask({ kind: 'once', dueAt: Date.now() - 100, actionType: 'exec', cmd: 'hang', timeoutMs: 150 })
  await sleep(300)
  assert.equal(s.history()[0].status, 'failed')
  assert.match(s.history()[0].lastError || '', /timeout/i)
  s.dispose()
})

// ============================================================
// 失败重试(设计 §P1-2 / 补充答复#3:重试限窗口内)
// ============================================================
test('maxRetries 失败后延迟重试,耗尽才归档 failed', async () => {
  let calls = 0
  const s = createScheduler({
    file: join(dir, 'r1.json'), doneFile: join(dir, 'r1.done.json'), lockFile: join(dir, 'r1.lock'),
    tgSend: async () => {},
    runExec: async () => { calls++; return calls < 3 ? { ok: false, error: 'temporary' } : { ok: true, stdout: 'ok' } },
    engineBusy: () => false, verbose: false,
  })
  s.start()
  s.addTask({ kind: 'once', dueAt: Date.now() - 100, actionType: 'exec', cmd: 'x', maxRetries: 3, retryDelayMs: 20 })
  // 轮询驱动直到达到 3 次调用(确定性,容忍异步 execute 时序)
  const deadline = Date.now() + 1500
  while (calls < 3 && Date.now() < deadline) {
    await sleep(30)
    s.tickNow()
  }
  assert.equal(calls, 3)
  assert.equal(s.history()[0].status, 'done')
  s.dispose()
})

test('重试耗尽仍失败 → 归档 failed', async () => {
  let calls = 0
  const s = createScheduler({
    file: join(dir, 'r2.json'), doneFile: join(dir, 'r2.done.json'), lockFile: join(dir, 'r2.lock'),
    tgSend: async () => {},
    runExec: async () => { calls++; return { ok: false, error: 'always fail' } },
    engineBusy: () => false, verbose: false,
  })
  s.start()
  s.addTask({ kind: 'once', dueAt: Date.now() - 100, actionType: 'exec', cmd: 'x', maxRetries: 2, retryDelayMs: 20 })
  const deadline = Date.now() + 1500
  while (calls < 3 && Date.now() < deadline) {
    await sleep(30)
    s.tickNow()
  }
  assert.equal(calls, 3)                                 // 1 次 + 2 次重试
  assert.equal(s.history()[0].status, 'failed')
  s.dispose()
})

// 辅助:exec 测试用的 TG 收集(已在顶部 beforeEach 清空)
const tgSentPush = (t, c) => tgSentArr.push({ text: t, chatId: c })

