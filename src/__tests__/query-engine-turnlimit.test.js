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
      const idx = i++
      if (typeof responses === 'function') return responses(idx)
      if (Array.isArray(responses)) return responses[Math.min(idx, responses.length - 1)]
      return responses          // 固定对象：每轮都返回同一个
    },
  }
  engine._executeToolCalls = QueryEngine.prototype._executeToolCalls.bind(engine)
  engine._isAbortError = QueryEngine.prototype._isAbortError.bind(engine)
  engine._wrapUpAt = QueryEngine.prototype._wrapUpAt.bind(engine)
  engine._turnLimit = QueryEngine.prototype._turnLimit.bind(engine)
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
  assert.match(r.response, /本轮工具调用已达 3 轮上限/, '应给出上限提示而不是空响应')
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
  assert.match(r.response, /已达 3 轮上限|本轮工具调用已达/)
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
    // 每轮参数不同 + 每轮结果不同 → 完全不触发「无进展检测」，专测收尾引导
    tools: [{ name: 'Noop', handler: async (input) => 'ok:' + JSON.stringify(input) }],
    responses: (i) => ({ content: '', toolCalls: [new ToolCall('t' + i, 'Noop', { i })] }),
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
  assert.doesNotMatch(r.response, /达到最大回合数限制|轮上限/, '绝不能误报成达到上限')
  assert.match(r.response, /没有返回任何内容/, '应明确告知模型没返回内容')
  assert.match(r.response, /共 1 轮/, '应报告真实轮数（1 轮），而不是 100')
  assert.equal(r.aborted, false)
})

test('空回复：content 为 null 同样不该误报上限', async () => {
  const engine = makeLoopEngine({
    maxTurns: 100, turnCount: 100,
    responses: [{ content: null, toolCalls: [] }],
  })
  const r = await run(engine)
  assert.doesNotMatch(r.response, /达到最大回合数限制|轮上限/)
  assert.match(r.response, /没有返回任何内容/)
})

test('回归对照：真的跑满上限时，仍应报「已达上限」', async () => {
  const engine = makeLoopEngine({
    maxTurns: 3, turnCount: 1,
    tools: [{ name: 'Noop', handler: async () => 'ok' }],
    responses: [{ content: '', toolCalls: [new ToolCall('t', 'Noop', {})] }],
  })
  const r = await run(engine)
  assert.match(r.response, /本轮工具调用已达 3 轮上限/)
})

test('回归对照：正常有内容的答复，原样返回（不追加任何提示）', async () => {
  const engine = makeLoopEngine({ maxTurns: 100, turnCount: 999, responses: [{ content: '正常答复', toolCalls: [] }] })
  const r = await run(engine)
  assert.equal(r.response, '正常答复')
})

// ---------- 无进展检测（v3.6.16）：替代"拍脑袋的固定轮数上限" ----------

test('无进展：连续重复同样的调用且结果不变 → 先提醒，再停止（不靠轮数上限）', async () => {
  const engine = makeLoopEngine({
    maxTurns: 0,                                 // ← 不限制轮数（默认）
    tools: [{ name: 'Stuck', handler: async () => 'always same' }],
    responses: { content: '', toolCalls: [new ToolCall('t', 'Stuck', { p: 1 })] },
  })
  const r = await run(engine)

  assert.match(r.response, /已停止/, '应停止而不是无限跑')
  assert.match(r.response, /重复/, '应说明原因是重复操作')
  assert.match(r.response, /Stuck/, '应指出是哪个工具')
  // 先礼后兵：第 3 轮提醒（第 4 轮请求里带提示）→ 第 5 轮才停
  assert.equal(engine.requests.length, 5, `应在第 5 轮停下，实际 ${engine.requests.length} 轮`)
  const warned = engine.requests.some(q => q.some(m => m.role === 'system' && String(m.content).includes('重复检测')))
  assert.ok(warned, '停止之前应先注入过一次「重复检测」提醒')
})

test('无进展：结果不同（在推进）→ 不误判，可跑很多轮', async () => {
  let n = 0
  const engine = makeLoopEngine({
    maxTurns: 0,
    tools: [{ name: 'Work', handler: async (input) => 'step ' + (++n) + ' arg ' + input.i }],
    // 每轮参数不同（真的在换着法子推进）→ 不该被判为无进展
    responses: (i) => ({ content: '', toolCalls: [new ToolCall('t' + i, 'Work', { i })] }),
  })
  // 手动在若干轮后让它收尾，避免真跑 1000 轮
  let calls = 0
  const orig = engine._callLLM
  engine._callLLM = async (msgs) => {
    if (++calls > 12) return { content: '完成', toolCalls: [] }
    return orig(msgs)
  }
  const r = await run(engine)
  assert.equal(r.response, '完成', '有进展就不该被无进展检测打断')
})

test('无进展：中间夹一次不同调用 → 连击清零，不误判', async () => {
  // 模拟"改代码 → 跑测试 → 改代码 → 跑测试"的正常节律
  let n = 0
  const seq = [
    { content: '', toolCalls: [new ToolCall('a', 'Test', {})] },
    { content: '', toolCalls: [new ToolCall('b', 'Edit', {})] },
  ]
  const engine = makeLoopEngine({
    maxTurns: 0,
    tools: [
      { name: 'Test', handler: async () => 'FAIL' },      // 同样的失败结果
      { name: 'Edit', handler: async () => 'edited ' + (++n) },
    ],
    responses: (i) => (i >= 8 ? { content: '修好了', toolCalls: [] } : seq[i % 2]),
  })
  const r = await run(engine)
  assert.equal(r.response, '修好了', '交替的调用节律不应被判为无进展')
})

test('不限制轮数：maxTurns=0 时循环上限走极端兜底，且不注入收尾引导', async () => {
  const engine = makeLoopEngine({ maxTurns: 0, responses: [{ content: 'ok', toolCalls: [] }] })
  assert.ok(engine._turnLimit() >= 1000, 'maxTurns=0 应由极端兜底接管')
  assert.equal(engine._wrapUpAt(), Infinity, '不限轮数时不应有"快到上限"的收尾引导')
})

test('不限制轮数：maxTurns=100 时收尾引导仍在第 81 轮', () => {
  const engine = makeLoopEngine({ maxTurns: 100, responses: [{ content: 'x', toolCalls: [] }] })
  assert.equal(engine._turnLimit(), 100)
  assert.equal(engine._wrapUpAt(), 80)   // turn index 80 == 第 81 轮
})
