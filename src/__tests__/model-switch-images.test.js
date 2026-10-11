/**
 * 「多模态发图 → 切纯文字模型 → 之后所有消息报错」修复测试（v3.6.14）
 *
 * 背景（真实的、被漏掉的路径）：
 *   v3.0.9 修过这个 bug，但**只加在 `/model <名称>` 一条路径上**。实际切换模型有 3 条：
 *     ① 终端 `/model <名称/编号>`      —— 修过 ✅
 *     ② Telegram `/models` → 回复编号  —— 漏了 ❌（遥控场景最常用，用户踩的就是它）
 *     ③ 终端 `/models` → 交互输入编号  —— 漏了 ❌
 *   走 ②③ 切到纯文字模型时，历史里的 `images` 没被剥离，之后**每条**消息都带
 *   image_url → 被 API 以 4xx 拒绝 → 用户感觉"换成非多模态模型就废了"。
 *
 * 本文件验证：
 *   A. stripImagesFromHistory 能清干净（images 字段 + content 数组两种形态）
 *   B. 兜底重试的**放宽判据**：错误文案不含 image 词（如 "invalid content type"），
 *      只要 4xx + 请求里确实有图，也会自动剥离并重试成功
 *   C. 没有图片时不得误触发（4xx 照常抛出）
 *   D. 防回归：cli.js 里不允许出现绕过 switchModelTo 的 `engine.config.model =`
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { QueryEngine, QueryEngineConfig } from '../core/query-engine.js'

const IMG = 'data:image/png;base64,AAAA'

function makeEngine() {
  const config = new QueryEngineConfig({
    model: 'text-only-model',
    apiBase: 'https://api.example.com/v1',
    apiKey: 'test-key',
    noStream: true,          // 走非流式解析，测试更简单
    tools: [],
    systemPrompt: '',
  })
  const engine = new QueryEngine(config)
  engine.abortController = new AbortController()
  return engine
}

/** 构造带图的请求体（模拟 _buildRequest 的产物） */
function buildMessagesWithImage() {
  return [
    { role: 'system', content: 'sys' },
    {
      role: 'user',
      content: [
        { type: 'text', text: '看看这张图' },
        { type: 'image_url', image_url: { url: IMG } },
      ],
    },
  ]
}

/** 安装假的 fetch，返回预设的错误/成功序列，并记录每次请求体 */
function installFetch(t, replies) {
  const calls = []
  let i = 0
  const orig = globalThis.fetch
  globalThis.fetch = async (url, opts) => {
    calls.push(JSON.parse(opts.body))
    const r = replies[Math.min(i++, replies.length - 1)]
    if (r.status !== 200) {
      return { ok: false, status: r.status, text: async () => r.body }
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ index: 0, message: { role: 'assistant', content: r.content ?? 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    }
  }
  t.after(() => { globalThis.fetch = orig })
  return calls
}

// ---------- A. 剥离能力 ----------

test('stripImagesFromHistory：清空 images 字段与 content 数组中的 image_url', () => {
  const engine = makeEngine()
  engine.state.messages.push({ role: 'user', content: 'hi', images: [IMG, IMG] })
  engine.state.messages.push({
    role: 'user',
    content: [{ type: 'text', text: 'x' }, { type: 'image_url', image_url: { url: IMG } }],
  })

  const removed = engine.stripImagesFromHistory()

  assert.equal(removed, 3, '应移除 3 张图（2 张 images 字段 + 1 张数组 part）')
  assert.deepEqual(engine.state.messages[0].images, [])
  assert.equal(engine.state.messages[1].content, 'x', '只剩单个 text part 时应简化回字符串')
})

// ---------- B. 放宽后的兜底重试 ----------

test('兜底：4xx 错误文案不含 image 词（"invalid content type"）也能自动剥离并恢复', async (t) => {
  const engine = makeEngine()
  engine.state.messages.push({ role: 'user', content: '看看这张图', images: [IMG] })

  const calls = installFetch(t, [
    { status: 400, body: '{"error":{"message":"invalid content type"}}' },  // ← 不含 image/vision
    { status: 200, content: '图我看过了 ✅' },
  ])

  const messages = buildMessagesWithImage()
  const res = await engine._callLLM(messages, engine.state.messages)

  assert.equal(res.content, '图我看过了 ✅', '剥离图片后重试应成功')
  assert.equal(calls.length, 2, '应恰好重试一次')
  assert.ok(JSON.stringify(calls[0]).includes('image_url'), '第一次请求确实带图')
  assert.ok(!JSON.stringify(calls[1]).includes('image_url'), '第二次请求必须已无图')
  assert.equal(engine.state.messages[0].images.length, 0, '会话历史里的图也应被清掉')
})

test('兜底：错误文本含 "图像"（中文，旧正则匹配不到）也能触发', async (t) => {
  const engine = makeEngine()
  engine.state.messages.push({ role: 'user', content: 'hi', images: [IMG] })
  const calls = installFetch(t, [
    { status: 400, body: '{"error":{"message":"该模型不支持图像输入"}}' },
    { status: 200, content: 'ok' },
  ])
  const res = await engine._callLLM(buildMessagesWithImage(), engine.state.messages)
  assert.equal(res.content, 'ok')
  assert.equal(calls.length, 2)
})

// ---------- C. 不误触发 ----------

test('兜底：请求里没有图片时，4xx 照常抛出（不得误吞错误）', async (t) => {
  const engine = makeEngine()
  installFetch(t, [{ status: 400, body: '{"error":{"message":"invalid content type"}}' }])

  const messages = [{ role: 'user', content: '纯文字' }]
  await assert.rejects(
    () => engine._callLLM(messages, engine.state.messages),
    /API 错误 400/,
  )
})

// ---------- D. 防回归：所有切模型入口都必须走统一 helper ----------

test('防回归：cli.js 中 engine.config.model 只能出现在 switchModelTo 内部', async () => {
  const src = await readFile(new URL('../core/cli.js', import.meta.url), 'utf8')
  const hits = src.split('\n')
    .map((line, idx) => ({ line, no: idx + 1 }))
    .filter(({ line }) => /engine\.config\.model\s*=/.test(line))

  assert.equal(
    hits.length, 1,
    `engine.config.model 赋值应只有 1 处（在 switchModelTo 内），实际 ${hits.length} 处：\n` +
    hits.map(h => `  第 ${h.no} 行: ${h.line.trim()}`).join('\n') +
    '\n（新增切模型路径请调用 switchModelTo()，它会统一剥离历史图片，否则会复现"切纯文字模型后全部报错"）',
  )
})

test('防回归：三条切模型路径都调用了 switchModelTo()', async () => {
  const src = await readFile(new URL('../core/cli.js', import.meta.url), 'utf8')
  const n = (src.match(/switchModelTo\(/g) || []).length
  // 1 处定义 + 3 处调用（/model、Telegram /models 编号选择、终端 /models 交互）
  assert.ok(n >= 4, `switchModelTo 应至少出现 4 次（1 定义 + 3 调用），实际 ${n} 次`)
})
