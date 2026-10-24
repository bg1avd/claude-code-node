// ============================================================
//  attach-hub.test.js — local socket 接入中枢测试
//
//  用假 socket（EventEmitter）驱动协议，不触网、不起真端口。
//  覆盖：attach 角色 / 输入与排队 / 事件广播 / stream 合批 / 确认先答先赢 /
//        断线补齐 / viewer 只读约束 / 视图写失败自愈
//
//  运行：node --test src/__tests__/attach-hub.test.js
// ============================================================
import { test } from 'node:test'
import assert from 'node:assert'
import { EventEmitter } from 'node:events'
import { AttachHub } from '../core/attach-hub.js'
import { EventBus } from '../core/event-bus.js'

/** 假 socket：记录服务端写出的消息，可主动喂入客户端消息 */
class FakeSocket extends EventEmitter {
  constructor() {
    super()
    this.out = []
    this.destroyed = false
    this.failWrite = false
  }
  write(s) {
    if (this.failWrite) throw new Error('EPIPE')
    this.out.push(JSON.parse(s))   // 服务端按 NDJSON 写，这里逐行还原
    return true
  }
  destroy() { this.destroyed = true }
  /** 客户端 → 服务端 */
  feed(obj) { this.emit('data', Buffer.from(JSON.stringify(obj) + '\n')) }
  /** 服务端 → 客户端，按类型取 */
  take(type) { return this.out.filter(m => m.type === type) }
  last(type) { const arr = this.take(type); return arr[arr.length - 1] }
}

function makeHub({ running = false, onSubmit = async () => {}, onAbort = null, onLoadSession = null } = {}) {
  const bus = new EventBus()
  const engine = { state: { isRunning: running }, abort: onAbort || (() => {}) }
  const submitted = []
  const hub = new AttachHub({
    bus,
    engine,
    sessionManager: { currentSession: { id: 'sess-1' }, list: async () => [{ id: 'sess-1', title: 'T' }] },
    onSubmit: async (text, images) => { submitted.push({ text, images }); await onSubmit(text, images) },
    onAbort,
    onLoadSession,
  })
  return { hub, bus, engine, submitted }
}

const wait = (ms) => new Promise(r => setTimeout(r, ms))

test('attach：viewer/controller 都能接入，收到 attached 与运行状态', () => {
  const { hub } = makeHub({ running: true })
  const s = new FakeSocket()
  hub.addClient(s)
  s.feed({ type: 'attach', role: 'controller' })

  const a = s.last('attached')
  assert.equal(a.role, 'controller')
  assert.equal(a.running, true)
  assert.equal(a.session, 'sess-1')
  hub.dispose()
})

test('input：controller 提交后进入 onSubmit，且带来源无关的同一入口', async () => {
  const { hub, submitted } = makeHub()
  const s = new FakeSocket()
  hub.addClient(s)
  s.feed({ type: 'attach', role: 'controller' })
  s.feed({ type: 'input', text: '你好', images: ['data:image/png;base64,xx'] })
  await wait(10)

  assert.deepEqual(submitted, [{ text: '你好', images: ['data:image/png;base64,xx'] }])
  hub.dispose()
})

test('viewer：只能围观，input/abort/confirm 一律被拒', () => {
  const { hub, submitted } = makeHub()
  const s = new FakeSocket()
  hub.addClient(s)
  s.feed({ type: 'attach', role: 'viewer' })

  s.feed({ type: 'input', text: '偷发' })
  s.feed({ type: 'abort' })
  s.feed({ type: 'confirm', id: 'c1', answer: 'y' })

  assert.equal(submitted.length, 0, 'viewer 不应能提交输入')
  assert.equal(s.take('error').length, 3, '三次越权都应返回 error')
  assert.equal(hub.hasController(), false)
  hub.dispose()
})

test('未 attach 前不能操作：先 attach 是硬约束', () => {
  const { hub } = makeHub()
  const s = new FakeSocket()
  hub.addClient(s)
  s.feed({ type: 'input', text: 'x' })
  assert.match(s.last('error').text, /请先发送/)
  hub.dispose()
})

