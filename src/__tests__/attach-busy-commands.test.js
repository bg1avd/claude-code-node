// ============================================================
//  attach-busy-commands.test.js
//
//  来自接入方（cc-node-mobile）v4.1.1 接入反馈的回归测试。
//  每条对应反馈里的一个编号：
//    P1    命令在忙时被排队（与 Telegram 不一致）
//    P2-1  缺「命令清单」协议
//    P2-2  command/output 缺 reqId / done
//    P2-3  session_messages 分页游标按 timestamp 精确匹配会撞车
//
//  运行：node --test src/__tests__/attach-busy-commands.test.js
// ============================================================
import { test } from 'node:test'
import assert from 'node:assert'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { AttachHub } from '../core/attach-hub.js'
import { EventBus } from '../core/event-bus.js'
import { COMMAND_SPEC, buildCommandList, BUSY_SAFE_COMMANDS } from '../core/commands.js'
import { sliceMessagesForPage } from '../core/message-paging.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

class FakeSocket extends EventEmitter {
  constructor() { super(); this.out = []; this.destroyed = false }
  write(s) { this.out.push(JSON.parse(s)); return true }
  destroy() { this.destroyed = true }
  feed(obj) { this.emit('data', Buffer.from(JSON.stringify(obj) + '\n')) }
  take(type) { return this.out.filter(m => m.type === type) }
  last(type) { const a = this.take(type); return a[a.length - 1] }
}
const wait = ms => new Promise(r => setTimeout(r, ms))

function makeHub(opts = {}) {
  const bus = new EventBus()
  const engine = { state: { isRunning: !!opts.busy }, abort: () => {} }
  const submitted = []
  const hub = new AttachHub({
    bus,
    engine,
    sessionManager: { currentSession: { id: 'sess-1', title: 'T' } },
    onSubmit: async (text, images, reqId) => {
      submitted.push({ text, images, reqId })
      if (opts.onSubmit) await opts.onSubmit(text, images, reqId)
    },
    onAbort: () => {},
    ...(opts.hub || {}),
  })
  return { hub, bus, engine, submitted }
}

async function attach(hub, role = 'controller') {
  const s = new FakeSocket()
  hub.addClient(s)
  s.feed({ type: 'attach', role })
  await wait(20)
  return s
}

// ------------------------------------------------------------
// P1：命令不参与回合排队
// ------------------------------------------------------------

test('P1：内核忙时发 /status 不被排队，立即交给宿主', async (t) => {
  const { hub, submitted } = makeHub({ busy: true })
  t.after(() => hub.dispose())
  const s = await attach(hub)
  s.feed({ type: 'input', reqId: 'm-1', text: '/status' })
  await wait(30)

  assert.equal(s.take('queued').length, 0, '命令不该收到 queued')
  assert.equal(submitted.length, 1, '命令应立即提交给宿主')
  assert.equal(submitted[0].text, '/status')
  assert.equal(submitted[0].reqId, 'm-1')
})

test('P1：内核忙时普通对话仍然排队（命令的特权不外溢）', async (t) => {
  const { hub, submitted } = makeHub({ busy: true })
  t.after(() => hub.dispose())
  const s = await attach(hub)
  s.feed({ type: 'input', reqId: 'm-2', text: '你好' })
  await wait(30)

  assert.equal(s.take('queued').length, 1, '普通消息应排队')
  assert.equal(s.last('queued').clientReqId, 'm-2')
  assert.equal(submitted.length, 0, '忙时不该立即提交')
})

test('P1：命令不占队列位——后面的对话输入仍排在第 1 位', async (t) => {
  const { hub } = makeHub({ busy: true })
  t.after(() => hub.dispose())
  const s = await attach(hub)
  s.feed({ type: 'input', text: '/status' })
  s.feed({ type: 'input', reqId: 'm-3', text: '你好' })
  await wait(40)

  assert.equal(s.last('queued').position, 1, '命令不应让队列位置 +1')
  assert.equal(hub.queue.length, 1)
})

test('P1：命令被宿主以 CC_NODE_BUSY 拒绝时不会塞回队列', async (t) => {
  const { hub } = makeHub({
    busy: false,
    onSubmit: async () => { const e = new Error('busy'); e.code = 'CC_NODE_BUSY'; throw e },
  })
  t.after(() => hub.dispose())
  const s = await attach(hub)
  s.feed({ type: 'input', reqId: 'm-4', text: '/compact' })
  await wait(60)

  assert.equal(hub.queue.length, 0, '命令失败不该变成排队')
  assert.equal(s.take('error').length, 1, '应明确回错，而不是静默排队')
})

