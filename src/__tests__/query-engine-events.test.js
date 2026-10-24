// ============================================================
//  query-engine-events.test.js — 内核事件总线接入测试
//
//  验证目标（P0：一个内核、N 个视图）：
//    1. 一次真实 processMessage 会按顺序发出
//       turn/start → stream → tool/call → tool/result → turn/end → status(idle)
//    2. turn/start 与 turn/end 的 reqId 一致（视图据此归并一个回合）
//    3. 确认请求会产生 confirm/request + confirm/resolved（先答先赢的基础）
//    4. 内核异常时也会发 turn/end + status(idle)，不会让视图永远挂着
//
//  运行：node --test src/__tests__/query-engine-events.test.js
// ============================================================
import { test, afterEach } from 'node:test'
import assert from 'node:assert'
import { QueryEngine } from '../core/query-engine.js'
import { EventBus } from '../core/event-bus.js'

const realFetch = global.fetch
afterEach(() => { global.fetch = realFetch })

/** 把一组 OpenAI SSE chunk 包成 fetch 能返回的流式 Response */
function sseResponse(chunks) {
  const text = chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n'
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/** 造一个真实引擎，只把「上下文压缩」和「网络」打桩，其余走真实代码 */
function makeEngine({ bus = new EventBus(), tools = [], permissionChecker = null, onConfirmTool = null } = {}) {
  const engine = new QueryEngine({
    model: 'test-model',
    apiKey: 'test-key',
    apiBase: 'https://llm.invalid/v1',
    tools,
    permissionMode: 'all',
    cwd: process.cwd(),
    maxTurns: 4,
    bus,
    onConfirmTool,
  })
  // 上下文压缩依赖真实 token 预算配置；本测试只关心事件协议，跳过压缩不影响结论
  engine._ensureFitWindow = () => {}
  engine._clearLlmCache = async () => {}
  if (permissionChecker) engine.permissionChecker = permissionChecker
  return engine
}

const delta = (d, finish = null) => ({ choices: [{ delta: d, finish_reason: finish }] })

test('完整回合：事件顺序正确，reqId 全程一致', async () => {
  const bus = new EventBus()
  const engine = makeEngine({
    bus,
    tools: [{ name: 'Noop', description: 'noop', parameters: { type: 'object', properties: {} }, handler: async () => '工具结果内容' }],
  })

  let round = 0
  global.fetch = async () => {
    round++
    if (round === 1) {
      // 第一轮：一段文本 + 一个工具调用
      return sseResponse([
        delta({ content: '让我先查一下。' }),
        delta({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'Noop', arguments: '{"a":1}' } }] }, 'tool_calls'),
      ])
    }
    // 第二轮：最终答复
    return sseResponse([delta({ content: '完成。' }, 'stop')])
  }

  const events = []
  bus.subscribe(ev => events.push(ev))

  const result = await engine.processMessage('你好')
  assert.equal(result.response, '完成。')

  const types = events.map(e => e.type)
  assert.deepEqual(types, [
    'turn/start',
    'status',
    'stream',
    'tool/call',
    'tool/result',
    'stream',
    'turn/end',
    'status',
  ])

  // reqId 一致性：除了 status（全局状态），其余事件都必须属于同一回合
  const reqIds = new Set(events.filter(e => e.reqId).map(e => e.reqId))
  assert.equal(reqIds.size, 1, `同一回合的 reqId 必须唯一且一致，实际 ${[...reqIds]}`)

  // 内容正确性
  const streams = events.filter(e => e.type === 'stream')
  assert.equal(streams[0].text, '让我先查一下。')
  assert.equal(streams[1].text, '完成。')

  const call = events.find(e => e.type === 'tool/call')
  assert.equal(call.name, 'Noop')
  assert.ok(call.input.includes('"a":1'), 'tool/call 应带参数摘要')

  const tr = events.find(e => e.type === 'tool/result')
  assert.equal(tr.ok, true)
  assert.equal(tr.summary, '工具结果内容')

  const end = events.find(e => e.type === 'turn/end')
  assert.equal(end.text, '完成。')
  assert.equal(end.aborted, false)

  // 状态收尾
  const statuses = events.filter(e => e.type === 'status').map(e => e.state)
  assert.deepEqual(statuses, ['running', 'idle'])
})

