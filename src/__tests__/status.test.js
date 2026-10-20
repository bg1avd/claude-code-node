/**
 * /status 汇总报告测试（v3.6.19）
 *
 * 背景（用户诉求）：原 /status 只报版本/uptime/PID，连"现在用什么模型、什么 apiBase"
 * 都没有，更别说新加的思考开关、窗口大小、当前上下文长度。
 *
 * 本测试锁死：
 *   ① 报告必须覆盖各组：进程 / 模型接口 / 思考深度 / 上下文 / 工具循环 / 会话 / 键位 / 费用
 *   ② **被配置改过的参数必须显示出来并标注来源**（这是"报全"的核心）
 *   ③ API Key 必须脱敏，绝不能把完整 key 打进状态里（会被 Telegram 转发出去）
 *   ④ 与 Telegram 共用同一实现（同一函数，不重复拼字符串）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildStatus, buildStatusSummary } from '../core/status.js'

/** 造一个最小可用的 engine 假体 */
function makeEngine(overrides = {}) {
  const cfg = {
    model: 'deepseek-flash',
    apiBase: 'https://api.deepseek.com/v1',
    apiKey: 'TESTKEY-0123456789-ABCDEFGH',  // 故意不含 sk-/ghp_ 等真实前缀，避免安全钩子误报
    maxTurns: 0,
    permissionMode: 'ask',
    autoCompact: true,
    autoContinue: true,
    compressSafetyFactor: 0.85,
    thinking: { mode: 'auto', effort: '', budgetTokens: 0 },
    keybindings: {},
    softkeys: true,
    noStream: false,
    maxMessages: 0,
    maxOutputTokens: 0,
    ...overrides,
  }
  return {
    config: cfg,
    state: { messages: [{ role: 'user', content: 'hi' }], turnCount: 3 },
    tokenBudget: {
      maxTokens: 128000,
      inputTokens: 0,
      reservedForOutput: 8000,
      calibrationFactor: 1,
      calibrationSamples: 0,
      estimateMessages: () => 12345,
      calibrate(actual, estimated) {
        this.calibrationFactor = actual / estimated
        this.calibrationSamples++
        return this.calibrationFactor
      },
    },
    costTracker: {
      totalApiCalls: 4,
      totalInputTokens: 1000,
      totalOutputTokens: 2000,
      totalReasoningTokens: 1500,
      getTotalCost: () => ({ total: 0.0123 }),
    },
    _computeMaxOutputTokens: () => 8000,
  }
}

const base = (engine, extra = {}) => buildStatus({
  engine,
  session: { id: 'session-abc', title: '测试会话', messages: [1, 2, 3] },
  version: '3.6.19',
  windowSource: 'table',
  cwd: '/tmp/proj',
  channels: { telegram: {} },
  defaultChannel: 'telegram',
  uptimeSec: 3725,
  ...extra,
})

test('报告覆盖全部必需分组', () => {
  const s = base(makeEngine())
  for (const sec of ['【进程】', '【模型 / 接口】', '【思考深度】', '【上下文】', '【工具循环】', '【会话】', '【终端 / 键位】', '【通道】', '【费用（本次会话累计）】']) {
    assert.ok(s.includes(sec), `缺少分组 ${sec}`)
  }
})

test('必须报出模型名与 API Base（原 /status 的最大缺口）', () => {
  const s = base(makeEngine())
  assert.match(s, /模型\s+: deepseek-flash/)
  assert.match(s, /API Base\s+: https:\/\/api\.deepseek\.com\/v1/)
})

test('API Key 必须脱敏 —— 绝不出现完整 key', () => {
  const engine = makeEngine()
  const key = engine.config.apiKey
  const s = base(engine)
  assert.ok(!s.includes(key), '完整 key 不得出现在状态里')
  // 期望形态：首4…末4（按 key 自身推导，避免硬编码漂移）
  assert.ok(s.includes(`${key.slice(0, 4)}…${key.slice(-4)}`), '应显示首4末4')
})