test('P1：对话输入遇到 CC_NODE_BUSY 仍然回到队列（原有行为不变）', async (t) => {
  const { hub } = makeHub({
    busy: false,
    onSubmit: async () => { const e = new Error('busy'); e.code = 'CC_NODE_BUSY'; throw e },
  })
  t.after(() => hub.dispose())
  const s = await attach(hub)
  s.feed({ type: 'input', reqId: 'm-5', text: '普通消息' })
  await wait(60)
  assert.equal(hub.queue.length, 1, '对话输入必须回到队列，不能丢')
})

// ------------------------------------------------------------
// P2-1：命令清单协议
// ------------------------------------------------------------

test('P2-1：command_list 返回机器可读清单', async (t) => {
  const list = buildCommandList()
  const { hub } = makeHub({ hub: { getCommands: () => list } })
  t.after(() => hub.dispose())
  const s = await attach(hub)
  s.feed({ type: 'command_list' })
  await wait(30)

  const m = s.last('commands')
  assert.ok(m, '应收到 commands')
  assert.equal(m.supported, true)
  assert.ok(m.list.length >= 20, `清单条数异常: ${m.list.length}`)

  const status = m.list.find(c => c.cmd === '/status')
  assert.ok(status, '必须包含 /status')
  assert.equal(status.busySafe, true)
  assert.equal(typeof status.desc, 'string')
  assert.ok(status.desc.length > 0)

  for (const c of m.list) {
    assert.equal(typeof c.cmd, 'string')
    assert.ok(c.cmd.startsWith('/'))
    assert.equal(typeof c.needsArg, 'boolean')
    assert.ok(Array.isArray(c.options))
    assert.equal(typeof c.danger, 'boolean')
    assert.equal(typeof c.busySafe, 'boolean')
  }
})

test('P2-1：/model 标 needsArg，/thinking 给枚举值，/api-key 标 secret', async (t) => {
  const list = buildCommandList()
  const by = cmd => list.find(c => c.cmd === cmd)
  assert.equal(by('/model').needsArg, true)
  assert.deepEqual(by('/thinking').options, ['auto', 'off', 'on'])
  assert.equal(by('/api-key').secret, true)
  assert.equal(by('/clear').danger, true)
  assert.equal(by('/clear').busySafe, false)
})

test('P2-1：宿主没提供 getCommands 时明确 supported:false（不假装空清单）', async (t) => {
  const { hub } = makeHub()
  t.after(() => hub.dispose())
  const s = await attach(hub)
  s.feed({ type: 'command_list' })
  await wait(30)
  const m = s.last('commands')
  assert.equal(m.supported, false)
  assert.deepEqual(m.list, [])
})

test('P2-1：清单与 cli.js 的 switch 不漂移（命令集合一致）', async (t) => {
  const src = await readFile(join(__dirname, '../core/cli.js'), 'utf8')
  // 命令 switch 内的 case 标签：case 'help': ... （含 case 'exit': case 'quit':）
  const start = src.indexOf("      switch (cmd) {")
  assert.ok(start > 0, '找不到命令 switch')
  const end = src.indexOf('\n      }\n', start)
  const block = src.slice(start, end)
  const found = new Set([...block.matchAll(/case '([a-z0-9-]+)':/g)].map(m => m[1]))

  // 别名（如 /quit = /exit）也算"已声明"，否则会把别名误报成漂移
  const declared = new Set()
  for (const s of COMMAND_SPEC) {
    declared.add(s.cmd.slice(1))
    for (const a of s.aliases || []) declared.add(a.slice(1))
  }
  const missing = [...found].filter(c => !declared.has(c))
  const extra = [...declared].filter(c => !found.has(c))
  // 反向检查：清单里每条都必须真的在 switch 里（别名已并入 declared）

  assert.deepEqual(missing, [], `cli.js 有但清单缺: ${missing.join(',')}`)
  assert.deepEqual(extra, [], `清单有但 cli.js 无: ${extra.join(',')}`)
})

test('P2-1：忙时白名单与清单的 busySafe 一致', async (t) => {
  const expected = COMMAND_SPEC.filter(s => s.busySafe).map(s => s.cmd.slice(1)).sort()
  assert.deepEqual([...BUSY_SAFE_COMMANDS].sort(), expected)
  assert.ok(BUSY_SAFE_COMMANDS.has('stop'), '/stop 必须能忙时执行')
  assert.ok(!BUSY_SAFE_COMMANDS.has('clear'), '/clear 绝不能忙时执行')
  assert.ok(!BUSY_SAFE_COMMANDS.has('compact'), '/compact 绝不能忙时执行')
})

// ------------------------------------------------------------
// P2-2：command/output 带 reqId 与 done
// ------------------------------------------------------------

