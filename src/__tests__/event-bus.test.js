// ============================================================
//  event-bus.test.js — 内核事件总线单测
//  运行：node --test src/__tests__/event-bus.test.js
// ============================================================
import { test } from 'node:test'
import assert from 'node:assert'
import { EventBus, newReqId, summarizeToolResult } from '../core/event-bus.js'

test('emit：seq 单调递增，payload 合并且不覆盖 type/seq', () => {
  const bus = new EventBus()
  const a = bus.emit('status', { state: 'running' })
  const b = bus.emit('notice', { text: 'hi', type: '想覆盖我' })
  assert.equal(a.seq, 1)
  assert.equal(b.seq, 2)
  assert.equal(bus.counts.notice, 1)

  let got = null
  bus.subscribe(ev => { got = ev })
  bus.emit('notice', { text: 'x', seq: 999, type: 'hijack' })
  assert.equal(got.type, 'notice', 'payload 不能覆盖 type')
  assert.equal(got.seq, 3, 'payload 不能覆盖 seq')
})

test('subscribe：实时事件按序到达，取消订阅后不再收到', () => {
  const bus = new EventBus()
  const seen = []
  const off = bus.subscribe(ev => seen.push(ev.type))
  bus.emit('turn/start', { reqId: 'r1' })
  bus.emit('stream', { reqId: 'r1', kind: 'text', text: 'a' })
  off()
  bus.emit('turn/end', { reqId: 'r1' })
  assert.deepEqual(seen, ['turn/start', 'stream'])
})

test('subscribe：订阅者抛错被隔离，其他订阅者照常收到', () => {
  const bus = new EventBus()
  const good = []
  let errSeen = null
  bus.subscribe(() => { throw new Error('渲染崩了') }, { name: 'bad', onError: e => { errSeen = e.message } })
  bus.subscribe(ev => good.push(ev.type), { name: 'good' })

  assert.doesNotThrow(() => bus.emit('notice', { text: 'ok' }))
  assert.deepEqual(good, ['notice'])
  assert.equal(errSeen, '渲染崩了')
  assert.equal(bus.stats().subscribers, 2)
})

test('replay：stream 不进缓冲，结构性事件可被 sinceSeq 补齐', () => {
  const bus = new EventBus()
  bus.emit('turn/start', { reqId: 'r1' })          // seq 1
  bus.emit('stream', { reqId: 'r1', kind: 'text', text: 'a' })  // seq 2（不存）
  bus.emit('tool/call', { reqId: 'r1', name: 'Bash', input: {} }) // seq 3
  bus.emit('turn/end', { reqId: 'r1', text: 'done' })            // seq 4

  assert.deepEqual(bus.replay.map(e => e.type), ['turn/start', 'tool/call', 'turn/end'])

  const replayed = []
  bus.subscribe(ev => replayed.push(`${ev.type}@${ev.seq}`), { sinceSeq: 1 })
  // sinceSeq=1 → 只补 seq>1 的（tool/call=3, turn/end=4）
  assert.deepEqual(replayed, ['tool/call@3', 'turn/end@4'])
})

test('replay：超过 replaySize 时丢弃最老的', () => {
  const bus = new EventBus({ replaySize: 3 })
  for (let i = 0; i < 10; i++) bus.emit('notice', { text: `n${i}` })
  assert.equal(bus.replay.length, 3)
  assert.deepEqual(bus.replay.map(e => e.text), ['n7', 'n8', 'n9'])
})

test('turn 快照：中途 attach 能看到当前已生成文本', () => {
  const bus = new EventBus()
  bus.emit('turn/start', { reqId: 'r1', source: 'cli' })
  bus.emit('stream', { reqId: 'r1', kind: 'text', text: '你好' })
  bus.emit('stream', { reqId: 'r1', kind: 'reasoning', text: '想' })
  bus.emit('stream', { reqId: 'r1', kind: 'text', text: '，世界' })

  const seen = []
  bus.subscribe(ev => seen.push(ev))
  assert.equal(seen[0].type, 'turn/snapshot')
  assert.equal(seen[0].text, '你好，世界')
  assert.equal(seen[0].reasoning, '想')
  assert.equal(bus.stats().running, true)

  bus.emit('turn/end', { reqId: 'r1', text: '你好，世界' })
  assert.equal(bus.stats().running, false)
})

test('turn 快照：不属于当前回合的 stream 不污染快照', () => {
  const bus = new EventBus()
  bus.emit('turn/start', { reqId: 'r1' })
  bus.emit('stream', { reqId: 'other', kind: 'text', text: '别人的' })
  bus.emit('stream', { reqId: 'r1', kind: 'text', text: '我的' })
  assert.equal(bus.currentTurn.text, '我的')
})

test('订阅者上限：超限直接报错，避免 attach 泄漏拖垮进程', () => {
  const bus = new EventBus({ maxListeners: 2 })
  bus.subscribe(() => {})
  bus.subscribe(() => {})
  assert.throws(() => bus.subscribe(() => {}), /上限/)
})

test('newReqId：唯一且带前缀', () => {
  const ids = new Set(Array.from({ length: 200 }, () => newReqId()))
  assert.equal(ids.size, 200)
  assert.ok([...ids].every(id => id.startsWith('r')))
})

test('summarizeToolResult：超长内容截断并标注原长', () => {
  const s = summarizeToolResult('x'.repeat(1000), 100)
  assert.ok(s.length < 200)
  assert.ok(s.includes('已截断'))
  assert.equal(summarizeToolResult(null), '')
})

test('回合归档：turn/end 后可用 recentTurns 补正文（含 reasoning）', () => {
  const bus = new EventBus()
  bus.emit('turn/start', { reqId: 'r1' })
  bus.emit('stream', { reqId: 'r1', kind: 'reasoning', text: '想一想' })
  bus.emit('stream', { reqId: 'r1', kind: 'text', text: '回答一' })
  bus.emit('turn/end', { reqId: 'r1', text: '回答一', turns: 2, aborted: false })

  const turns = bus.recentTurns()
  assert.equal(turns.length, 1)
  assert.equal(turns[0].reqId, 'r1')
  assert.equal(turns[0].text, '回答一')
  assert.equal(turns[0].reasoning, '想一想', '归档前不能先清快照，否则 reasoning 丢失')
  assert.equal(turns[0].turns, 2)
})

test('回合归档：超出 historySize 时丢弃最老的，limit 从新到旧截取', () => {
  const bus = new EventBus({ historySize: 3 })
  for (let i = 1; i <= 5; i++) {
    bus.emit('turn/start', { reqId: `r${i}` })
    bus.emit('turn/end', { reqId: `r${i}`, text: `答${i}` })
  }
  assert.deepEqual(bus.recentTurns(10).map(t => t.text), ['答3', '答4', '答5'])
  assert.deepEqual(bus.recentTurns(2).map(t => t.text), ['答4', '答5'])
  assert.deepEqual(bus.recentTurns(0), [])
})

test('回合归档：historySize=0 时完全不存（不要这份内存）', () => {
  const bus = new EventBus({ historySize: 0 })
  bus.emit('turn/start', { reqId: 'r1' })
  bus.emit('turn/end', { reqId: 'r1', text: 'x' })
  assert.deepEqual(bus.recentTurns(5), [])
})
