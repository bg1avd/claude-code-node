/**
 * 滑动窗口裁剪 (trimToWindow) 测试
 *
 * 验证核心滑动窗口语义：
 *   - 未超窗不动；
 *   - 超窗时从【最早】消息精确裁剪（最新信息保留在末尾）；
 *   - system 提示永不裁剪；
 *   - 被裁剪历史压缩成摘要保留（不丢上下文，keepSummary 默认开启）；
 *   - 裁剪后总 token 一定 ≤ 窗口上限；
 *   - 极端情况（单条消息超窗）仍保留 system + 最近一条。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { trimToWindow, compactMessages } from '../core/compact.js'
import { TokenBudget } from '../core/token-budget.js'

/** 构造一个固定窗口的 TokenBudget */
function makeBudget(maxTokens, reservedForOutput = 10) {
  return new TokenBudget({ maxTokens, reservedForOutput })
}

/** 构造消息：system + n 轮 user/assistant */
function makeMessages(n, { pad = 10, sysContent = 'SYS' } = {}) {
  const msgs = [{ role: 'system', content: sysContent }]
  for (let i = 0; i < n; i++) {
    msgs.push({ role: 'user', content: `user msg ${i}` + ' '.repeat(pad) })
    msgs.push({ role: 'assistant', content: `assistant reply ${i}` + ' '.repeat(pad) })
  }
  return msgs
}

test('滑动窗口：未超窗时消息原样保留', () => {
  const tb = makeBudget(10000)
  const msgs = makeMessages(2)
  const r = trimToWindow(msgs, { tokenBudget: tb, maxTokens: tb.maxTokens })
  assert.equal(r.trimmed, false)
  assert.equal(r.removed, 0)
  assert.equal(r.summary, null)
  assert.equal(r.messages.length, msgs.length)
})

test('滑动窗口：超窗时从最早消息精确裁剪，且总 token ≤ 窗口', () => {
  const tb = makeBudget(500)
  const msgs = makeMessages(20) // 41 条，超窗
  const r = trimToWindow(msgs, { tokenBudget: tb, maxTokens: tb.maxTokens })
  assert.equal(r.trimmed, true)
  assert.ok(r.removed > 0)
  // 裁剪后总 token ≤ 窗口上限（减去输出预留）
  assert.ok(tb.estimateMessages(r.messages) <= tb.maxTokens - tb.reservedForOutput,
    `裁剪后 ${tb.estimateMessages(r.messages)} 应 ≤ ${tb.maxTokens - tb.reservedForOutput}`)
  // 消息数变少
  assert.ok(r.messages.length < msgs.length)
})

test('滑动窗口：最新消息始终保留在末尾', () => {
  const tb = makeBudget(500)
  const msgs = makeMessages(20)
  const r = trimToWindow(msgs, { tokenBudget: tb, maxTokens: tb.maxTokens })
  const last = r.messages[r.messages.length - 1]
  assert.equal(last.role, 'assistant')
  assert.ok(last.content.includes('assistant reply 19'), '最后一条应为最新回复')
})

test('滑动窗口：system 提示永不裁剪', () => {
  const tb = makeBudget(500)
  const msgs = makeMessages(20)
  const r = trimToWindow(msgs, { tokenBudget: tb, maxTokens: tb.maxTokens })
  assert.equal(r.messages[0].role, 'system')
  assert.equal(r.messages[0].content, 'SYS')
})

test('滑动窗口：裁剪后保留最近连续对话（无空洞）', () => {
  const tb = makeBudget(500)
  const msgs = makeMessages(20)
  const r = trimToWindow(msgs, { tokenBudget: tb, maxTokens: tb.maxTokens })
  // 裁剪后 = 原始 system + (摘要 system) + 连续的 user/assistant 对
  const body = r.messages.filter(m => m.role !== 'system') // 去掉 system（含摘要 system）
  for (let i = 0; i < body.length; i++) {
    if (i % 2 === 0) assert.equal(body[i].role, 'user', `第 ${i} 条应为 user`)
    else assert.equal(body[i].role, 'assistant', `第 ${i} 条应为 assistant`)
  }
})

test('滑动窗口：被裁剪历史压缩成摘要保留（不丢失上下文）', () => {
  const tb = makeBudget(500)
  const msgs = makeMessages(20) // 41 条，超窗
  const r = trimToWindow(msgs, { tokenBudget: tb, maxTokens: tb.maxTokens })
  assert.equal(r.trimmed, true)
  assert.ok(r.summary, '应生成被裁剪历史的摘要')
  // 摘要作为 system 消息保留在结果中
  assert.ok(r.messages.some(m => m.role === 'system' && m.content.includes('Context Summary')),
    '结果中应包含摘要 system')
  // 摘要里应包含被裁掉的早期用户意图
  assert.ok(r.summary.includes('user msg'), '摘要应包含早期用户内容')
})

test('滑动窗口：keepSummary=false 时不保留摘要', () => {
  const tb = makeBudget(500)
  const msgs = makeMessages(20)
  const r = trimToWindow(msgs, { tokenBudget: tb, maxTokens: tb.maxTokens, keepSummary: false })
  assert.equal(r.trimmed, true)
  assert.equal(r.summary, null)
  assert.ok(!r.messages.some(m => m.role === 'system' && m.content.includes('Context Summary')))
})

