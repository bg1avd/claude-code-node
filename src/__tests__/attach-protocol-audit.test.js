// ============================================================
//  attach-protocol-audit.test.js
//
//  来自接入方（cc-node-mobile）的 v4.1.0 审核报告回归测试。
//  每一条都对应报告里的一个具体缺陷编号：
//    P0-1 排队死信 / P0-2 1MB 砍连接 / P0-3 legacy 永久降级 / P0-4 无新建会话
//    P1-1 忙时静默丢弃 / P1-2 confirm 兜底 / P1-4 attached 缺上下文
//    P1-5 reqId 被吞 / P1-6 无历史消息协议
//    P2-2 无背压 / P2-3 会话标题死时间戳 / P2-7 调度器未暴露
//
//  运行：node --test src/__tests__/attach-protocol-audit.test.js
// ============================================================
import { test } from 'node:test'
import assert from 'node:assert'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AttachHub } from '../core/attach-hub.js'
import { EventBus } from '../core/event-bus.js'
import { SessionManager } from '../core/session.js'

class FakeSocket extends EventEmitter {
  constructor() {
    super()
    this.out = []
    this.destroyed = false
    // 模拟 TCP 背压：write 返回 false（数据仍被内核接受并最终送达，
    // 只是超过 highWaterMark —— Node 的真实语义就是这样），后续应当暂停写。
    this.blocked = false
  }
  write(s) {
    this.out.push(JSON.parse(s))
    return this.blocked ? false : true
  }
  destroy() { this.destroyed = true }
  feed(obj) { this.emit('data', Buffer.from(JSON.stringify(obj) + '\n')) }
  take(type) { return this.out.filter(m => m.type === type) }
  last(type) { const a = this.take(type); return a[a.length - 1] }
}

const wait = (ms) => new Promise(r => setTimeout(r, ms))

function makeHub(opts = {}) {
  const bus = new EventBus()
  const engine = {
    state: { isRunning: false },
    abort: () => {},
    ...(opts.engine || {}),
  }
  const submitted = []
  const hub = new AttachHub({
    bus,
    engine,
    sessionManager: { currentSession: { id: 'sess-1', title: 'T' }, list: async () => [] },
    onSubmit: async (text, images, reqId) => {
      submitted.push({ text, images, reqId })
      if (opts.onSubmit) await opts.onSubmit(text, images, reqId)
    },
    onAbort: () => {},
    ...opts.hub,
  })
  return { hub, bus, engine, submitted }
}

// ------------------------------------------------------------
// P0-1：排队的消息必须被消化
// ------------------------------------------------------------

test('P0-1：turn/end 时内核仍"忙"，排队消息也不会永久卡死', async () => {
  // 精确复刻 query-engine 的时序：turn/end 广播 → 之后才置 isRunning=false
  let eng = null
  const ran = []
  const { hub, bus, engine } = makeHub({
    onSubmit: async (text) => {
      ran.push(text)
      eng.state.isRunning = true
      await wait(40)
      bus.emit('turn/end', { reqId: 'r-' + text, text: 'reply', turns: 1, aborted: false })
      eng.state.isRunning = false      // ← 关键：在 turn/end 之后
      bus.emit('status', { state: 'idle' })
    },
  })
  eng = engine

  const a = new FakeSocket(); hub.addClient(a)
  const b = new FakeSocket(); hub.addClient(b)
  a.feed({ type: 'attach', role: 'controller' })
  b.feed({ type: 'attach', role: 'controller' })

  a.feed({ type: 'input', text: 'A' })
  await wait(10)
  b.feed({ type: 'input', text: 'B' })     // 此时内核忙 → 入队
  await wait(300)

  assert.deepEqual(ran, ['A', 'B'], '排队消息必须被执行（不是躺在队列里）')
  assert.equal(hub.queue.length, 0, '队列应清空')
  hub.dispose()
})

test('P0-1：只有 turn/end、没有 status:idle 的宿主也能消化队列', async () => {
  let eng = null
  const ran = []
  const { hub, bus, engine } = makeHub({
    onSubmit: async (text) => {
      ran.push(text)
      eng.state.isRunning = true
      await wait(20)
      bus.emit('turn/end', { reqId: 'r', text: 'x', turns: 1 })   // 不发 status
      eng.state.isRunning = false
    },
  })
  eng = engine

  const s = new FakeSocket(); hub.addClient(s)
  s.feed({ type: 'attach', role: 'controller' })
  s.feed({ type: 'input', text: 'first' })
  await wait(10)
  s.feed({ type: 'input', text: 'second' })
  await wait(300)

  assert.deepEqual(ran, ['first', 'second'])
  hub.dispose()
})

