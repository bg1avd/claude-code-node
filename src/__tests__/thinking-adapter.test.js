/**
 * 思考深度适配层测试（v3.6.18）
 *
 * 背景：各家虽自称 "OpenAI 兼容"，但"怎么设置思考深度"各说各话 ——
 * 直接统一发 reasoning_effort 会给 Kimi（只认 low/high/max）、DeepSeek（只认
 * low/medium/high）等吃 400。本测试锁死：
 *   ① provider 识别（按 apiBase 优先、model 前缀兜底、网关优先于模型）
 *   ② 档位裁剪（取最接近，并列偏深）
 *   ③ 各 provider 构造出的参数**形状正确**
 *   ④ 未识别 provider → 什么都不发（保守）
 *   ⑤ auto 模式的历史兼容（DeepSeek 默认 off）
 *   ⑥ 关闭语义（Kimi 不支持关闭 → 不发参数且给出说明）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  detectProvider,
  clampEffort,
  buildThinkingParams,
  describeThinking,
  EFFORT_LADDER,
} from '../core/thinking-adapter.js'

// ---------- provider 识别 ----------

test('detectProvider: 按 apiBase 域名识别', () => {
  assert.equal(detectProvider({ apiBase: 'https://api.deepseek.com/v1', model: 'whatever' }), 'deepseek')
  assert.equal(detectProvider({ apiBase: 'https://api.moonshot.cn/v1', model: '' }), 'kimi')
  assert.equal(detectProvider({ apiBase: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: '' }), 'qwen')
  assert.equal(detectProvider({ apiBase: 'https://api.anthropic.com/v1', model: '' }), 'anthropic')
  assert.equal(detectProvider({ apiBase: 'https://open.bigmodel.cn/api/paas/v4', model: '' }), 'glm')
  assert.equal(detectProvider({ apiBase: 'https://api.z.ai/api/paas/v4', model: '' }), 'glm')
  assert.equal(detectProvider({ apiBase: 'https://api.openai.com/v1', model: '' }), 'openai')
})

test('detectProvider: 网关优先于模型名（OpenRouter 上挂 deepseek 也按 openrouter 处理）', () => {
  assert.equal(
    detectProvider({ apiBase: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-v3.2' }),
    'openrouter'
  )
})

test('detectProvider: apiBase 不认识时用 model 前缀兜底', () => {
  assert.equal(detectProvider({ apiBase: 'http://127.0.0.1:11434/v1', model: 'qwen3:8b' }), 'qwen')
  assert.equal(detectProvider({ apiBase: 'http://127.0.0.1:8080/v1', model: 'glm-4.6' }), 'glm')
  assert.equal(detectProvider({ apiBase: 'http://127.0.0.1:8080/v1', model: 'kimi-k2' }), 'kimi')
  assert.equal(detectProvider({ apiBase: 'http://127.0.0.1:8080/v1', model: 'claude-opus-5' }), 'anthropic')
  assert.equal(detectProvider({ apiBase: 'http://127.0.0.1:8080/v1', model: 'deepseek-r1' }), 'deepseek')
})

test('detectProvider: 都不认识 → unknown（保守，不发参数）', () => {
  assert.equal(detectProvider({ apiBase: 'http://127.0.0.1:11434/v1', model: 'llama3.1:8b' }), 'unknown')
  assert.equal(detectProvider({}), 'unknown')
})

// ---------- 档位裁剪 ----------

test('clampEffort: 允许集合包含时原样返回', () => {
  assert.equal(clampEffort('high', ['low', 'high', 'max']), 'high')
})

test('clampEffort: 不在集合时取阶梯上最接近的一档', () => {
  // Kimi 只认 low(2)/high(4)/max(6)；请求 none(0) → 最近是 low
  assert.equal(clampEffort('none', ['low', 'high', 'max']), 'low')
  // 请求 minimal(1) → 最近是 low(2)
  assert.equal(clampEffort('minimal', ['low', 'high', 'max']), 'low')
  // 请求 xhigh(5) → 距 high(4)=1、距 max(6)=1，并列 → 偏深 → max
  assert.equal(clampEffort('xhigh', ['low', 'high', 'max']), 'max')
})

test('clampEffort: 距离并列时取更深的一档', () => {
  // medium(3) 距 low(2)=1、距 high(4)=1 → 并列 → high
  assert.equal(clampEffort('medium', ['low', 'high']), 'high')
})

test('clampEffort: allowed 为空 → null（该 provider 不支持深度）', () => {
  assert.equal(clampEffort('high', []), null)
  assert.equal(clampEffort('high', null), null)
})

// ---------- 各 provider 参数形状 ----------

const DS = { apiBase: 'https://api.deepseek.com/v1', model: 'deepseek-flash' }

test('DeepSeek: on → reasoning_effort(low/medium/high 裁剪) + thinking.enabled', () => {
  const r = buildThinkingParams({ mode: 'on', effort: 'minimal', ...DS })
  // minimal(1) 不在 [low,medium,high] → 最近 low(2)
  assert.equal(r.resolvedEffort, 'low')
  assert.equal(r.params.reasoning_effort, 'low')
  assert.deepEqual(r.params.thinking, { type: 'enabled' })
})

test('DeepSeek: off → 只发 thinking.disabled（不发 reasoning_effort）', () => {
  const r = buildThinkingParams({ mode: 'off', ...DS })
  assert.deepEqual(r.params, { thinking: { type: 'disabled' } })
})

test('DeepSeek: auto → 默认 off（兼容历史行为）', () => {
  const r = buildThinkingParams({ mode: 'auto', ...DS })
  assert.deepEqual(r.params, { thinking: { type: 'disabled' } })
  assert.equal(r.mode, 'off')
  assert.match(r.note, /auto/)
})

test('Kimi: on → 只用 reasoning_effort，且裁剪到 low/high/max', () => {
  const r = buildThinkingParams({ mode: 'on', effort: 'high', apiBase: 'https://api.moonshot.cn/v1', model: 'kimi-k3' })
  assert.deepEqual(r.params, { reasoning_effort: 'high' })
  assert.equal(r.canDisable, false)
})

test('Kimi: off → 不支持关闭，不发参数但给出说明', () => {
  const r = buildThinkingParams({ mode: 'off', apiBase: 'https://api.moonshot.cn/v1', model: 'kimi-k3' })
  assert.deepEqual(r.params, {})
  assert.match(r.note, /不支持关闭/)
})

test('Kimi: auto → 不干预（返回空参数）', () => {
  const r = buildThinkingParams({ mode: 'auto', apiBase: 'https://api.moonshot.cn/v1', model: 'kimi-k3' })
  assert.deepEqual(r.params, {})
  assert.match(r.note, /不干预/)
})

test('Qwen: on → enable_thinking + thinking_budget（由 effort 推导）', () => {
  const r = buildThinkingParams({
    mode: 'on', effort: 'medium',
    apiBase: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen3-max',
  })
  assert.equal(r.params.enable_thinking, true)
  assert.equal(r.params.thinking_budget, 4096)
  // 预算会计入 max_tokens → 必须回传最小输出余量，供调用方抬高上限
  assert.equal(r.minOutputTokens, 4096)
})

test('Qwen: 显式 budgetTokens 优先于 effort 推导', () => {
  const r = buildThinkingParams({
    mode: 'on', effort: 'max', budgetTokens: 2000,
    apiBase: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen3-max',
  })
  assert.equal(r.params.thinking_budget, 2000)
})

test('Qwen: off → enable_thinking=false', () => {
  const r = buildThinkingParams({ mode: 'off', apiBase: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen3-max' })
  assert.deepEqual(r.params, { enable_thinking: false })
})

test('OpenAI: on → reasoning_effort 全 7 档不裁剪', () => {
  const r = buildThinkingParams({ mode: 'on', effort: 'xhigh', apiBase: 'https://api.openai.com/v1', model: 'gpt-6-astra' })
  assert.deepEqual(r.params, { reasoning_effort: 'xhigh' })
})

test('OpenAI: off → reasoning_effort=none', () => {
  const r = buildThinkingParams({ mode: 'off', apiBase: 'https://api.openai.com/v1', model: 'gpt-6-astra' })
  assert.deepEqual(r.params, { reasoning_effort: 'none' })
})

test('Anthropic: on → output_config.effort', () => {
  const r = buildThinkingParams({ mode: 'on', effort: 'medium', apiBase: 'https://api.anthropic.com/v1', model: 'claude-opus-5' })
  assert.deepEqual(r.params, { output_config: { effort: 'medium' } })
})

test('GLM: 只支持开关，不支持档位 → 开启但无深度参数', () => {
  const r = buildThinkingParams({ mode: 'on', effort: 'high', apiBase: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5' })
  assert.deepEqual(r.params, { thinking: { type: 'enabled' } })
  assert.equal(r.resolvedEffort, null)
  assert.match(r.note, /只支持开关/)
})

test('OpenRouter: on → reasoning.effort（归一化字段）', () => {
  const r = buildThinkingParams({ mode: 'on', effort: 'minimal', apiBase: 'https://openrouter.ai/api/v1', model: 'google/gemini-3' })
  assert.deepEqual(r.params, { reasoning: { effort: 'minimal' } })
})

test('OpenRouter: off → reasoning.enabled=false', () => {
  const r = buildThinkingParams({ mode: 'off', apiBase: 'https://openrouter.ai/api/v1', model: 'google/gemini-3' })
  assert.deepEqual(r.params, { reasoning: { enabled: false } })
})

// ---------- 保守与边界 ----------

test('未知 provider: 任何模式都不发参数（宁可 400 也不瞎发）', () => {
  for (const mode of ['auto', 'off', 'on']) {
    const r = buildThinkingParams({ mode, effort: 'high', apiBase: 'http://127.0.0.1:11434/v1', model: 'llama3.1:8b' })
    assert.deepEqual(r.params, {}, `mode=${mode} 不应发参数`)
    assert.equal(r.supported, false)
  }
})

test('非法 mode 退化为 auto；非法 effort 退化为 medium', () => {
  const a = buildThinkingParams({ mode: 'nonsense', apiBase: 'https://api.openai.com/v1', model: 'gpt-6' })
  assert.equal(a.mode, 'auto')
  const b = buildThinkingParams({ mode: 'on', effort: 'nonsense', apiBase: 'https://api.openai.com/v1', model: 'gpt-6' })
  assert.equal(b.params.reasoning_effort, 'medium')
})

test('on 但未给 effort → 默认 medium（并按 provider 裁剪）', () => {
  assert.equal(buildThinkingParams({ mode: 'on', apiBase: 'https://api.openai.com/v1', model: 'gpt-6' }).params.reasoning_effort, 'medium')
  // Kimi: medium(3) → 并列 high/low → 偏深 → high
  assert.equal(buildThinkingParams({ mode: 'on', apiBase: 'https://api.moonshot.cn/v1', model: 'kimi-k3' }).params.reasoning_effort, 'high')
})

test('EFFORT_LADDER 顺序即"深度顺序"（clampEffort 依赖它）', () => {
  assert.deepEqual(EFFORT_LADDER, ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
})

test('describeThinking 输出包含关键字段（供 /thinking 展示）', () => {
  const info = buildThinkingParams({ mode: 'on', effort: 'medium', ...DS })
  const lines = describeThinking(info).join('\n')
  assert.match(lines, /Provider/)
  assert.match(lines, /Mode/)
  assert.match(lines, /Effort/)
  assert.match(lines, /reasoning_effort/)
})
