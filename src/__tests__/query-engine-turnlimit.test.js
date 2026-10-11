/**
 * 工具循环「上限判定」+「用户中断」测试
 *
 * 背景（v3.6.13 修复）：
 *   _runToolLoop 判断"是否达到最大回合数"时，原来用的是 state.turnCount
 *   （会话累计用户请求数，跨 /resume、autoContinue 持久化累加），而不是工具循环
 *   自身的轮数。两者量纲完全不同 → 会话请求数 < maxTurns 时，明明工具循环已经
 *   跑满 100 轮，却既不报错也不提示，只返回空字符串（静默无响应）。
 *
 * 同时验证：用户 /stop 中断必须走「优雅收尾」——
 *   - 不抛异常（保证本轮消息能正常落盘，不丢历史/缓存）
 *   - 中断时为剩余 tool_call 补齐结果（否则 OpenAI 协议「孤儿 tool_calls」→ 下一轮 400）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { QueryEngine } from '../core/query-engine.js'
import { ToolCall } from '../types/index.js'

/** 构造一个只够跑 _runToolLoop 的最小假引擎（_callLLM / _buildRequest 全部打桩） */
function makeLoopEngine({ maxTurns = 3, responses = [], tools = [], turnCount = 1 } = {}) {
  let i = 0
  const engine = {
    config: {
      maxTurns, verbose: false, tools, cwd: process.cwd(),
      onConfirmTool: null, readline: null, systemPrompt: '', smallModel: false,
    },
    state: { messages: [], toolResults: new Map(), turnCount },
    abortController: new AbortController(),
    permissionChecker: { check: async () => ({ allowed: true }) },
    _clearLlmCache: async () => {},
    _ensureFitWindow: () => {},
    _buildRequest: () => [{ role: 'user', content: 'x' }],
    _callLLM: async () => responses[Math.min(i++, responses.length - 1)],
  }
  engine._executeToolCalls = QueryEngine.prototype._executeToolCalls.bind(engine)
  engine._isAbortError = QueryEngine.prototype._isAbortError.bind(engine)
  return engine
}

const run = (engine) => QueryEngine.prototype._runToolLoop.call(engine, { role: 'user', content: 'hi' })

test('工具循环：模型给出最终答复 → 正常收尾，无上限提示', async () => {
  const engine = makeLoopEngine({ maxTurns: 5, responses: [{ content: '完成 ✅', toolCalls: [] }] })
  const r = await run(engine)
  assert.equal(r.response, '完成 ✅')
  assert.equal(r.aborted, false)
})

test('工具循环：跑满上限 → 给出强制停止提示（回归：不再依赖 state.turnCount）', async () => {
  // turnCount=1 远小于 maxTurns=3 —— 旧逻辑下这里会返回空字符串（静默无响应）
  const engine = makeLoopEngine({
    maxTurns: 3,
    turnCount: 1,
    tools: [{ name: 'Noop', handler: async () => 'ok' }],
    responses: [{ content: '', toolCalls: [new ToolCall('t', 'Noop', {})] }],
  })
  const r = await run(engine)
  assert.match(r.response, /工具循环已达上限 3 轮/, '应给出上限提示而不是空响应')
  assert.notEqual(r.response, '', '绝不能返回空字符串')
  assert.equal(r.aborted, false)
})

test('工具循环：会话累计请求数很大也不误判为「中断」', async () => {
  const engine = makeLoopEngine({
    maxTurns: 2,
    turnCount: 999, // 会话累计请求数（旧逻辑的错误判据）
    tools: [{ name: 'Noop', handler: async () => 'ok' }],
    responses: [{ content: '', toolCalls: [new ToolCall('t', 'Noop', {})] }],
  })
  const r = await run(engine)
  assert.match(r.response, /工具循环已达上限/)
  assert.equal(r.aborted, false)
})

test('工具循环：/stop 中断 → 优雅收尾（不抛异常、有提示、aborted=true）', async () => {
  const engine = makeLoopEngine({
    maxTurns: 50,
    tools: [{ name: 'Noop', handler: async () => 'ok' }],
    responses: [{ content: '', toolCalls: [new ToolCall('t', 'Noop', {})] }],
  })
  // 第 1 轮工具执行时请求停止（模拟用户在循环中按 /stop）
  const orig = engine._executeToolCalls
  engine._executeToolCalls = async (calls) => {
    const r = await orig(calls)
    engine.abortController.abort()
    return r
  }
  const r = await run(engine)
  assert.equal(r.aborted, true, '应标记为中断')
  assert.match(r.response, /中断/, '应给出中断提示而不是空响应')
})

test('工具循环：中断时为剩余 tool_call 补齐结果（防「孤儿 tool_calls」400）', async () => {
  let ran = 0
  const engine = makeLoopEngine({
    maxTurns: 50,
    tools: [
      {
        name: 'Kill',
        handler: async () => { ran++; engine.abortController.abort(); return 'killed' },
      },
      { name: 'Never', handler: async () => { ran++; return 'should not run' } },
    ],
  })
  const calls = [
    new ToolCall('a', 'Kill', {}),
    new ToolCall('b', 'Never', {}),
    new ToolCall('c', 'Never', {}),
  ]
  const results = await QueryEngine.prototype._executeToolCalls.call(engine, calls)
  assert.equal(results.length, 3, '每个 tool_call 都必须有对应结果（协议要求）')
  assert.equal(ran, 1, '中断后不应继续执行剩余工具')
  assert.equal(results[0].content, 'killed')
  assert.equal(results[0].isError, false)
  assert.match(results[1].content, /已中断/)
  assert.match(results[2].content, /已中断/)
  assert.equal(results[1].isError, true)
})

test('工具循环：LLM 抛 AbortError → 转成优雅收尾而非异常', async () => {
  const engine = makeLoopEngine({ maxTurns: 10, responses: [{ content: 'x', toolCalls: [] }] })
  engine._callLLM = async () => {
    const e = new Error('This operation was aborted')
    e.name = 'AbortError'
    throw e
  }
  const r = await run(engine)
  assert.equal(r.aborted, true)
  assert.match(r.response, /中断/)
})

test('工具循环：非中断类异常仍照常抛出（不吞错）', async () => {
  const engine = makeLoopEngine({ maxTurns: 10, responses: [{ content: 'x', toolCalls: [] }] })
  engine._callLLM = async () => { throw new Error('API 错误 500') }
  await assert.rejects(() => run(engine), /API 错误 500/)
})

test('工具循环：中断后 state.messages 中 assistant.tool_calls 均配有 tool 消息', async () => {
  const engine = makeLoopEngine({
    maxTurns: 50,
    tools: [{ name: 'Kill', handler: async () => { engine.abortController.abort(); return 'k' } }],
  })
  await run(engine).catch(() => {})
  const msgs = engine.state.messages
  const asst = msgs.filter((m) => m.role === 'assistant' && m.toolCalls?.length)
  const toolIds = new Set(msgs.filter((m) => m.role === 'tool').map((m) => m.tool_call_id))
  for (const a of asst) {
    for (const tc of a.toolCalls) {
      assert.ok(toolIds.has(tc.id), `tool_call ${tc.id} 缺少对应的 tool 消息（会导致下一轮 400）`)
    }
  }
})