test('P0-1：命令类输入（不产生回合）之后队列不会卡住', async () => {
  const ran = []
  const { hub } = makeHub({
    // 模拟 processInputLine 处理 /status：立即返回，不 emit 任何回合事件
    onSubmit: async (text) => { ran.push(text) },
  })
  const s = new FakeSocket(); hub.addClient(s)
  s.feed({ type: 'attach', role: 'controller' })

  s.feed({ type: 'input', text: '/status' })
  await wait(20)
  s.feed({ type: 'input', text: '普通消息' })
  await wait(60)

  assert.deepEqual(ran, ['/status', '普通消息'])
  hub.dispose()
})

test('P1-1：宿主在竞态下回 CC_NODE_BUSY → 消息放回队列，绝不静默丢弃', async () => {
  let busyReject = true
  const ran = []
  const { hub } = makeHub({
    onSubmit: async (text) => {
      if (busyReject) {
        busyReject = false
        const e = new Error('busy')
        e.code = 'CC_NODE_BUSY'
        throw e
      }
      ran.push(text)
    },
  })
  const s = new FakeSocket(); hub.addClient(s)
  s.feed({ type: 'attach', role: 'controller' })
  s.feed({ type: 'input', text: '撞上终端的回合' })

  await wait(500)   // 等 RETRY_MS 兜底重试
  assert.deepEqual(ran, ['撞上终端的回合'], '必须重试并最终执行')
  assert.equal(hub.queue.length, 0)
  hub.dispose()
})

// ------------------------------------------------------------
// P0-2：超长行只丢那一行，连接保留
// ------------------------------------------------------------

test('P0-2：单行超过上限 → 丢弃该行但保留连接（不再断连接）', () => {
  const { hub } = makeHub()
  const s = new FakeSocket(); hub.addClient(s)
  s.feed({ type: 'attach', role: 'viewer' })

  const huge = JSON.stringify({ type: 'ping', pad: 'x'.repeat(9 * 1024 * 1024) })
  s.emit('data', Buffer.from(huge + '\n'))

  assert.equal(hub.stats().clients, 1, '连接必须保留')
  assert.equal(s.destroyed, false)
  const err = s.last('error')
  assert.equal(err.code, 'LINE_TOO_LONG')
  assert.match(err.text, /连接保留/)

  // 连接还能正常工作
  s.feed({ type: 'ping' })
  assert.ok(s.last('pong'), '丢行之后连接仍然可用')
  hub.dispose()
})

test('P0-2：超长行以多个分块到达 → 丢弃模式，恢复后照常解析下一行', () => {
  const { hub } = makeHub()
  const s = new FakeSocket(); hub.addClient(s)
  s.feed({ type: 'attach', role: 'viewer' })

  // 先塞一块没有换行的巨量数据（触发丢弃模式）
  s.emit('data', Buffer.from('x'.repeat(9 * 1024 * 1024)))
  assert.equal(hub.stats().clients, 1, '无换行的超长数据也只丢数据，不断连接')

  // 那条超长行终于结束，后面跟一条正常消息
  s.emit('data', Buffer.from('tail-of-huge-line\n' + JSON.stringify({ type: 'ping' }) + '\n'))
  assert.ok(s.last('pong'), '恢复后应正常解析下一条消息')
  hub.dispose()
})

test('P0-2：正常大小的大消息（含 base64 图片）照常通过', async () => {
  const { hub, submitted } = makeHub()
  const s = new FakeSocket(); hub.addClient(s)
  s.feed({ type: 'attach', role: 'controller' })

  const img = 'data:image/jpeg;base64,' + 'A'.repeat(2 * 1024 * 1024)   // ~2MB 行
  s.feed({ type: 'input', text: '看图', images: [img] })
  await wait(20)

  assert.equal(submitted.length, 1, '2MB 的图片消息应当被接受（旧上限 1MB 会断连接）')
  assert.equal(submitted[0].images[0].length, img.length)
  hub.dispose()
})

// ------------------------------------------------------------
// P0-3：已 attach 的连接发 user_input 不得降级
// ------------------------------------------------------------

