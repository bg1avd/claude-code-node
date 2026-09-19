/**
 * 图片剥离单元测试 — 修复"多模态发图 → 切回纯文字模型 → 所有消息被拒"bug
 *
 * 场景复现：
 *   1. 多模态模型下发一张图片识别（图片进入会话历史）
 *   2. /model 切回纯文字模型
 *   3. 历史图片每轮随请求发送 → 纯文字模型报 "image not supported"，
 *      之后任何输入都无法工作
 *
 * 修复（三层防御）：
 *   1. /model 切换时主动调用 stripImagesFromHistory() 清历史图片
 *   2. _callLLM 收到图片相关 API 错误时自动剥离请求体+历史图片并重试（兜底）
 *   3. _stripImageParts 剥离 content 数组中的 image_url part
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { QueryEngine } from '../core/query-engine.js'
import { TokenBudget } from '../core/token-budget.js'

function makeEngine(overrides = {}) {
  return new QueryEngine({
    apiKey: 'test-key',
    apiBase: 'http://127.0.0.1:9/v1',
    noStream: true,
    tokenBudget: new TokenBudget({ maxTokens: 131072 }),
    ...overrides,
  })
}

test('_stripImageParts：剥离 image_url，剩单个 text part 时简化为字符串', () => {
  const qe = makeEngine()
  const messages = [
    { role: 'user', content: [
      { type: 'text', text: '请识别这张图' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ] },
  ]

  const removed = qe._stripImageParts(messages)

  assert.equal(removed, 1)
  assert.equal(messages[0].content, '请识别这张图', '单 text part 应简化为字符串')
})

test('_stripImageParts：多个 text part 时保留数组形式', () => {
  const qe = makeEngine()
  const messages = [
    { role: 'user', content: [
      { type: 'text', text: '第一段' },
      { type: 'image_url', image_url: { url: 'http://x/y.png' } },
      { type: 'text', text: '第二段' },
    ] },
  ]

  const removed = qe._stripImageParts(messages)

  assert.equal(removed, 1)
  assert.deepEqual(messages[0].content, [
    { type: 'text', text: '第一段' },
    { type: 'text', text: '第二段' },
  ])
})

test('_stripImageParts：无图片时返回 0 且内容不变', () => {
  const qe = makeEngine()
  const messages = [
    { role: 'user', content: '纯文本消息' },
    { role: 'user', content: [{ type: 'text', text: '数组文本' }] },
  ]

  const removed = qe._stripImageParts(messages)

  assert.equal(removed, 0)
  assert.equal(messages[0].content, '纯文本消息')
  assert.deepEqual(messages[1].content, [{ type: 'text', text: '数组文本' }])
})

test('stripImagesFromHistory：清 images 字段 + 返回张数；清后 _buildUserContent 回纯文本', () => {
  const qe = makeEngine()
  qe.state.messages.push({ role: 'user', content: '识别这张图', images: ['data:image/png;base64,A', 'data:image/jpeg;base64,B'] })
  qe.state.messages.push({ role: 'assistant', content: '这是一张猫的图片' })

  const removed = qe.stripImagesFromHistory()

  assert.equal(removed, 2)
  assert.deepEqual(qe.state.messages[0].images, [])
  assert.equal(qe._buildUserContent(qe.state.messages[0]), '识别这张图', '清后应回退为纯文本 content')
})

test('stripImagesFromHistory：同时处理 content 数组形式的图片', () => {
  const qe = makeEngine()
  qe.state.messages.push({ role: 'user', content: [
    { type: 'text', text: '看图' },
    { type: 'image_url', image_url: { url: 'http://x/1.png' } },
  ] })

  const removed = qe.stripImagesFromHistory()

  assert.equal(removed, 1)
  assert.equal(qe.state.messages[0].content, '看图')
})

test('_callLLM 兜底：API 报图片错误 → 自动剥离并重试成功，历史图片被清', async () => {
  const qe = makeEngine()
  // 模拟历史：一条含图 user 消息 + 后续纯文本
  qe.state.messages.push({ role: 'user', content: '识别这张图', images: ['data:image/png;base64,AAAA'] })
  qe.state.messages.push({ role: 'assistant', content: '图里是一只猫' })
  // 模拟 _buildRequest 产物（与 state.messages 是不同对象，同真实路径一致）
  const requestMessages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: [
      { type: 'text', text: '识别这张图' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ] },
    { role: 'assistant', content: '图里是一只猫' },
  ]

  let callCount = 0
  const bodies = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, opts) => {
    callCount++
    bodies.push(JSON.parse(opts.body))
    if (callCount === 1) {
      return new Response(JSON.stringify({ error: { message: 'image content is not supported by this model' } }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }

  try {
    const result = await qe._callLLM(requestMessages, qe.state.messages)
    assert.equal(result.content, 'ok')
    assert.equal(callCount, 2, '第一次失败后应自动重试一次')
    // 重试请求不应再含 image_url
    const userContent = bodies[1].messages.find(m => m.role === 'user').content
    assert.equal(userContent, '识别这张图', '重试请求应剥离图片并简化为字符串')
    // 会话历史也应被清理，后续轮次不再发图
    assert.deepEqual(qe.state.messages[0].images, [])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('_callLLM 兜底：剥离后仍报图片错误 → 正常抛出（不死循环）', async () => {
  const qe = makeEngine()
  qe.state.messages.push({ role: 'user', content: '识别这张图', images: ['data:image/png;base64,AAAA'] })
  const requestMessages = [
    { role: 'user', content: [
      { type: 'text', text: '识别这张图' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ] },
  ]

  let callCount = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    callCount++
    return new Response(JSON.stringify({ error: { message: 'image not supported' } }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    await assert.rejects(
      () => qe._callLLM(requestMessages, qe.state.messages),
      /image not supported/
    )
    // 兜底重试 1 次 + 常规重试上限 3 次 = 最多 4 次调用，绝不能死循环
    assert.ok(callCount <= 4, `调用次数应有限（实际 ${callCount}）`)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('_callLLM：非图片类 400 错误不触发剥离重试', async () => {
  const qe = makeEngine()
  qe.state.messages.push({ role: 'user', content: 'hi', images: ['data:image/png;base64,AAAA'] })
  const requestMessages = [
    { role: 'user', content: [
      { type: 'text', text: 'hi' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ] },
  ]

  let callCount = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    callCount++
    return new Response(JSON.stringify({ error: { message: 'invalid api key' } }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    await assert.rejects(() => qe._callLLM(requestMessages, qe.state.messages), /invalid api key/)
    assert.equal(callCount, 1, '非图片错误不应重试')
    // 历史图片保持原样（不能误清）
    assert.equal(qe.state.messages[0].images.length, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})