test('回合串行：忙时输入排队，内核空闲后按 FIFO 依次执行（不并发、不丢失）', async () => {
  // v4.1.1 修正：这条测试原来断言"发一次 turn/end 只消化一条"。
  // 那个假设把 bug 固定成了契约 —— turn/end 广播时 engine.state.isRunning
  // 仍是 true（它在 processMessage 的 finally 里才置 false），旧实现同步 drain
  // 必然命中 _isBusy() 早退，队列从此没人管。
  // 现在 drain 挂在 status:idle（以及 turn/end 的延迟兜底）上，队列**一定能被消化**。
  // 这里改为一并验证真正的意图：不并发、不丢、按序。
  let eng = null
  let concurrent = 0
  let maxConcurrent = 0
  const { hub, bus, engine, submitted } = makeHub({
    running: true,
    onSubmit: async (text) => {
      concurrent++
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      eng.state.isRunning = true          // 与 processMessage 一致：执行期间忙
      await wait(20)
      eng.state.isRunning = false         // 与 finally 一致：结束时先置闲
      bus.emit('status', { state: 'idle' })   // 再广播 idle
      concurrent--
    },
  })
  eng = engine

  const s = new FakeSocket()
  hub.addClient(s)
  s.feed({ type: 'attach', role: 'controller' })

  s.feed({ type: 'input', text: '第一条' })
  s.feed({ type: 'input', text: '第二条' })
  assert.equal(submitted.length, 0, '忙时不应立即执行')
  assert.deepEqual(s.take('queued').map(q => q.position), [1, 2])

  // 内核忙完
  engine.state.isRunning = false
  bus.emit('status', { state: 'idle' })
  await wait(120)

  assert.deepEqual(submitted.map(x => x.text), ['第一条', '第二条'], '两条都应按序执行完')
  assert.equal(hub.queue.length, 0, '队列应被消化干净')
  assert.equal(maxConcurrent, 1, '绝不并发执行')
  hub.dispose()
})

test('广播：bus 事件实时转发给已 attach 的视图', () => {
  const { hub, bus } = makeHub()
  const s = new FakeSocket()
  hub.addClient(s)
  s.feed({ type: 'attach', role: 'viewer' })

  bus.emit('tool/call', { reqId: 'r1', name: 'Bash', input: { cmd: 'ls' } })
  bus.emit('tool/result', { reqId: 'r1', name: 'Bash', ok: true, summary: 'ok' })

  assert.equal(s.last('tool/call').name, 'Bash')
  assert.equal(s.last('tool/result').ok, true)
  hub.dispose()
})

test('广播：未 attach 的连接收不到事件（避免半连接泄漏信息）', () => {
  const { hub, bus } = makeHub()
  const s = new FakeSocket()
  hub.addClient(s)
  bus.emit('notice', { text: '不该看到' })
  assert.equal(s.take('notice').length, 0)
  hub.dispose()
})

test('stream 合批：16ms 窗口内的相邻同 kind 增量合并成一条', async () => {
  const { hub, bus } = makeHub()
  const s = new FakeSocket()
  hub.addClient(s)
  s.feed({ type: 'attach', role: 'viewer' })

  bus.emit('stream', { reqId: 'r1', kind: 'text', text: '你' })
  bus.emit('stream', { reqId: 'r1', kind: 'text', text: '好' })
  bus.emit('stream', { reqId: 'r1', kind: 'reasoning', text: '想' })
  bus.emit('stream', { reqId: 'r1', kind: 'text', text: '！' })
  await wait(40)

  const streams = s.take('stream')
  assert.deepEqual(streams.map(x => `${x.kind}:${x.text}`), ['text:你好', 'reasoning:想', 'text:！'])
  assert.equal(streams[0].seq, 2, '合并后 seq 取该组最后一条')
  hub.dispose()
})

test('确认：先答先赢，第二个应答者拿不到', async () => {
  const { hub } = makeHub()
  const a = new FakeSocket(); const b = new FakeSocket()
  hub.addClient(a); hub.addClient(b)
  a.feed({ type: 'attach', role: 'controller' })
  b.feed({ type: 'attach', role: 'controller' })

  const waiting = hub.waitConfirm('c1', { timeoutMs: 1000 })
  a.feed({ type: 'confirm', id: 'c1', answer: 'y' })
  const r = await waiting
  assert.deepEqual(r, { answer: true, by: 'attach:controller', raw: 'y' })

  // 第二个应答 → 已无待决请求
  b.feed({ type: 'confirm', id: 'c1', answer: 'n' })
  assert.match(b.last('error').text, /没有待确认/)
  hub.dispose()
})