test('滑动窗口：limitOverride 指定保守裁剪上限（提前触发，防实际超窗）', () => {
  const tb = makeBudget(500)
  const msgs = makeMessages(20) // 41 条
  // 用 limitOverride 指定一个更保守的裁剪上限（模拟估算偏差预留余量）
  const hardLimit = tb.maxTokens - tb.reservedForOutput // 490
  const conservative = Math.floor(hardLimit * 0.85) // 416
  const r = trimToWindow(msgs, { tokenBudget: tb, maxTokens: tb.maxTokens, keepSummary: true, limitOverride: conservative })
  assert.equal(r.trimmed, true)
  // 裁剪后估算 ≤ 保守上限
  assert.ok(tb.estimateMessages(r.messages) <= conservative,
    `裁剪后 ${tb.estimateMessages(r.messages)} 应 ≤ 保守上限 ${conservative}`)
})

test('滑动窗口：极端情况（单条消息超窗）仍保留 system + 最近一条', () => {
  const tb = makeBudget(50) // 窗口很小
  // 构造：每条消息都较大，导致任何单条都可能超窗
  const msgs = [
    { role: 'system', content: 'SYS' },
    { role: 'user', content: 'a'.repeat(100) },
    { role: 'assistant', content: 'b'.repeat(100) },
  ]
  const r = trimToWindow(msgs, { tokenBudget: tb, maxTokens: tb.maxTokens })
  // 至少保留 system + 最后一条
  assert.equal(r.messages[0].role, 'system')
  assert.ok(r.messages.length >= 2)
  assert.equal(r.messages[r.messages.length - 1].content, 'b'.repeat(100))
})

test('滑动窗口：自动估算（无 tokenBudget 时用 estimateTokens）', () => {
  const msgs = makeMessages(10, { pad: 50 })
  const r = trimToWindow(msgs, { maxTokens: 200 })
  // 没有 tokenBudget，用内置 estimateTokens，仍能裁剪
  assert.equal(r.trimmed, true)
  assert.ok(r.messages.length < msgs.length)
  // system 保留
  assert.equal(r.messages[0].role, 'system')
})

test('摘要式压缩 compactMessages 仍可用（信息量更高路径）', () => {
  const tb = makeBudget(200, 0)
  const msgs = makeMessages(8, { pad: 30 })
  const r = compactMessages(msgs, { maxTokens: 120 })
  // 摘要式：保留最近 4 轮 + 早期摘要
  assert.ok(r.length > 0)
  assert.ok(r.length < msgs.length, '摘要应减少消息数')
  // 摘要作为 system 上下文插入
  assert.equal(r[0].role, 'system')
})

test('摘要改进：Main goal 保留最早的核心任务（不丢早期主线）', () => {
  const tb = makeBudget(128000, 8192)
  // 触发摘要分支：纯对话量大（无超长工具结果可截断），必须靠摘要压缩
  const msgs = [
    { role: 'user', content: '【核心任务】修复撮合引擎 bug' },
    { role: 'assistant', content: '定位中，使用工具查看', toolCalls: [{ id: 'a', name: 'Grep', input: { pattern: 'x' } }] },
    { role: 'tool', tool_call_id: 'a', content: 'result' },
    { role: 'assistant', content: '关键发现：价格优先排序错误' },
  ]
  for (let i = 0; i < 400; i++) {
    msgs.push({ role: 'user', content: `例行检查 ${i} 确认行情 ` + 'x'.repeat(600) })
    msgs.push({ role: 'assistant', content: `完成 ${i} ` + 'y'.repeat(500) })
  }
  const r = compactMessages(msgs, { maxTokens: Math.floor(tb.maxTokens * 0.6) })
  const all = r.map(m => (typeof m.content === 'string' ? m.content : '')).join('\n')
  assert.ok(r.some(m => m.role === 'system' && m.content.includes('Context Summary')), '应生成摘要')
  assert.ok(all.includes('Main goal'), '摘要应包含 Main goal')
  assert.ok(all.includes('撮合引擎'), '核心任务应在 Main goal 中保留')
  assert.ok(all.includes('价格优先'), '早期关键发现应在 Key results 中保留')
})

test('摘要改进：数字归一化去重，避免例行序号占满摘要', () => {
  const tb = makeBudget(128000, 8192)
  const msgs = []
  for (let i = 0; i < 400; i++) {
    msgs.push({ role: 'user', content: `例行检查 ${i} 确认数据 ` + 'x'.repeat(600) })
    msgs.push({ role: 'assistant', content: `检查 ${i} 完成 ` + 'y'.repeat(500) })
  }
  const r = compactMessages(msgs, { maxTokens: Math.floor(tb.maxTokens * 0.6) })
  const sm = r.find(m => m.role === 'system' && m.content.includes('Context Summary'))
  assert.ok(sm, '应有摘要')
  // 数字归一化后，"例行检查 0/1/2..." 应被归并为一条，而不是每个序号都出现
  const intentCount = (sm.content.match(/例行检查/g) || []).length
  assert.ok(intentCount <= 2, `例行意图应被去重（实际 ${intentCount} 条）`)
})