test('思考深度：报模式、深度、提供商与实际发送参数', () => {
  const s = base(makeEngine({ thinking: { mode: 'on', effort: 'medium', budgetTokens: 0 } }))
  assert.match(s, /模式\s+: on/)
  assert.match(s, /深度\s+: medium/)
  assert.match(s, /提供商\s+: DeepSeek/)
  assert.match(s, /实发参数\s+: \{"reasoning_effort":"medium","thinking":\{"type":"enabled"\}\}/)
})

test('思考深度：请求值被厂商裁剪时显示"→ 实际"', () => {
  // Kimi 只认 low/high/max → medium 会被裁到 high
  const s = base(makeEngine({
    model: 'kimi-k3', apiBase: 'https://api.moonshot.cn/v1',
    thinking: { mode: 'on', effort: 'medium', budgetTokens: 0 },
  }))
  assert.match(s, /深度\s+: medium → 实际 high/)
})

test('上下文：报窗口大小、来源、已用 tokens 与占比、压缩触发点', () => {
  const s = base(makeEngine())
  assert.match(s, /窗口\s+: 128\.0K \(内置模型表\)/)
  assert.match(s, /已用\s+: 12,345 tokens \(10% of window\)/)
  // 压缩触发点口径 = (窗口 - 输出预留) × safetyFactor = (131072 - 8000) × 0.85 = 102,000
  // （旧实现误用 窗口 × ratio = 108,800，忽略了输出预留）
  assert.match(s, /压缩触发\s+: 102,000 \(85% of 可用 120\.0K\)/)
  // 校准系数可见（尚未收到服务端 usage 时显示 ×1.000）
  assert.match(s, /估算校准\s+: ×1\.000/)
})

test('上下文：校准系数被服务端 usage 修正后会显示实际倍率', () => {
  const engine = makeEngine()
  engine.tokenBudget.calibrate(1500, 1000)   // 实际比估算高 50%
  const s = base(engine)
  assert.match(s, /估算校准\s+: ×1\.500（服务端 usage 校正 1 次/)
})

test('工具循环：报轮数上限与止损机制', () => {
  const s = base(makeEngine({ maxTurns: 20 }))
  assert.match(s, /轮数上限\s+: 20/)
  const s2 = base(makeEngine({ maxTurns: 0 }))
  assert.match(s2, /轮数上限\s+: 0（不限制）/)
})

test('被配置改过的参数 → 标注来源（用户诉求：改过的都要看得见）', () => {
  const engine = makeEngine({ maxTurns: 20, thinking: { mode: 'on', effort: 'high', budgetTokens: 0 } })
  const fakeConfig = {
    keySource: (k) => ({ maxTurns: 'user', thinking: 'user' }[k] || null),
    get: (k) => ({ maxBudgetTokens: 200000, sessionsDir: '/tmp/s' }[k]),
  }
  const s = buildStatus({
    engine, config: fakeConfig, version: 'x', session: { id: 's1', messages: [] }, uptimeSec: 1,
  })
  assert.match(s, /轮数上限\s+: 20\s+\[已改 · 用户级配置\]/)
  assert.match(s, /模式\s+: on（开启）\s+\[已改 · 用户级配置\]/)
})