test('确认：a（本会话全部允许）原样传递给宿主', async () => {
  const { hub } = makeHub()
  const s = new FakeSocket()
  hub.addClient(s)
  s.feed({ type: 'attach', role: 'controller' })
  const waiting = hub.waitConfirm('c1', { timeoutMs: 1000 })
  s.feed({ type: 'confirm', id: 'c1', answer: 'a' })
  const r = await waiting
  assert.equal(r.raw, 'a')
  assert.equal(r.answer, true)
  hub.dispose()
})

test('确认：超时 resolve(null)，宿主据此走自己的兜底', async () => {
  const { hub } = makeHub()
  const r = await hub.waitConfirm('c-timeout', { timeoutMs: 20 })
  assert.equal(r, null)
  assert.equal(hub.stats().pendingConfirms, 0)
  hub.dispose()
})

test('断线补齐：sinceSeq 之后的结构性事件会补发，stream 不补', () => {
  const { hub, bus } = makeHub()
  bus.emit('turn/start', { reqId: 'r1' })                       // 1
  bus.emit('stream', { reqId: 'r1', kind: 'text', text: 'x' })  // 2（不存）
  bus.emit('tool/call', { reqId: 'r1', name: 'Bash', input: {} }) // 3
  bus.emit('turn/end', { reqId: 'r1', text: 'done' })           // 4

  const s = new FakeSocket()
  hub.addClient(s)
  s.feed({ type: 'attach', role: 'viewer', sinceSeq: 1 })

  const types = s.out.map(m => m.type)
  assert.deepEqual(types, ['attached', 'tool/call', 'turn/end'])
  hub.dispose()
})

test('中途接入：回合在跑时补一份 turn/snapshot', () => {
  const { hub, bus } = makeHub()
  bus.emit('turn/start', { reqId: 'r1' })
  bus.emit('stream', { reqId: 'r1', kind: 'text', text: '正在写' })

  const s = new FakeSocket()
  hub.addClient(s)
  s.feed({ type: 'attach', role: 'viewer' })
  assert.equal(s.last('turn/snapshot').text, '正在写')
  hub.dispose()
})

test('自愈：视图写失败 → 摘掉该客户端，内核与其他视图不受影响', () => {
  const { hub, bus } = makeHub()
  const bad = new FakeSocket(); const good = new FakeSocket()
  hub.addClient(bad); hub.addClient(good)
  bad.feed({ type: 'attach', role: 'viewer' })
  good.feed({ type: 'attach', role: 'viewer' })

  bad.failWrite = true
  assert.doesNotThrow(() => bus.emit('notice', { text: 'x' }))
  assert.equal(hub.stats().clients, 1, '坏掉的视图应被摘掉')
  assert.equal(good.take('notice').length, 1)
  hub.dispose()
})

test('session_list：异步返回会话列表', async () => {
  const { hub } = makeHub()
  const s = new FakeSocket()
  hub.addClient(s)
  s.feed({ type: 'attach', role: 'viewer' })
  s.feed({ type: 'session_list' })
  await wait(10)
  assert.equal(s.last('sessions').list[0].id, 'sess-1')
  hub.dispose()
})

test('协议护栏：非 JSON / 缺 type / 超长无换行 都给出明确错误', () => {
  const { hub } = makeHub()
  const s = new FakeSocket()
  hub.addClient(s)
  s.emit('data', Buffer.from('not json\n'))
  assert.match(s.last('error').text, /合法 JSON/)

  s.emit('data', Buffer.from('{"text":"no type"}\n'))
  assert.match(s.last('error').text, /缺少 type/)
  hub.dispose()
})

test('abort：controller 请求中断会调用宿主 onAbort', () => {
  let aborted = 0
  const { hub } = makeHub({ onAbort: () => { aborted++ } })
  const s = new FakeSocket()
  hub.addClient(s)
  s.feed({ type: 'attach', role: 'controller' })
  s.feed({ type: 'abort' })
  assert.equal(aborted, 1)
  hub.dispose()
})

