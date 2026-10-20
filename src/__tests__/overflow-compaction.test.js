/**
 * 上下文超窗自愈 + 服务端反馈校准（v3.6.20）
 *
 * 背景（真实事故，用户截图）：
 *   API 400: This model's maximum context length is 1048576 tokens. However, you
 *   requested 1049296 tokens (986796 in the messages, 62500 in the completion).
 *
 *   同一时刻用户敲 /compact，cc-node 回答：
 *   "Context within window (719483/937500 tokens), no compression needed"
 *
 * 两个根因：
 *   ① **估算口径漏项**：estimateMessages(state.messages) 不含 systemPrompt 与
 *      tools schema（每轮都发送、几万 token），且启发式字符/token 比例与真实
 *      tokenizer 有系统性偏差（本例低估 27%）。
 *   ② **超窗无自愈**：400 直接抛给用户，明明响应体里有真实 token 数却用不上。
 *
 * 本测试锁死：
 *   A. calibrate() 用服务端 usage 修正估算（首次直接采用 + EMA + 拒绝离谱样本）
 *   B. 估算口径包含 systemPrompt + tools schema
 *   C. 能识别各厂商的"超窗"报错文案并解析出真实 token 数
 *   D. 400 超窗 → 自动压缩 → 重建请求 → 重试成功（用户看不到 400）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { QueryEngine } from '../core/query-engine.js'
import { TokenBudget } from '../core/token-budget.js'

// ---------------------------------------------------------------- A. 校准

test('校准：首次样本直接采用（不做 EMA 稀释）', () => {
  const tb = new TokenBudget({ maxTokens: 1000 })
  assert.equal(tb.calibrationFactor, 1)
  const f = tb.calibrate(1500, 1000)   // 服务端比估算高 50%
  assert.equal(f, 1.5)
  assert.equal(tb.calibrationSamples, 1)
})

test('校准：后续样本按 EMA(0.5) 平滑，不会被单次抖动带飞', () => {
  const tb = new TokenBudget({ maxTokens: 1000 })
  tb.calibrate(1500, 1000)            // → 1.5
  const f = tb.calibrate(1000, 1000)  // 比值 1.0 → 1.5*0.5 + 1.0*0.5 = 1.25
  assert.equal(f, 1.25)
})

test('校准：拒绝离谱样本（比值 <0.4 或 >8），保护系数不被污染', () => {
  const tb = new TokenBudget({ maxTokens: 1000 })
  assert.equal(tb.calibrate(10, 1000), 1)        // 比值 0.01 → 忽略（<0.5）
  assert.equal(tb.calibrate(99999, 1000), 1)     // 比值 ~100 → 忽略（>6）
  assert.equal(tb.calibrationSamples, 0)
})

test('校准：非法入参（0/负数/NaN）直接忽略，不抛错', () => {
  const tb = new TokenBudget({ maxTokens: 1000 })
  assert.equal(tb.calibrate(0, 1000), 1)
  assert.equal(tb.calibrate(100, 0), 1)
  assert.equal(tb.calibrate(NaN, 1000), 1)
})

test('校准：系数被夹紧到 [0.5, 3]，避免过度压缩历史', () => {
  const tb = new TokenBudget({ maxTokens: 1000 })
  tb.calibrate(9000, 1000)   // 比值 9 → 被拒
  assert.equal(tb.calibrationFactor, 1)
  tb.calibrate(3000, 1000)   // 比值 3 → 采用
  assert.equal(tb.calibrationFactor, 3)
  tb.calibrate(6000, 1000)   // 比值 6 → 被拒（>6 是严格大于，6 边界）
  assert.ok(tb.calibrationFactor <= 3)
})

test('estimateMessagesCalibrated：应用系数并向上取整', () => {
  const tb = new TokenBudget({ maxTokens: 1000 })
  tb.calibrate(1372, 1000)   // 系数 1.372
  const msgs = [{ role: 'user', content: 'a'.repeat(400) }]  // ≈ 110 tokens(含 +10)
  const raw = tb.estimateMessages(msgs)
  assert.equal(tb.estimateMessagesCalibrated(msgs), Math.ceil(raw * 1.372))
})

// ---------------------------------------------------------------- B. 估算口径

test('估算口径：必须计入 systemPrompt 与 tools schema（旧实现漏算）', () => {
  const engine = new QueryEngine({
    apiKey: 'test', apiBase: 'https://api.test/v1', model: 'test',
    tools: [{ name: 'bash', description: 'run shell', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } }],
    systemPrompt: '你是助手。'.repeat(200),
    tokenBudget: new TokenBudget({ maxTokens: 100000 }),
  })
  const onlyMessages = engine.tokenBudget.estimateMessages(engine.state.messages)
  const withOverhead = engine._estimateContextTokens([])
  assert.ok(withOverhead > onlyMessages, 'tool+schema 开销必须被计入')
  // 静态开销应稳定（缓存命中后一致）
  assert.equal(engine._estimateContextTokens([]), withOverhead)
})

test('估算口径：校准系数会放大整体估算', () => {
  const tb = new TokenBudget({ maxTokens: 100000 })
  const engine = new QueryEngine({
    apiKey: 'test', apiBase: 'https://api.test/v1', model: 'test',
    tools: [], systemPrompt: 'SYS', tokenBudget: tb,
  })
  const base = engine._estimateContextTokens([{ role: 'user', content: 'x'.repeat(4000) }])
  tb.calibrate(2000, 1000)   // 系数 2
  assert.equal(engine._estimateContextTokens([{ role: 'user', content: 'x'.repeat(4000) }]), base * 2)
})

// ---------------------------------------------------------------- C. 错误识别

/** 只借用错误识别/解析方法的最小对象 */
function grammar() {
  const engine = new QueryEngine({ apiKey: 't', apiBase: 'https://api.test/v1', model: 't', tools: [] })
  return engine
}

