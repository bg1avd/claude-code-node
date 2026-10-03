// ============================================================
//  token-budget.test.js — token 估算单测
//  重点：修复 tool_calls 参数 / reasoning_content / 图片 的漏算(2026-09-22)
//  背景：旧 estimateMessages 只看 msg.content，把"纯工具调用"消息估成 10 tokens，
//        导致长对话压缩判定严重低估(实测 308k 估 vs 986k 实际) → API 400 超窗。
//  运行：node --test src/__tests__/token-budget.test.js
// ============================================================
import { test } from 'node:test'
import assert from 'node:assert'
import { estimateTokens, estimateMessageTokens, estimateMessages, TokenBudget } from '../core/token-budget.js'

test('estimateTokens: 空/中文/英文基本估算', () => {
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens(null), 0)
  assert.ok(estimateTokens('hello world') > 0)
  assert.equal(estimateTokens('一二三四五六七八九十'), Math.ceil(10 / 1.5))   // 中文 1.5 字/token
})

test('estimateMessageTokens: 纯文本消息 = content + 固定开销', () => {
  const n = estimateMessageTokens({ role: 'user', content: '你好世界' })
  assert.equal(n, estimateTokens('你好世界') + 10)
})

// ★ 核心修复：tool_calls 参数必须计入
test('estimateMessageTokens: tool_calls 参数计入(旧实现漏算)', () => {
  const bigInput = { file_path: '/tmp/x', content: 'A'.repeat(4000) }   // ≈1000 tokens
  const msg = {
    role: 'assistant',
    content: null,                                    // 纯工具调用,无文本
    toolCalls: [{ id: 'call_1', name: 'Write', input: bigInput }],
  }
  const n = estimateMessageTokens(msg)
  assert.ok(n > estimateTokens(JSON.stringify(bigInput)), `期望计入参数,实际 ${n}`)
  assert.ok(n > 1000, `旧实现只返回 10,今应 > 1000,实际 ${n}`)
})

test('estimateMessageTokens: 兼容 OpenAI snake_case tool_calls', () => {
  const msg = {
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'c1', function: { name: 'Bash', arguments: JSON.stringify({ command: 'x'.repeat(400) }) } }],
  }
  assert.ok(estimateMessageTokens(msg) > 100)
})

test('estimateMessageTokens: content 为对象也计入(旧实现漏算)', () => {
  const msg = { role: 'user', content: { nested: 'B'.repeat(400) } }
  assert.ok(estimateMessageTokens(msg) > 100)
})

test('estimateMessageTokens: reasoningContent 计入', () => {
  const msg = { role: 'assistant', content: 'hi', reasoningContent: '想'.repeat(300) }
  assert.ok(estimateMessageTokens(msg) > estimateTokens('想'.repeat(300)))
})

test('estimateMessageTokens: 图片按张数估算(不按 base64 长度)', () => {
  const msg = { role: 'user', content: '看这张图', images: ['data:image/png;base64,' + 'A'.repeat(100000)] }
  const n = estimateMessageTokens(msg)
  assert.ok(n < 2000, `图片不应按 base64 长度估算,实际 ${n}`)
  assert.ok(n >= 1600)
})

test('estimateMessageTokens: content 数组里的 image_url 计一张图', () => {
  const msg = { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: 'data:...' } }] }
  assert.ok(estimateMessageTokens(msg) >= 1600)
})

test('estimateMessages: 列表估算 = 各条之和', () => {
  const msgs = [
    { role: 'user', content: '问题' },
    { role: 'assistant', content: null, toolCalls: [{ id: 'c', name: 'Bash', input: { command: 'ls' } }] },
    { role: 'tool', tool_call_id: 'c', content: '输出' },
  ]
  const sum = msgs.reduce((a, m) => a + estimateMessageTokens(m), 0)
  assert.equal(estimateMessages(msgs), sum)
})

test('TokenBudget.estimateMessages 与纯函数同口径', () => {
  const b = new TokenBudget({ maxTokens: 1000 })
  const msgs = [{ role: 'assistant', content: null, toolCalls: [{ id: 'c', name: 'Write', input: { content: 'x'.repeat(800) } }] }]
  assert.equal(b.estimateMessages(msgs), estimateMessages(msgs))
  assert.ok(b.estimateMessages(msgs) > 200)
})

// ★ 回归场景：模拟"长对话大量工具参数" —— 旧实现严重低估
test('回归:含大量工具参数的历史不再被严重低估', () => {
  const msgs = []
  for (let i = 0; i < 20; i++) {
    msgs.push({ role: 'user', content: '任务' })
    msgs.push({
      role: 'assistant', content: null,
      toolCalls: [{ id: 'c' + i, name: 'Write', input: { file_path: `/f${i}`, content: 'X'.repeat(8000) } }],
    })
    msgs.push({ role: 'tool', tool_call_id: 'c' + i, content: 'ok' })
  }
  const est = estimateMessages(msgs)
  // 20 × 8000 字符 ≈ 20000 tokens(非 CJK /4);旧实现只会算 ~几百
  assert.ok(est > 20000, `应计入工具参数,实际 ${est}`)
})