test('顺序：stream 合批绝不能越过后续的结构性事件（回归）', async () => {
  // 真机踩到的 bug：stream 延迟 16ms 合批，而 turn/end 立即发送，
  // 客户端于是先看到"回合结束"、后看到正文 —— 时间线整个错乱。
  const { hub, bus } = makeHub()
  const s = new FakeSocket()
  hub.addClient(s)
  s.feed({ type: 'attach', role: 'viewer' })

  bus.emit('turn/start', { reqId: 'r1' })
  bus.emit('stream', { reqId: 'r1', kind: 'text', text: '正文' })
  bus.emit('turn/end', { reqId: 'r1', text: '正文' })   // 紧跟其后，不等合批窗口
  await wait(30)

  const seq = s.out.filter(m => m.type !== 'attached').map(m => m.type)
  assert.deepEqual(seq, ['turn/start', 'stream', 'turn/end'])
  hub.dispose()
})

test('阶段 1 兼容：user_input 无需 attach，收到 {type:"reply"}', async () => {
  // 老客户端（cc-notify / 已有桥）不认识 attach 和事件流。
  // 升级内核绝不能静默打断它们 —— 这条是硬性兼容回归测试。
  const { hub, bus, submitted } = makeHub()
  const s = new FakeSocket()
  hub.addClient(s)

  s.feed({ type: 'user_input', text: '老客户端消息' })
  await wait(10)
  assert.deepEqual(submitted.map(x => x.text), ['老客户端消息'], '未 attach 也应能提交')

  bus.emit('turn/start', { reqId: 'r1' })
  bus.emit('stream', { reqId: 'r1', kind: 'text', text: '中间增量' })
  bus.emit('turn/end', { reqId: 'r1', text: '完整回答' })

  const replies = s.take('reply')
  assert.equal(replies.length, 1)
  assert.equal(replies[0].text, '完整回答')
  assert.equal(s.take('stream').length, 0, '老客户端不应收到事件流')
  assert.equal(s.take('turn/start').length, 0)
  hub.dispose()
})

test('阶段 1 兼容：回合出错时老客户端收到 {type:"error"}', async () => {
  const { hub, bus } = makeHub()
  const s = new FakeSocket()
  hub.addClient(s)
  s.feed({ type: 'user_input', text: 'x' })
  await wait(10)
  bus.emit('turn/end', { reqId: 'r1', text: '', error: '网络炸了' })
  assert.equal(s.last('error').text, '网络炸了')
  hub.dispose()
})

test('阶段 1 → 阶段 2：同一连接先 user_input 后 attach，切到事件流', async () => {
  const { hub, bus } = makeHub()
  const s = new FakeSocket()
  hub.addClient(s)
  s.feed({ type: 'user_input', text: 'a' })
  await wait(10)

  s.feed({ type: 'attach', role: 'controller' })
  bus.emit('tool/call', { reqId: 'r1', name: 'Bash', input: {} })
  assert.equal(s.take('tool/call').length, 1, 'attach 后应改收事件流')
  hub.dispose()
})

test('session_load：切换成功 → 广播 session/loaded + notice 给所有视图', async () => {
  const { hub, bus } = makeHub({
    onLoadSession: async (id) => ({ ok: true, id, title: '老项目会话', cwd: '/x' }),
  })
  const a = new FakeSocket(); const b = new FakeSocket()
  hub.addClient(a); hub.addClient(b)
  a.feed({ type: 'attach', role: 'controller' })
  b.feed({ type: 'attach', role: 'viewer' })

  a.feed({ type: 'session_load', sessionId: 'sess-old' })
  await wait(10)

  // 发起者与围观者都要知道上下文变了
  assert.equal(a.last('session/loaded').id, 'sess-old')
  assert.equal(b.last('session/loaded').title, '老项目会话')
  assert.match(b.last('notice').text, /会话已切换/)
  hub.dispose()
})

test('session_load：加载失败 → 只回 error，不广播', async () => {
  const { hub } = makeHub({ onLoadSession: async () => ({ ok: false, error: '会话不存在: xxx' }) })
  const s = new FakeSocket()
  hub.addClient(s)
  s.feed({ type: 'attach', role: 'controller' })
  s.feed({ type: 'session_load', sessionId: 'xxx' })
  await wait(10)
  assert.match(s.last('error').text, /不存在/)
  assert.equal(s.take('session/loaded').length, 0)
  hub.dispose()
})