test('流式 reasoning：shape 正确进 stream 事件', async () => {
  const bus = new EventBus()
  const engine = makeEngine({ bus })
  global.fetch = async () => sseResponse([
    delta({ reasoning_content: '先想' }),
    delta({ reasoning_content: '一想' }),
    delta({ content: '答' }, 'stop'),
  ])

  const events = []
  bus.subscribe(ev => events.push(ev))
  await engine.processMessage('hi')

  const streamKinds = events.filter(e => e.type === 'stream').map(e => e.kind)
  assert.deepEqual(streamKinds, ['reasoning', 'reasoning', 'text'])
})

test('确认请求：发 confirm/request → confirm/resolved，拒绝时工具标记 skipped', async () => {
  const bus = new EventBus()
  const engine = makeEngine({
    bus,
    tools: [{ name: 'Danger', description: 'danger', parameters: { type: 'object', properties: {} }, handler: async () => 'never' }],
    permissionChecker: {
      sessionAllowAll: false,
      check: async () => ({ allowed: false, requiresConfirmation: true, reason: '需要确认' }),
    },
    // 新式返回：{ answer, by }
    onConfirmTool: async () => ({ answer: false, by: 'terminal' }),
  })

  const events = []
  bus.subscribe(ev => events.push(ev))

  engine._currentReqId = 'r-test'
  const results = await engine._executeToolCalls([{ id: 'c1', name: 'Danger', input: { path: '/etc/passwd' } }])

  assert.equal(results[0].isError, true)
  assert.match(results[0].content, /未确认/)

  const req = events.find(e => e.type === 'confirm/request')
  assert.equal(req.tool, 'Danger')
  assert.ok(req.snippet.includes('/etc/passwd'))

  const resolved = events.find(e => e.type === 'confirm/resolved')
  assert.equal(resolved.answer, 'n')
  assert.equal(resolved.by, 'terminal')
  assert.equal(resolved.id, req.id, '请求与应答的 id 必须对应')

  const tr = events.find(e => e.type === 'tool/result')
  assert.equal(tr.skipped, true)
  assert.equal(tr.ok, false)
})

test('确认通过：布尔返回（旧行为）依然被兼容', async () => {
  const bus = new EventBus()
  const engine = makeEngine({
    bus,
    tools: [{ name: 'Safe', description: 'safe', parameters: { type: 'object', properties: {} }, handler: async () => 'done' }],
    permissionChecker: {
      sessionAllowAll: false,
      check: async () => ({ allowed: false, requiresConfirmation: true }),
    },
    onConfirmTool: async () => true,   // 旧式布尔
  })

  const events = []
  bus.subscribe(ev => events.push(ev))

  engine._currentReqId = 'r-test'
  const results = await engine._executeToolCalls([{ id: 'c1', name: 'Safe', input: {} }])

  assert.equal(results[0].content, 'done')
  const resolved = events.find(e => e.type === 'confirm/resolved')
  assert.equal(resolved.answer, 'y')
  assert.equal(resolved.by, null)
})

test('内核异常：仍发 turn/end(error) + status(idle)，视图不会永远挂起', async () => {
  const bus = new EventBus()
  const engine = makeEngine({ bus })
  global.fetch = async () => { throw new Error('网络炸了') }

  const events = []
  bus.subscribe(ev => events.push(ev))

  await assert.rejects(() => engine.processMessage('hi'), /网络炸了|fetch failed/i)

  const end = events.find(e => e.type === 'turn/end')
  assert.ok(end, '异常路径必须发 turn/end')
  assert.ok(end.error, 'turn/end 应带 error 说明')
  assert.deepEqual(events.filter(e => e.type === 'status').map(e => e.state), ['running', 'idle'])
  assert.equal(events.some(e => e.type === 'turn/start'), true)
})