test('P2-2：command/output 带 reqId 与 done，客户端能挂到对应气泡', async (t) => {
  const { hub } = makeHub()
  t.after(() => hub.dispose())
  const s = await attach(hub)
  hub.echo('会话列表...', { reqId: 'm-9', done: true })
  await wait(10)

  const m = s.last('command/output')
  assert.equal(m.text, '会话列表...')
  assert.equal(m.reqId, 'm-9')
  assert.equal(m.done, true)
})

test('P2-2：命令无输出时也发 done（客户端气泡不会永远转圈）', async (t) => {
  const { hub } = makeHub()
  t.after(() => hub.dispose())
  const s = await attach(hub)
  hub.echo('', { reqId: 'm-10', done: true })
  await wait(10)

  const m = s.last('command/output')
  assert.ok(m, '空输出 + done 也要发')
  assert.equal(m.text, '')
  assert.equal(m.reqId, 'm-10')
  assert.equal(m.done, true)
})

test('P2-2：既无正文又无 done 时不打扰客户端（保持原行为）', async (t) => {
  const { hub } = makeHub()
  t.after(() => hub.dispose())
  const s = await attach(hub)
  hub.echo('')
  await wait(10)
  assert.equal(s.take('command/output').length, 0)
})

test('P2-2：legacy 客户端仍只收 reply（不为 done 发空消息）', async (t) => {
  const { hub } = makeHub()
  t.after(() => hub.dispose())
  const s = new FakeSocket()
  hub.addClient(s)
  s.feed({ type: 'user_input', text: '老客户端' })
  await wait(20)
  hub.echo('命令输出', { reqId: 'x', done: true })
  hub.echo('', { reqId: 'y', done: true })
  await wait(10)
  assert.equal(s.take('reply').length, 1, 'legacy 只应收有正文的那条')
  assert.equal(s.take('command/output').length, 0, 'legacy 不该收到命令通道消息')
})

// ------------------------------------------------------------
// P2-3：分页游标绝对定位
// ------------------------------------------------------------


test('P2-3：同一 timestamp 的多条消息，翻页不重复也不丢', async (t) => {
  const ts = '2026-10-25T01:00:00.000Z'
  const all = [
    { role: 'user', text: 'a', timestamp: ts },
    { role: 'assistant', text: 'b', timestamp: ts },   // ← 撞车
    { role: 'user', text: 'c', timestamp: ts },
    { role: 'assistant', text: 'd', timestamp: '2026-10-25T01:00:05.000Z' },
  ]
  const seen = []
  let cursor = null
  for (let guard = 0; guard < 10; guard++) {
    const page = sliceMessagesForPage(all, { before: cursor, limit: 2 })
    seen.unshift(...page.messages.map(m => m.text))
    if (!page.nextBefore) break
    cursor = page.nextBefore
  }
  assert.deepEqual(seen, ['a', 'b', 'c', 'd'], `翻页结果: ${seen.join('')}`)
})

test('P2-3：nextBefore 原样回传即绝对定位（数字 / {index} 都认）', async (t) => {
  const all = Array.from({ length: 6 }, (_, i) => ({ text: String(i), timestamp: 'same' }))
  const p1 = sliceMessagesForPage(all, { before: null, limit: 2 })
  assert.deepEqual(p1.messages.map(m => m.text), ['4', '5'])
  assert.deepEqual(p1.nextBefore, { index: 4, timestamp: 'same' })

  const p2 = sliceMessagesForPage(all, { before: p1.nextBefore, limit: 2 })
  assert.deepEqual(p2.messages.map(m => m.text), ['2', '3'])

  const p3 = sliceMessagesForPage(all, { before: 2, limit: 2 })
  assert.deepEqual(p3.messages.map(m => m.text), ['0', '1'])
  assert.equal(p3.nextBefore, null, '到头了应给 null，客户端据此停止')
})

test('P2-3：同 ts 撞车时旧字符串游标会失效，nextBefore 才是升级路径', async () => {
  const ts = '2026-10-25T02:00:00.000Z'
  const all = [
    { text: 'a', timestamp: ts },
    { text: 'b', timestamp: ts },          // ← 与 a 完全同 ts
    { text: 'c', timestamp: 'later' },
  ]
  // 旧游标（字符串）：从第一条同 ts 之前开始 → 一条都拿不到（这就是报告说的缺陷）
  const legacy = sliceMessagesForPage(all, { before: ts, limit: 5 })
  assert.deepEqual(legacy.messages.map(m => m.text), [])

  // 新游标：绝对定位，精确翻页
  const p1 = sliceMessagesForPage(all, { limit: 2 })
  assert.deepEqual(p1.messages.map(m => m.text), ['b', 'c'])
  assert.deepEqual(p1.nextBefore, { index: 1, timestamp: ts })

  const p2 = sliceMessagesForPage(all, { before: p1.nextBefore, limit: 5 })
  assert.deepEqual(p2.messages.map(m => m.text), ['a'], '同 ts 的那条不会丢，也不会重复')
})
