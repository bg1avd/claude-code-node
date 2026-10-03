// ============================================================
//  query-engine-buildrequest.test.js — 请求体构建单测
//  重点：修复 assistant 空消息导致的 API 400
//        ("content or tool_calls must be set", 2026-09-22)
//  运行：node --test src/__tests__/query-engine-buildrequest.test.js
// ============================================================
import { test } from 'node:test'
import assert from 'node:assert'
import { QueryEngine } from '../core/query-engine.js'
import { TokenBudget } from '../core/token-budget.js'

function mkEngine(opts = {}) {
  return new QueryEngine({ cwd: process.cwd(), model: 'test', ...opts })
}

test('_buildRequest: 跳过无 content 且无 tool_calls 的空 assistant 消息', () => {
  const engine = mkEngine()
  const req = engine._buildRequest([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: null, toolCalls: [] },    // 空 → 应跳过
    { role: 'assistant', content: '', toolCalls: [] },      // 空串 → 应跳过
    { role: 'assistant', content: '正常回复' },
  ])
  const asst = req.filter(m => m.role === 'assistant')
  assert.equal(asst.length, 1, '空 assistant 消息应被跳过,只保留有内容的')
  assert.equal(asst[0].content, '正常回复')
})

test('_buildRequest: 带 tool_calls 的 assistant 保留(content=null)', () => {
  const engine = mkEngine()
  const req = engine._buildRequest([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: null, toolCalls: [{ id: 'c1', name: 'Bash', input: { command: 'ls' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'out' },
  ])
  const asst = req.find(m => m.role === 'assistant')
  assert.ok(asst, '有 tool_calls 的 assistant 应保留')
  assert.equal(asst.content, null)
  assert.equal(asst.tool_calls.length, 1)
  assert.equal(asst.tool_calls[0].function.name, 'Bash')
  assert.equal(JSON.parse(asst.tool_calls[0].function.arguments).command, 'ls')
})

test('_buildRequest: 空 assistant 被跳过时不破坏 tool 结果配对', () => {
  const engine = mkEngine()
  const req = engine._buildRequest([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: null, toolCalls: [{ id: 'c1', name: 'Bash', input: { command: 'ls' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'out' },
    { role: 'assistant', content: null, toolCalls: [] },   // 空 → 跳过
    { role: 'user', content: '再来' },
  ])
  // tool 消息仍存在,且其前置 assistant(tool_calls) 也在
  assert.ok(req.find(m => m.role === 'tool' && m.tool_call_id === 'c1'))
  assert.ok(req.find(m => m.role === 'assistant' && m.tool_calls))
  // 末尾 user 保留
  assert.equal(req[req.length - 1].content, '再来')
})

test('_computeMaxOutputTokens: 1M 窗口 → 62500(1/16)', () => {
  const engine = mkEngine({ tokenBudget: new TokenBudget({ maxTokens: 1_000_000 }) })
  assert.equal(engine._computeMaxOutputTokens(), Math.floor(1_000_000 / 16))
})
