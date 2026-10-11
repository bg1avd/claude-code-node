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
function makeLoopEngine({ maxTurns = 3, responses = [], tools = [], turnCount = 1, wrapUpRatio } = {}) {
  let i = 0
  const engine = {
    config: {
      maxTurns, verbose: false, tools, cwd: process.cwd(),
      onConfirmTool: null, readline: null, systemPrompt: 'BASE_SYS', smallModel: false,
      wrapUpRatio,
    },
    state: { messages: [], toolResults: new Map(), turnCount },
    abortController: new AbortController(),
    permissionChecker: { check: async () => ({ allowed: true }) },
    requests: [],                        // 记录每次发给 LLM 的请求体（用于断言收尾引导）
    _clearLlmCache: async () => {},
    _ensureFitWindow: () => {},
    _buildRequest: (msgs) => [{ role: 'system', content: 'BASE_SYS' }, ...msgs.map(m => ({ role: m.role, content: m.content }))],
    _callLLM: async (msgs) => {
      engine.requests.push(JSON.parse(JSON.stringify(msgs)))
      return responses[Math.min(i++, responses.length - 1)]
    },
  }
  engine._executeToolCalls = QueryEngine.prototype._executeToolCalls.bind(engine)
  engine._isAbortError = QueryEngine.prototype._isAbortError.bind(engine)
  engine._wrapUpAt = QueryEngine.prototype._wrapUpAt.bind(engine)
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

// ---------- 收尾引导（v3.6.14）----------

test('收尾引导：到达 maxTurns 的 wrapUpRatio 后，请求里注入「停止调工具」的 system 指令', async () => {
  const engine = makeLoopEngine({
    maxTurns: 10, wrapUpRatio: 0.5,      // → 第 6 轮（index 5）起注入
    tools: [{ name: 'Noop', handler: async () => 'ok' }],
    responses: [{ content: '', toolCalls: [new ToolCall('t', 'Noop', {})] }],
  })
  await run(engine)

  const hit = (req) => req.some(m => m.role === 'system' && String(m.content).includes('收尾指令'))
  assert.equal(hit(engine.requests[4]), false, '第 5 轮不应有收尾引导')
  assert.equal(hit(engine.requests[5]), true, '第 6 轮应开始有收尾引导')
  assert.equal(hit(engine.requests[9]), true, '之后每轮都应有')
})

test('收尾引导：system 位置正确（在所有前置 system 之后、正文之前）', async () => {
  const engine = makeLoopEngine({
    maxTurns: 4, wrapUpRatio: 0,          // 第 1 轮就注入
    tools: [{ name: 'Noop', handler: async () => 'ok' }],
    responses: [{ content: '', toolCalls: [new ToolCall('t', 'Noop', {})] }],
  })
  await run(engine)
  // 注意：_wrapUpAt() 下限为 1，即最早从第 2 轮（index 1）开始注入，第 1 轮永不注入
  const req = engine.requests[1]
  assert.ok(req.some(m => m.role === 'system' && String(m.content).includes('收尾指令')), '第 2 轮应已注入收尾引导')
  const roles = req.map(m => m.role)
  const lastSystem = roles.lastIndexOf('system')
  const firstNonSystem = roles.findIndex(r => r !== 'system')
  assert.ok(lastSystem < firstNonSystem, `system 必须都在正文之前，实际 roles=${roles.join(',')}`)
})

test('收尾引导：只进请求体，不污染会话历史 state.messages', async () => {
  const engine = makeLoopEngine({
    maxTurns: 4, wrapUpRatio: 0,
    tools: [{ name: 'Noop', handler: async () => 'ok' }],
    responses: [{ content: '', toolCalls: [new ToolCall('t', 'Noop', {})] }],
  })
  await run(engine)
  const polluted = engine.state.messages.some(m => String(m.content || '').includes('收尾指令'))
  assert.equal(polluted, false, '收尾引导不得写入 state.messages（否则会落盘/污染后续对话）')
})

// ---------- 空回复：不能再误报成「达到上限」（v3.6.15，用户实测反馈）----------
//
// 用户现象：Telegram 里 13:16 有输出、13:17 就出现「[达到最大回合数限制 (100)，停止响应]」——
// 中间只隔 1 分钟，**根本不可能跑满 100 轮**。真凶是：模型返回「空回复」（既无文字、
// 也无工具调用）时 finalResponse 保持空串，被「达到上限」分支接住误报。
// 而旧判据 `state.turnCount >= 100`（会话累计请求数，跨重启累加）只是让这个
// 错误提示"恰好有条件出现"，与工具循环轮数毫无关系。

test('空回复：模型返回空内容且无工具调用 → 报「空回复」，绝不误报「已达上限」', async () => {
  const engine = makeLoopEngine({
    maxTurns: 100,
    turnCount: 999,                                     // ← 用户那台机器的状态
    responses: [{ content: '', toolCalls: [] }],        // ← 空回复（第 1 轮就发生）
  })
  const r = await run(engine)
  assert.doesNotMatch(r.response, /达到最大回合数限制|已达上限/, '绝不能误报成达到上限')
  assert.match(r.response, /空回复/, '应明确告知是空回复')
  assert.match(r.response, /共 1 轮/, '应报告真实轮数（1 轮），而不是 100')
  assert.equal(r.aborted, false)
})

test('空回复：content 为 null 同样不该误报上限', async () => {
  const engine = makeLoopEngine({
    maxTurns: 100, turnCount: 100,
    responses: [{ content: null, toolCalls: [] }],
  })
  const r = await run(engine)
  assert.doesNotMatch(r.response, /达到最大回合数限制|已达上限/)
  assert.match(r.response, /空回复/)
})

test('回归对照：真的跑满上限时，仍应报「已达上限」', async () => {
  const engine = makeLoopEngine({
    maxTurns: 3, turnCount: 1,
    tools: [{ name: 'Noop', handler: async () => 'ok' }],
    responses: [{ content: '', toolCalls: [new ToolCall('t', 'Noop', {})] }],
  })
  const r = await run(engine)
  assert.match(r.response, /工具循环已达上限 3 轮/)
})

test('回归对照：正常有内容的答复，原样返回（不追加任何提示）', async () => {
  const engine = makeLoopEngine({ maxTurns: 100, turnCount: 999, responses: [{ content: '正常答复', toolCalls: [] }] })
  const r = await run(engine)
  assert.equal(r.response, '正常答复')
})