test('默认值不标注 [已改]', () => {
  const engine = makeEngine()
  const fakeConfig = { keySource: () => null, get: () => undefined }
  const s = buildStatus({ engine, config: fakeConfig, version: 'x', uptimeSec: 1 })
  assert.doesNotMatch(s, /\[已改/)
})

test('自动压缩关闭时明确写出，不写成 0% 触发', () => {
  const s = base(makeEngine({ autoCompact: false }))
  assert.match(s, /自动压缩\s+: 关闭/)
  assert.match(s, /压缩触发\s+: 已关闭/)
})

test('费用段：含调用次数、token，并单独列出思考 token', () => {
  const s = base(makeEngine())
  assert.match(s, /API 调用\s+: 4 次/)
  assert.match(s, /思考 1,500/)
  assert.match(s, /估算费用\s+: \$0\.0123/)
})

test('uptime 人性化；extra 行被追加', () => {
  const s = base(makeEngine(), { extra: ['【通道状态】', '  运行中'] })
  assert.match(s, /已运行\s+: 1h 2m 5s/)
  assert.ok(s.trimEnd().endsWith('  运行中'))
})

test('无 tokenBudget / costTracker 时不崩（字段可选）', () => {
  const e = makeEngine()
  delete e.tokenBudget
  delete e.costTracker
  const s = buildStatus({ engine: e, version: 'x', uptimeSec: 1 })
  assert.match(s, /【模型 \/ 接口】/)
  assert.doesNotMatch(s, /【上下文】/)
})

test('buildStatusSummary：单行摘要含模型与思考', () => {
  const s = buildStatusSummary({ engine: makeEngine({ thinking: { mode: 'on', effort: 'high' }, maxTurns: 20 }), version: '3.6.19' })
  assert.match(s, /v3\.6\.19/)
  assert.match(s, /deepseek-flash/)
  assert.match(s, /on\/high/)
  assert.match(s, /20/)
})

test('运行时改过的思考设置也要标 [已改]（keySource 只记录启动时加载的配置）', () => {
  // 模拟 /thinking on high 之后：keySource 为 null，但值已非默认
  const engine = makeEngine({ thinking: { mode: 'on', effort: 'high', budgetTokens: 0 } })
  const fakeConfig = { keySource: () => null, get: () => undefined }
  const s = buildStatus({ engine, config: fakeConfig, version: 'x', uptimeSec: 1 })
  assert.match(s, /模式\s+: on（开启）\s+\[已改\]/)
})

test('思考保持默认时不标 [已改]', () => {
  const s = buildStatus({
    engine: makeEngine({ thinking: { mode: 'auto', effort: '', budgetTokens: 0 } }),
    config: { keySource: () => null, get: () => undefined }, version: 'x', uptimeSec: 1,
  })
  assert.match(s, /模式\s+: auto → off（关闭）\n/)
})

// ---------- Telegram /status 复用同一实现（不允许两个入口各拼一套）----------

test('Telegram /status 走 buildStatus：注入 runtime 后报全（含模型与思考）', async () => {
  const { TelegramListener } = await import('../channel/tg-listener.js')
  const l = new TelegramListener({ channels: { telegram: { token: 'x' } } })
  l._findCcNode = async () => ({ running: false })     // 不打桩就会去读真实 pid 文件
  l.setRuntimeProvider(() => ({
    engine: makeEngine({ thinking: { mode: 'on', effort: 'high', budgetTokens: 0 } }),
    session: { id: 's', messages: [] },
    config: { keySource: () => null, get: () => undefined },
    version: '3.6.19', cwd: '/tmp',
  }))
  const out = await l._handleCommand(1, '/status', {})
  l.conversations.destroy()      // 收尾：清掉内部清理定时器（unref 后已不影响退出，双保险）
  assert.match(out, /【模型 \/ 接口】/)
  assert.match(out, /deepseek-flash/)
  assert.match(out, /【思考深度】/)
  assert.match(out, /reasoning_effort/)
  assert.match(out, /【上下文】/)
  assert.match(out, /【通道状态】/)
})

test('Telegram /status：拿不到引擎（独立 daemon）→ 退精简版并说明原因', async () => {
  const { TelegramListener } = await import('../channel/tg-listener.js')
  const l = new TelegramListener({ channels: { telegram: { token: 'x' } } })
  l._findCcNode = async () => ({ running: false })
  const out = await l._handleCommand(1, '/status', {})
  l.conversations.destroy()
  assert.match(out, /PID/)
  assert.doesNotMatch(out, /【思考深度】/)
  assert.match(out, /未持有引擎/)
})

test('回归：ConversationState 的清理定时器必须 unref（否则吊住进程退出）', async () => {
  const { TelegramListener } = await import('../channel/tg-listener.js')
  const l = new TelegramListener({ channels: { telegram: { token: 'x' } } })
  const t = l.conversations._cleanupTimer
  assert.ok(t, '应有清理定时器')
  // Node 的 Timeout 对象在 unref 后 hasRef() 为 false
  assert.equal(typeof t.hasRef, 'function', '应是 Node Timeout 对象')
  assert.equal(t.hasRef(), false, '必须 unref —— 否则任何引入本模块的短命进程都退不出去')
  l.conversations.destroy()
})