test('超窗识别：OpenAI / DeepSeek / Anthropic / 中文 各厂商文案', () => {
  const e = grammar()
  const samples = [
    "This model's maximum context length is 1048576 tokens. However, you requested 1049296 tokens (986796 in the messages, 62500 in the completion).",
    '{"error":{"type":"context_length_exceeded","message":"Please reduce the length of the messages."}}',
    'prompt is too long: 210000 tokens > 200000 maximum',
    '请求的上下文过长，超出模型最大长度',
  ]
  for (const s of samples) assert.equal(e._isContextOverflowError(s), true, s.slice(0, 40))
})

test('超窗识别：无关错误不得误判（否则会白白压缩、丢历史）', () => {
  const e = grammar()
  const samples = [
    'API 错误 401: invalid api key',
    'API 错误 400: invalid content type for image',
    'API 错误 429: rate limit exceeded',
    'API 错误 500: internal error',
  ]
  for (const s of samples) assert.equal(e._isContextOverflowError(s), false, s)
})

test('解析真实 token 数：优先 "in the messages"（输入部分）', () => {
  const e = grammar()
  assert.equal(
    e._parseOverflowActualTokens(
      "maximum context length is 1048576 tokens. However, you requested 1049296 tokens (986796 in the messages, 62500 in the completion)."
    ),
    986796
  )
  // 无 messages 明细 → 退化为 requested 总数
  assert.equal(e._parseOverflowActualTokens('requested 210000 tokens'), 210000)
  // 完全解析不到 → 0（调用方据此跳过强校）
  assert.equal(e._parseOverflowActualTokens('prompt is too long'), 0)
})

// ---------------------------------------------------------------- D. 端到端自愈

/**
 * 构造可命中 _callLLM 的引擎（非流式），并替换 global.fetch 模拟
 * 「第一次 400 超窗 → 第二次 200 成功」。
 */
function makeE2E({ overflowText, maxTokens = 2000 } = {}) {
  const engine = new QueryEngine({
    apiKey: 'test-key', apiBase: 'https://api.test/v1', model: 'test-model',
    noStream: true, tools: [], systemPrompt: 'SYS',
    tokenBudget: new TokenBudget({ maxTokens, reservedForOutput: 200 }),
  })
  // 塞入足够多的历史，确保强制压缩有东西可压
  for (let i = 0; i < 40; i++) {
    engine.state.messages.push({ role: 'user', content: `第 ${i} 轮提问：` + '内容'.repeat(60) })
    engine.state.messages.push({ role: 'assistant', content: `第 ${i} 轮回答：` + '结果'.repeat(60) })
  }
  return engine
}

test('端到端：400 超窗 → 自动压缩并重试成功，用户看不到 400', async () => {
  const overflow = "This model's maximum context length is 3000 tokens. However, you requested 3200 tokens (2600 in the messages, 600 in the completion)."
  const engine = makeE2E({ overflowText: overflow, maxTokens: 3000 })

  const origFetch = global.fetch
  let calls = 0
  const sentBodies = []
  global.fetch = async (url, opts) => {
    calls++
    sentBodies.push(JSON.parse(opts.body))
    if (calls === 1) {
      return {
        ok: false, status: 400,
        text: async () => overflow,
      }
    }
    return {
      ok: true, status: 200,
      json: async () => ({
        choices: [{ message: { role: 'assistant', content: '已压缩后正常回复' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1800, completion_tokens: 20 },
      }),
    }
  }

  try {
    const messages = engine._buildRequest(engine.state.messages)
    const result = await engine._callLLM(messages, engine.state.messages)

    assert.equal(calls, 2, '必须重试一次（400 → 压缩 → 再发）')
    assert.equal(result.content, '已压缩后正常回复', '400 不应抛给用户')
    // 第二次请求的消息数必须少于第一次（确实压缩了）
    assert.ok(sentBodies[1].messages.length < sentBodies[0].messages.length, '重试请求体必须已压缩')
    // 校准系数被服务端真值强校过（2600 / 本地估算）
    assert.ok(engine.tokenBudget.calibrationFactor > 1.0, '校准系数应被真值拉高')
    assert.equal(engine.tokenBudget.calibrationSamples, 1)
  } finally {
    global.fetch = origFetch
  }
})

test('端到端：压缩后仍超窗时只自愈一次，不会无限重试', async () => {
  const overflow = 'context_length_exceeded: reduce the length of the messages'
  const engine = makeE2E({ overflowText: overflow, maxTokens: 3000 })

  const origFetch = global.fetch
  let calls = 0
  global.fetch = async () => {
    calls++
    return { ok: false, status: 400, text: async () => overflow }
  }
  try {
    await assert.rejects(
      () => engine._callLLM(engine._buildRequest(engine.state.messages), engine.state.messages),
      /API 错误 400/
    )
    assert.equal(calls, 2, '自愈只做一次：首次请求 + 一次压缩重试')
  } finally {
    global.fetch = origFetch
  }
})

test('端到端：成功响应会用 usage.prompt_tokens 校准估算', async () => {
  const engine = makeE2E({ maxTokens: 100000 })
  const origFetch = global.fetch
  global.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 999999, completion_tokens: 5 },   // 离谱值应被拒
    }),
  })
  try {
    await engine._callLLM(engine._buildRequest(engine.state.messages), engine.state.messages)
    // 999999 / 几千 ≈ 几百倍，超出可信区间 → 系数保持不变
    assert.equal(engine.tokenBudget.calibrationFactor, 1)
    assert.equal(engine.tokenBudget.calibrationSamples, 0)
  } finally {
    global.fetch = origFetch
  }
})