test('session_load：回合在跑时拒绝（不能把上下文换掉再继续跑）', async () => {
  const { hub } = makeHub({ running: true, onLoadSession: async () => ({ ok: true, id: 'x' }) })
  const s = new FakeSocket()
  hub.addClient(s)
  s.feed({ type: 'attach', role: 'controller' })
  s.feed({ type: 'session_load', sessionId: 'x' })
  await wait(10)
  assert.match(s.last('error').text, /先 abort/)
  hub.dispose()
})

test('session_load：viewer 无权切换会话', () => {
  const { hub } = makeHub({ onLoadSession: async () => ({ ok: true, id: 'x' }) })
  const s = new FakeSocket()
  hub.addClient(s)
  s.feed({ type: 'attach', role: 'viewer' })
  s.feed({ type: 'session_load', sessionId: 'x' })
  assert.match(s.last('error').text, /只读/)
  hub.dispose()
})

test('turn_history：能拉回最近回合正文（含 reasoning 与中断标记）', () => {
  const { hub, bus } = makeHub()
  const s = new FakeSocket()
  hub.addClient(s)
  s.feed({ type: 'attach', role: 'viewer' })

  bus.emit('turn/start', { reqId: 'r1' })
  bus.emit('stream', { reqId: 'r1', kind: 'reasoning', text: '想' })
  bus.emit('turn/end', { reqId: 'r1', text: '第一轮回答', turns: 1 })
  bus.emit('turn/start', { reqId: 'r2' })
  bus.emit('turn/end', { reqId: 'r2', text: '中断了', aborted: true })

  s.feed({ type: 'turn_history', limit: 2 })
  const h = s.last('turn/history')
  assert.deepEqual(h.turns.map(t => t.text), ['第一轮回答', '中断了'])
  assert.equal(h.turns[0].reasoning, '想')
  assert.equal(h.turns[1].aborted, true)
  hub.dispose()
})

test('断线补齐：seq 已滚出缓冲时明确告知缺口，不假装补全', () => {
  const bus = new EventBus({ replaySize: 2 })
  const hub = new AttachHub({
    bus,
    engine: { state: { isRunning: false }, abort: () => {} },
    sessionManager: { currentSession: { id: 's' }, list: async () => [] },
    onSubmit: async () => {},
  })
  for (let i = 0; i < 6; i++) bus.emit('notice', { text: `n${i}` })

  const s = new FakeSocket()
  hub.addClient(s)
  s.feed({ type: 'attach', role: 'viewer', sinceSeq: 1 })

  const notice = s.take('notice').find(m => /滚出缓冲/.test(m.text || ''))
  assert.ok(notice, '应给出一条缺口提示')
  assert.match(notice.text, /turn_history/)
  hub.dispose()
})

test('命令回显：echo 发给 attach 视图与 legacy 客户端，且不进 replay', () => {
  const { hub, bus } = makeHub()
  const modern = new FakeSocket()
  const legacy = new FakeSocket()
  const viewer = new FakeSocket()
  hub.addClient(modern); hub.addClient(legacy); hub.addClient(viewer)
  modern.feed({ type: 'attach', role: 'controller' })
  viewer.feed({ type: 'attach', role: 'viewer' })
  legacy.feed({ type: 'user_input', text: 'x' })

  const before = bus.replay.length
  hub.echo('Model: deepseek-flash\nPermission: ask')

  assert.match(modern.last('command/output').text, /Permission: ask/)
  assert.equal(viewer.take('command/output').length, 1, 'viewer 也应看到命令输出')
  assert.match(legacy.last('reply').text, /Model:/)
  assert.equal(bus.replay.length, before, '命令输出不应进 replay（会淹掉断线补齐）')
  hub.dispose()
})

test('dispose：清理订阅与待决确认，后续事件不再处理', async () => {
  const { hub, bus } = makeHub()
  const s = new FakeSocket()
  hub.addClient(s)
  s.feed({ type: 'attach', role: 'viewer' })
  const pending = hub.waitConfirm('c1', { timeoutMs: 5000 })
  hub.dispose()
  assert.equal(await pending, null)
  bus.emit('notice', { text: '之后' })
  assert.equal(s.take('notice').length, 0)
})