test('P0-3：已 attach 的连接发 user_input，事件流不丢（不再永久降级 legacy）', async () => {
  const { hub, bus, submitted } = makeHub()
  const s = new FakeSocket(); hub.addClient(s)
  s.feed({ type: 'attach', role: 'controller' })

  bus.emit('stream', { reqId: 'r1', kind: 'text', text: 'before' })
  await wait(30)
  assert.equal(s.take('stream').length, 1, 'attach 后应有事件流')

  s.feed({ type: 'user_input', text: '老格式的消息' })
  await wait(20)
  assert.equal(submitted.length, 1, 'user_input 应被当作 input 执行')

  bus.emit('stream', { reqId: 'r2', kind: 'text', text: 'after' })
  await wait(30)
  assert.equal(s.take('stream').length, 2, '发过 user_input 之后事件流必须还在')

  bus.emit('tool/call', { reqId: 'r2', name: 'Bash', input: 'ls' })
  await wait(10)
  assert.equal(s.take('tool/call').length, 1, '工具事件也要继续送达')

  bus.emit('turn/end', { reqId: 'r2', text: 'done', turns: 1 })
  await wait(10)
  assert.equal(s.take('turn/end').length, 1, '应收到结构化 turn/end，而不是被换成 reply')
  hub.dispose()
})

test('P0-3：未 attach 的老客户端仍然只收 reply（兼容承诺不被破坏）', async () => {
  const { hub, bus } = makeHub()
  const s = new FakeSocket(); hub.addClient(s)

  s.feed({ type: 'user_input', text: '老客户端' })
  bus.emit('stream', { reqId: 'r1', kind: 'text', text: 'x' })
  bus.emit('turn/end', { reqId: 'r1', text: '完整回答', turns: 1 })
  await wait(20)

  assert.equal(s.take('stream').length, 0, 'legacy 客户端不应收到 stream')
  assert.equal(s.last('reply').text, '完整回答')
  hub.dispose()
})

// ------------------------------------------------------------
// P0-4 / P1-6：会话协议
// ------------------------------------------------------------

test('P0-4：session_new 走宿主回调并广播 session/loaded', async () => {
  let calledWith = null
  const { hub, bus } = makeHub({
    hub: {
      onNewSession: async (title) => {
        calledWith = title
        return { ok: true, id: 'session-new', title: title || 'Session 新', cwd: '/x' }
      },
    },
  })
  const s = new FakeSocket(); hub.addClient(s)
  s.feed({ type: 'attach', role: 'controller' })

  const seen = []
  bus.subscribe((ev) => { if (ev.type === 'session/loaded') seen.push(ev) }, { name: 'probe' })

  s.feed({ type: 'session_new', title: '修 bug' })
  await wait(30)

  assert.equal(calledWith, '修 bug')
  assert.equal(seen.length, 1, 'session/loaded 必须广播（终端与其他视图都要知道）')
  assert.equal(seen[0].id, 'session-new')
  assert.equal(seen[0].reason, 'new')
  assert.equal(s.last('session/loaded').id, 'session-new')
  hub.dispose()
})

test('P0-4：session_new 在回合进行中被拒绝（不能把上下文换掉后继续跑）', async () => {
  const { hub } = makeHub({
    hub: { onNewSession: async () => ({ ok: true, id: 'x' }) },
    engine: { state: { isRunning: true } },
  })
  const s = new FakeSocket(); hub.addClient(s)
  s.feed({ type: 'attach', role: 'controller' })
  s.feed({ type: 'session_new' })
  await wait(20)

  assert.match(s.last('error').text, /先 abort/)
  hub.dispose()
})

test('P0-4：session_new 对 viewer 拒绝', async () => {
  const { hub } = makeHub({ hub: { onNewSession: async () => ({ ok: true, id: 'x' }) } })
  const s = new FakeSocket(); hub.addClient(s)
  s.feed({ type: 'attach', role: 'viewer' })
  s.feed({ type: 'session_new' })
  await wait(20)

  assert.match(s.last('error').text, /只读视图/)
  hub.dispose()
})

test('P1-6：session_messages 由宿主读文件返回完整消息（viewer 也能用）', async () => {
  const { hub } = makeHub({
    hub: {
      onSessionMessages: async ({ sessionId, limit }) => ({
        sessionId,
        title: 'T',
        messages: [
          { role: 'user', content: '你好', timestamp: '2026-10-24T08:00:00Z' },
          { role: 'assistant', content: '在', timestamp: '2026-10-24T08:00:01Z' },
        ].slice(-limit),
        total: 2,
        truncated: false,
      }),
    },
  })
  const s = new FakeSocket(); hub.addClient(s)
  s.feed({ type: 'attach', role: 'viewer' })
  s.feed({ type: 'session_messages', limit: 10 })
  await wait(30)

  const r = s.last('session/messages')
  assert.equal(r.total, 2)
  assert.equal(r.messages[0].content, '你好')
  hub.dispose()
})

// ------------------------------------------------------------
// P1-2：confirmable
// ------------------------------------------------------------

