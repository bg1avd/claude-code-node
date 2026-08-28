/**
 * 小模型适配层 (small-model.js) 测试
 *
 * 验证：
 *   - 敷衍输出检测（isFillerResponse）：空话/太短/命中占位句识别
 *   - 意图识别（detectIntent）：写文件/找文件/跑命令/改代码等映射
 *   - 意图引导（buildIntentGuidance）：生成注入的引导文本
 *   - 工具精简（selectRelevantTools）：按意图筛选核心工具
 *   - system prompt 强化（buildSmallModelSystemPrompt）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isFillerResponse,
  detectIntent,
  buildIntentGuidance,
  selectRelevantTools,
  buildSmallModelSystemPrompt,
  SMALL_MODEL_SYSTEM_PROMPT,
  isSmallModelEnabled,
  buildMultiStepPlan,
  buildCombinedGuidance,
} from '../core/small-model.js'

// ---- 敷衍输出检测 ----
test('敷衍检测：命中空话占位句', () => {
  assert.equal(isFillerResponse({ content: 'Solved by sharing best practices.', toolCalls: [] }), true)
  assert.equal(isFillerResponse({ content: 'Done. This is the kind of mistake that costs real money.', toolCalls: [] }), true)
  assert.equal(isFillerResponse({ content: 'Let me think about this.', toolCalls: [] }), true)
})

test('敷衍检测：空回复/太短', () => {
  assert.equal(isFillerResponse({ content: '', toolCalls: [] }), true)
  assert.equal(isFillerResponse({ content: '  ', toolCalls: [] }), true)
  assert.equal(isFillerResponse({ content: 'ok', toolCalls: [] }), true)
  assert.equal(isFillerResponse({ content: '好的', toolCalls: [] }), true)
})

test('敷衍检测：有工具调用不算敷衍', () => {
  assert.equal(isFillerResponse({ content: 'ok', toolCalls: [{ id: '1' }] }), false)
})

test('敷衍检测：正常实质回答不算敷衍', () => {
  const content = '我已经分析了项目结构，发现3个主要模块需要重构，分别是订单、行情和风控模块，建议先处理订单模块。'
  assert.equal(isFillerResponse({ content, toolCalls: [] }), false)
})

// ---- 意图识别 ----
test('意图识别：写文档任务', () => {
  const r = detectIntent('做好开发计划文档')
  assert.ok(r, '应识别到意图')
  assert.ok(r.toolHint.includes('Write'), '应提示用 Write 工具')
  const r2 = detectIntent('把你的计划写入文档')
  assert.ok(r2 && r2.toolHint.includes('Write'))
})

test('意图识别：阅读文档是读取任务（不误判为写）', () => {
  const r = detectIntent('阅读DEVELOPMENT_PLAN.md文档')
  assert.ok(r, '应识别到意图')
  assert.ok(r.toolHint.includes('Read'), '应提示用 Read')
  assert.ok(!r.toolHint.includes('Write'), '读取任务不应提示 Write')
})

test('意图识别：找文件任务', () => {
  const r = detectIntent('查找src目录下的文件')
  assert.ok(r && r.toolHint.includes('Glob'))
  assert.ok(r.toolHint.includes('Grep'))
})

test('意图识别：跑命令任务', () => {
  const r = detectIntent('运行一下测试')
  assert.ok(r && r.toolHint.includes('Bash'))
})

test('意图识别：改代码任务', () => {
  const r = detectIntent('修复这个bug')
  assert.ok(r && r.toolHint.includes('Edit'))
})

test('意图识别：联网搜索任务', () => {
  const r = detectIntent('搜索一下最新的量化交易资料')
  assert.ok(r && r.toolHint.includes('WebSearch'))
})

test('意图识别：无匹配返回 null', () => {
  assert.equal(detectIntent('你好'), null)
  assert.equal(detectIntent(''), null)
})

// ---- 意图引导 ----
test('意图引导：生成注入文本', () => {
  const g = buildIntentGuidance('做好开发计划文档', { enable: true })
  assert.ok(g, '应生成引导')
  assert.ok(g.includes('Write'), '引导应包含工具建议')
  assert.ok(g.includes('任务引导'), '应有引导标记')
})

test('意图引导：未启用或未匹配返回 null', () => {
  assert.equal(buildIntentGuidance('做好开发计划文档', { enable: false }), null)
  assert.equal(buildIntentGuidance('你好', { enable: true }), null)
})

// ---- 工具精简 ----
const fakeTools = [
  { name: 'Bash', description: 'd' },
  { name: 'Read', description: 'd' },
  { name: 'Edit', description: 'd' },
  { name: 'Write', description: 'd' },
  { name: 'Glob', description: 'd' },
  { name: 'Grep', description: 'd' },
  { name: 'WebSearch', description: 'd' },
  { name: 'WebFetch', description: 'd' },
  { name: 'GitTool', description: 'd' },
  { name: 'NpmPublish', description: 'd' },
]

test('工具精简：按意图保留相关工具', () => {
  const reduced = selectRelevantTools(fakeTools, '做好开发计划文档', { enable: true })
  assert.ok(reduced.length < fakeTools.length, '应精简工具数量')
  assert.ok(reduced.some(t => t.name === 'Write'), '应保留 Write')
  // 不相关的如 NpmPublish 不应保留
  assert.ok(!reduced.some(t => t.name === 'NpmPublish'), '不应保留无关工具')
})

test('工具精简：未启用返回全部', () => {
  assert.equal(selectRelevantTools(fakeTools, 'xx', { enable: false }), fakeTools)
})

test('工具精简：无明确意图时返回核心文件工具', () => {
  const reduced = selectRelevantTools(fakeTools, '你好', { enable: true })
  assert.ok(reduced.length <= 6, '应只保留核心工具')
  assert.ok(reduced.some(t => t.name === 'Bash'))
})

// ---- system prompt 强化 ----
test('system prompt 强化：追加工具使用铁律', () => {
  const base = 'You are cc-node.'
  const enhanced = buildSmallModelSystemPrompt(base)
  assert.ok(enhanced.includes(base), '应保留基础 prompt')
  assert.ok(enhanced.includes('工具调用 Agent'), '应包含工具调用强化引导')
  assert.ok(enhanced.includes(SMALL_MODEL_SYSTEM_PROMPT), '应追加强化 prompt')
})

// ---- 开关判断 ----
test('小模型开关判断', () => {
  assert.equal(isSmallModelEnabled({ smallModel: true }), true)
  assert.equal(isSmallModelEnabled({ smallModel: false }), false)
  assert.equal(isSmallModelEnabled(undefined), false)
})

// ---- system prompt 注入 cwd ----
test('system prompt 强化：注入当前工作目录', () => {
  const base = 'You are cc-node.'
  const enhanced = buildSmallModelSystemPrompt(base, { cwd: 'D:\\workspace\\miniQMT-trader' })
  assert.ok(enhanced.includes('当前工作目录'), '应包含工作目录说明')
  assert.ok(enhanced.includes('miniQMT-trader'), '应包含实际 cwd 路径')
  assert.ok(enhanced.includes('不要猜测其它绝对路径'), '应提示不要瞎猜路径')
})

// ---- 多步计划拆解 ----
test('多步计划：识别"按计划实现"任务', () => {
  const r = buildMultiStepPlan('按计划实现第一阶段', { cwd: 'D:\\x' })
  assert.ok(r && r.isMultiStep, '应识别为多步任务')
  assert.ok(r.plan.includes('步骤 1'), '应有步骤 1')
  assert.ok(r.plan.includes('Read'), '步骤 1 应用 Read')
  assert.ok(r.plan.includes('DEVELOPMENT_PLAN.md'), '应引用计划文件')
})

test('多步计划：提取指令里的计划文件名', () => {
  const r = buildMultiStepPlan('实现DEV_PLAN.md里的第二阶段', { cwd: 'D:\\x' })
  assert.ok(r && r.plan.includes('DEV_PLAN.md'), '应提取指令中的计划文件名')
})

test('多步计划：非实现任务返回 null', () => {
  assert.equal(buildMultiStepPlan('阅读DEVELOPMENT_PLAN.md', { enable: true }), null)
  assert.equal(buildMultiStepPlan('你好', { enable: true }), null)
  assert.equal(buildMultiStepPlan('按计划实现第一阶段', { enable: false }), null)
})

test('多步计划：combined guidance 优先走多步拆解', () => {
  const g = buildCombinedGuidance('按计划实现第一阶段', { cwd: 'D:\\x', enable: true })
  assert.ok(g, '应生成引导')
  assert.ok(g.includes('多步执行计划'), '应走多步计划')
  assert.ok(g.includes('步骤 1'), '应包含步骤引导')
})

test('多步计划：普通任务走简单意图引导', () => {
  const g = buildCombinedGuidance('阅读DEVELOPMENT_PLAN.md文档', { cwd: 'D:\\x', enable: true })
  assert.ok(g, '应生成引导')
  assert.ok(g.includes('任务引导'), '应走简单意图引导')
})

// ---- 动态 max_tokens 计算 ----
test('max_tokens：根据窗口大小动态计算', async () => {
  const { QueryEngine } = await import('../core/query-engine.js')
  const { TokenBudget } = await import('../core/token-budget.js')
  // 131072 窗口 → 8192（窗口的 1/16）
  const qe1 = new QueryEngine({ tokenBudget: new TokenBudget({ maxTokens: 131072 }) })
  assert.equal(qe1._computeMaxOutputTokens(), 8192)
  // 65536 → 4096
  const qe2 = new QueryEngine({ tokenBudget: new TokenBudget({ maxTokens: 65536 }) })
  assert.equal(qe2._computeMaxOutputTokens(), 4096)
  // 无窗口 → 兜底 4096
  const qe3 = new QueryEngine({})
  assert.equal(qe3._computeMaxOutputTokens(), 4096)
})

test('max_tokens：可配置输出比例与下限覆盖', async () => {
  const { QueryEngine } = await import('../core/query-engine.js')
  const { TokenBudget } = await import('../core/token-budget.js')
  // outputRatio=0.1 → 131072*0.1=13107
  const qe1 = new QueryEngine({ tokenBudget: new TokenBudget({ maxTokens: 131072 }), outputRatio: 0.1 })
  assert.equal(qe1._computeMaxOutputTokens(), 13107)
  // maxOutputTokens=8192 作为下限
  const qe2 = new QueryEngine({ tokenBudget: new TokenBudget({ maxTokens: 131072 }), maxOutputTokens: 8192 })
  assert.equal(qe2._computeMaxOutputTokens(), 8192)
})

test('max_tokens：绝不超过窗口一半（防超窗）', async () => {
  const { QueryEngine } = await import('../core/query-engine.js')
  const { TokenBudget } = await import('../core/token-budget.js')
  // 小窗口 8192：窗口一半 = 4096，1/16 = 512，取 max(4096,512)=4096 ≤ 4096
  const qe1 = new QueryEngine({ tokenBudget: new TokenBudget({ maxTokens: 8192 }) })
  assert.ok(qe1._computeMaxOutputTokens() <= 4096, `max_tokens=${qe1._computeMaxOutputTokens()} 不应超过窗口一半 4096`)
  // 极端 outputRatio=1.0 也不应超过窗口一半
  const qe2 = new QueryEngine({ tokenBudget: new TokenBudget({ maxTokens: 10000 }), outputRatio: 1.0 })
  assert.ok(qe2._computeMaxOutputTokens() <= 5000, `max_tokens=${qe2._computeMaxOutputTokens()} 不应超过窗口一半 5000`)
})

// ---- _buildRequest 把 system 统一前置（防 llama.cpp 500）----
test('_buildRequest：把中间 system 统一前置到开头', async () => {
  const { QueryEngine } = await import('../core/query-engine.js')
  const qe = new QueryEngine({ systemPrompt: 'SYS-ROOT', tools: [] })
  // 模拟 state.messages 里 system 摘要被插到中间（折叠/恢复导致）
  const messages = [
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: 'a1' },
    { role: 'system', content: '[Context Summary] 中间摘要' },
    { role: 'user', content: 'u2' },
  ]
  const req = qe._buildRequest(messages)
  // 验证：所有 system 在开头，中间无 system
  let seenBody = false, badSystem = false
  for (const m of req) {
    if (m.role !== 'system') seenBody = true
    else if (seenBody) badSystem = true
  }
  assert.equal(badSystem, false, '中间不应出现 system（否则 llama.cpp 报 500）')
  // 第一条是 system
  assert.equal(req[0].role, 'system')
  // 原始顺序（非 system 部分）应保持
  const nonSys = req.filter(m => m.role !== 'system').map(m => m.role)
  assert.deepEqual(nonSys, ['user', 'assistant', 'user'])
})