test('P1-2：声明 confirmable:false 的桥不算"可应答"，不再让确认空等', () => {
  const { hub } = makeHub()
  const s = new FakeSocket(); hub.addClient(s)
  s.feed({ type: 'attach', role: 'controller', confirmable: false })

  assert.equal(hub.hasController(), true, '它仍是 controller（可以发消息）')
  assert.equal(hub.hasConfirmController(), false, '但不应接收确认请求')
  hub.dispose()
})

test('P1-2：默认 confirmable=true，正常客户端仍接收确认', () => {
  const { hub } = makeHub()
  const s = new FakeSocket(); hub.addClient(s)
  s.feed({ type: 'attach', role: 'controller' })
  assert.equal(hub.hasConfirmController(), true)
  hub.dispose()
})

// ------------------------------------------------------------
// P1-4 / P1-5：握手上下文与 reqId 透传
// ------------------------------------------------------------

test('P1-4：attached 带 cwd/model/permissionMode/sessionTitle 与协议常量', () => {
  const { hub } = makeHub({
    hub: {
      getContext: () => ({
        sessionId: 'sess-9', sessionTitle: '修 socket 协议',
        cwd: '/work/proj', model: 'deepseek-chat', permissionMode: 'ask',
      }),
    },
  })
  const s = new FakeSocket(); hub.addClient(s)
  s.feed({ type: 'attach', role: 'controller' })

  const a = s.last('attached')
  assert.equal(a.cwd, '/work/proj')
  assert.equal(a.model, 'deepseek-chat')
  assert.equal(a.permissionMode, 'ask')
  assert.equal(a.sessionTitle, '修 socket 协议')
  assert.equal(a.confirmable, true)
  assert.ok(a.maxLine >= 8 * 1024 * 1024, '客户端应能读到单行上限以做图片体积护栏')
  assert.ok(a.replaySize > 0, '客户端应能读到补齐窗口大小')
  hub.dispose()
})

test('P1-5：客户端的 reqId 一路透传到 onSubmit，并回在 queued 里', async () => {
  const { hub, engine, submitted } = makeHub()
  engine.state.isRunning = true          // 让它走排队路径
  const s = new FakeSocket(); hub.addClient(s)
  s.feed({ type: 'attach', role: 'controller' })

  s.feed({ type: 'input', reqId: 'client-msg-42', text: '你好' })
  const q = s.last('queued')
  assert.equal(q.clientReqId, 'client-msg-42', 'queued 必须回带 clientReqId')

  engine.state.isRunning = false
  hub.bus.emit('status', { state: 'idle' })
  await wait(50)

  assert.equal(submitted[0].reqId, 'client-msg-42', 'reqId 必须透传给引擎')
  hub.dispose()
})

// ------------------------------------------------------------
// P2-2：背压
// ------------------------------------------------------------

test('P2-2：socket.write 返回 false 时进入背压，drain 后按序补发且不丢事件', async () => {
  const { hub, bus } = makeHub()
  const s = new FakeSocket(); hub.addClient(s)
  s.feed({ type: 'attach', role: 'viewer' })

  s.blocked = true
  for (let i = 0; i < 5; i++) bus.emit('notice', { text: `n${i}` })
  // 第一条写出时才发现对端不读（write 返回 false）→ 之后的行必须停下来等 drain
  assert.equal(s.take('notice').length, 1, '背压开始后不应继续硬写')

  s.blocked = false
  s.emit('drain')
  const got = s.take('notice').map(x => x.text)
  assert.deepEqual(got, ['n0', 'n1', 'n2', 'n3', 'n4'], 'drain 后按序补发，一条不丢')
  hub.dispose()
})

test('P2-2：对端长期不读导致积压超限 → 摘掉该视图，内核不受影响', async () => {
  const { hub, bus } = makeHub()
  const bad = new FakeSocket(); const good = new FakeSocket()
  hub.addClient(bad); hub.addClient(good)
  bad.feed({ type: 'attach', role: 'viewer' })
  good.feed({ type: 'attach', role: 'viewer' })

  bad.blocked = true
  const big = 'x'.repeat(512 * 1024)
  for (let i = 0; i < 40; i++) {
    assert.doesNotThrow(() => bus.emit('tool/result', { reqId: 'r', name: 'X', ok: true, summary: big }))
  }

  assert.equal(hub.stats().clients, 1, '积压超限的死视图应被摘掉')
  assert.ok(good.take('tool/result').length > 0, '健康视图继续收到事件')
  hub.dispose()
})

// ------------------------------------------------------------
// P2-7：调度器对外可见
// ------------------------------------------------------------

test('P2-7：scheduler_list 返回任务列表；无调度器时明确 available:false', async () => {
  const { hub } = makeHub({
    hub: {
      getSchedules: () => ([
        { id: 'j1', kind: 'daily', status: 'pending', dueDesc: '每天 08:00', channel: 'telegram', text: '查行情' },
      ]),
    },
  })
  const s = new FakeSocket(); hub.addClient(s)
  s.feed({ type: 'attach', role: 'viewer' })
  s.feed({ type: 'scheduler_list' })
  await wait(20)

  const r = s.last('scheduler/list')
  assert.equal(r.available, true)
  assert.equal(r.tasks.length, 1)
  assert.equal(r.tasks[0].id, 'j1')
  hub.dispose()

  // 没有调度器
  const { hub: hub2 } = makeHub({ hub: { getSchedules: () => null } })
  const s2 = new FakeSocket(); hub2.addClient(s2)
  s2.feed({ type: 'attach', role: 'viewer' })
  s2.feed({ type: 'scheduler_list' })
  await wait(20)
  assert.equal(s2.last('scheduler/list').available, false, '不能假装"有，只是空的"')
  hub2.dispose()
})

test('P2-7：定时任务触发/结束会广播给所有视图（带 seq）', async () => {
  const { hub } = makeHub()
  const s = new FakeSocket(); hub.addClient(s)
  s.feed({ type: 'attach', role: 'viewer' })

  hub.notifyScheduleEvent('schedule/triggered', { id: 'j1', kind: 'once', action: { cmd: 'python x.py' } }, { status: 'running' })
  hub.notifyScheduleEvent('schedule/finished', { id: 'j1', kind: 'once', action: {} }, { status: 'done' })
  await wait(20)

  const fired = s.take('schedule/triggered')
  const done = s.take('schedule/finished')
  assert.equal(fired.length, 1)
  assert.equal(fired[0].taskId, 'j1')
  assert.equal(fired[0].cmd, 'python x.py')
  assert.ok(fired[0].seq > 0, '广播事件必须带 seq，才能进断线补齐窗口')
  assert.equal(done.length, 1)
  assert.equal(done[0].status, 'done')
  hub.dispose()
})

// ------------------------------------------------------------
// P2-3：会话标题
// ------------------------------------------------------------

test('P2-3：新建会话用时间戳占位，首条用户消息后变成可读标题', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-node-sess-'))
  const sm = new SessionManager({ sessionsDir: dir })
  const s = await sm.create()
  assert.match(s.title, /^Session \d{4}-/, '初始仍是时间戳占位')

  await sm.appendMessage({ role: 'user', content: '帮我修一下 socket 协议的排队 bug' })
  assert.match(s.title, /socket 协议的排队/, '首条用户消息应成为标题')

  const onDisk = JSON.parse(await readFile(join(dir, `${s.id}.json`), 'utf-8'))
  assert.match(onDisk.title, /socket 协议的排队/, '标题要落盘，列表（含手机端）才看得到')
})

test('P2-3：显式命名的会话标题永不被覆盖', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-node-sess-'))
  const sm = new SessionManager({ sessionsDir: dir })
  const s = await sm.create('我自己起的名字')
  await sm.appendMessage({ role: 'user', content: '这是一段完全不同的内容，不该改标题' })
  assert.equal(s.title, '我自己起的名字')
})

test('P2-3：过短的输入不当标题（等下一句更有信息量的）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-node-sess-'))
  const sm = new SessionManager({ sessionsDir: dir })
  const s = await sm.create()
  await sm.appendMessage({ role: 'user', content: 'hi' })
  assert.match(s.title, /^Session \d{4}-/, '"hi" 这样的输入没有区分度，继续等')
  await sm.appendMessage({ role: 'user', content: '现在说正事：重构 attach 协议' })
  assert.match(s.title, /重构 attach 协议/)
})

// ------------------------------------------------------------
// 会话切换必须清空回合正文归档
// ------------------------------------------------------------

test('切换会话：clearTurnHistory 清空正文归档（否则新会话会拉到旧正文）', () => {
  const bus = new EventBus()
  bus.emit('turn/start', { reqId: 'r1' })
  bus.emit('turn/end', { reqId: 'r1', text: '旧会话的回答', turns: 1 })
  assert.equal(bus.recentTurns(5).length, 1)

  bus.clearTurnHistory()
  assert.equal(bus.recentTurns(5).length, 0, '切会话后不该再拿到上一个会话的正文')
  bus.emit('turn/start', { reqId: 'r2' })
  bus.emit('turn/end', { reqId: 'r2', text: '新会话', turns: 1 })
  assert.deepEqual(bus.recentTurns(5).map(t => t.text), ['新会话'])
})
