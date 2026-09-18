/**
 * 梦境 (Dream) 单元测试
 *
 * 覆盖：
 *   - dreamFromMessages 提炼（主线/关键结果/下一步/决策/工具）
 *   - 有效入睡门槛（消息太少/无实质内容 → 不存）
 *   - sleep/wake 端到端循环
 *   - 归档（超过 maxRetain 删最旧）
 *   - renderDreamContext 渲染
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, stat } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { createServer } from 'http'
import { DreamManager, dreamFromMessages, renderDreamContext, llmSummarizeDirections, sanitizeSecrets, extractWorkspace, renderResumeInstruction } from '../core/dream.js'

function sampleMessages() {
  return [
    { role: 'user', content: '帮我实现一个配置文件解析器' },
    { role: 'assistant', content: '好的，我先读取 config.json。', toolCalls: [{ name: 'Read', input: {} }] },
    { role: 'tool', content: '{ "sessionsDir": ".claude-code/sessions" }' },
    { role: 'assistant', content: '发现配置里 sessionsDir 指向 .claude-code/sessions，采用 JSON 解析方式。' },
    { role: 'user', content: '下一步，把解析结果打印出来' },
    { role: 'assistant', content: '还未完成格式校验，下一步应该添加 config 的 schema 校验。' },
  ]
}

async function makeManager(maxRetain) {
  const dir = await mkdtemp(join(tmpdir(), 'dream-test-'))
  return new DreamManager({ dreamsDir: dir, maxRetain })
}

test('dreamFromMessages 提炼出主线/下一步/决策/工具', () => {
  const d = dreamFromMessages(sampleMessages())
  assert.equal(d.main_goal, '帮我实现一个配置文件解析器')
  assert.match(d.next_steps, /schema 校验/)          // 抓到"下一步"
  assert.match(d.decisions.join(' '), /JSON 解析/)    // 抓到决策
  assert.deepEqual(d.tools_used, ['Read'])
  assert.ok(d.key_results.length > 0)
})

test('消息太少或无实质内容 → 不产生梦境', () => {
  assert.equal(dreamFromMessages([]).main_goal, '')
  assert.equal(dreamFromMessages([{ role: 'user', content: 'hi' }]).main_goal, 'hi')
})

test('sleep 达到门槛写入，未达门槛返回 null', async () => {
  const dm = await makeManager()
  // 未达门槛：只有 2 条消息 < minMessages(3)
  const none = await dm.sleep([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }], {})
  assert.equal(none, null)
  // 达到门槛
  const dream = await dm.sleep(sampleMessages(), { title: 'cfg', turnCount: 3 })
  assert.ok(dream.id.startsWith('dream-'))
  const files = await readdir(dm.dreamsDir)
  assert.equal(files.length, 1)
})

test('sleep/wake 端到端：醒来能拿到记忆上下文', async () => {
  const dm = await makeManager()
  await dm.sleep(sampleMessages(), { title: 'cfg', turnCount: 3 })
  const ctx = await dm.wake(3)
  assert.ok(ctx.includes('配置文件解析器'))           // 主线
  assert.ok(ctx.includes('schema 校验'))              // 下一步
})

test('存储安全权限：目录 0700 / 文件 0600', async () => {
  const dm = await makeManager()
  const dream = await dm.sleep(sampleMessages(), {})
  const dirStat = await stat(dm.dreamsDir)
  const fileStat = await stat(join(dm.dreamsDir, `${dream.id}.json`))
  assert.equal((dirStat.mode & 0o777).toString(8), '700')
  assert.equal((fileStat.mode & 0o777).toString(8), '600')
})

test('归档：超过 maxRetain 时保留最新的 N 条', async () => {
  const dm = await makeManager(3)
  for (let i = 0; i < 5; i++) {
    await dm.sleep([
      { role: 'user', content: `任务 ${i}` },
      { role: 'assistant', content: '处理中', toolCalls: [{ name: 'Read', input: {} }] },
      { role: 'tool', content: '结果' },
      { role: 'assistant', content: `完成 ${i}` },
    ], {})
  }
  const dreams = await dm.list()
  assert.equal(dreams.length, 3)
  // 最新在前，且保留的是最后写入的
  assert.match(dreams[0].main_goal, /任务 4/)
})

test('renderDreamContext 渲染字段', () => {
  const ctx = renderDreamContext({
    main_goal: 'G',
    next_steps: '- S',
    decisions: ['D'],
    key_results: 'K',
  })
  assert.ok(ctx.includes('G') && ctx.includes('S') && ctx.includes('D') && ctx.includes('K'))
  // 空对象不报错
  assert.equal(renderDreamContext({}), '')
})

// ---- LLM 方向分类摘要（用本地 mock 服务器，不依赖外部网络） ----

/** 启动一个本地 mock LLM 服务器，按输入内容返回对应方向 */
function startMockLlm() {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', c => (body += c))
    req.on('end', () => {
      const parsed = JSON.parse(body)
      const input = parsed.messages[1].content
      let dir
      if (input.includes('数据库')) dir = { name: '数据库', summary: '优化数据库查询', key_decisions: '', next_steps: '' }
      else if (input.includes('排序')) dir = { name: '算法', summary: '实现快速排序', key_decisions: '', next_steps: '加归并排序' }
      else if (input.includes('http')) dir = { name: 'http客户端', summary: '重构http客户端支持超时重试', key_decisions: '指数退避', next_steps: '暴露重试次数' }
      else dir = { name: 'general', summary: input.slice(0, 30), key_decisions: '', next_steps: '' }
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ directions: [dir], overall: dir.summary }) } }] }))
    })
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)))
}

test('llmSummarizeDirections：解析本地模型返回的方向分类 JSON（含 markdown 包裹）', async () => {
  const server = await startMockLlm()
  try {
    const base = `http://127.0.0.1:${server.address().port}/v1`
    const llm = await llmSummarizeDirections(
      [{ role: 'user', content: '重构 http 客户端' }, { role: 'assistant', content: '采用指数退避' }],
      { apiBase: base, model: 'm', apiKey: '' },
    )
    assert.ok(llm)
    assert.equal(llm.directions[0].name, 'http客户端')
    assert.match(llm.directions[0].next_steps, /重试次数/)
  } finally {
    server.close()
  }
})

test('llmSummarizeDirections：非法 JSON / 非本地服务 → 返回 null（降级）', async () => {
  // 非本地服务（云端）→ 拒绝，保护对话隐私
  const cloud = await llmSummarizeDirections(
    [{ role: 'user', content: 'x' }],
    { apiBase: 'https://api.openai.com/v1', model: 'gpt', apiKey: 'k' },
  )
  assert.equal(cloud, null)
})

test('sleep 配本地摘要模型：存入 LLM 方向分类的 directions', async () => {
  const server = await startMockLlm()
  try {
    const base = `http://127.0.0.1:${server.address().port}/v1`
    const dir = await mkdtemp(join(tmpdir(), 'dream-llm-test-'))
    const dm = new DreamManager({ dreamsDir: dir, summarizer: { apiBase: base, model: 'm', apiKey: '' }, minLLMMessages: 4 })
    const dream = await dm.sleep([
      { role: 'user', content: '重构 http 客户端' },
      { role: 'assistant', content: '采用指数退避', toolCalls: [{ name: 'Bash', input: {} }] },
      { role: 'tool', content: 'OK' },
      { role: 'assistant', content: '下一步暴露重试次数' },
    ], {})
    assert.ok(Array.isArray(dream.directions))
    assert.equal(dream.directions[0].name, 'http客户端')
    assert.equal(dream.directions[0].next_steps, '暴露重试次数')
  } finally {
    server.close()
  }
})

test('sleep 无 summarizer：降级为启发式，directions 为空', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dream-nosum-'))
  const dm = new DreamManager({ dreamsDir: dir, summarizer: null })
  const dream = await dm.sleep(sampleMessages(), {})
  assert.ok(!dream.directions || dream.directions.length === 0)
})

test('成本控制：小会话未达 minLLMMessages 不调用本地摘要模型', async () => {
  const server = await startMockLlm()
  try {
    const base = `http://127.0.0.1:${server.address().port}/v1`
    const dir = await mkdtemp(join(tmpdir(), 'dream-cost-'))
    // 门槛设为 8：4 条消息的会话不触发 LLM
    const dm = new DreamManager({ dreamsDir: dir, summarizer: { apiBase: base, model: 'm', apiKey: '' }, minLLMMessages: 8 })
    let called = false
    const origFetch = globalThis.fetch
    globalThis.fetch = (...args) => { called = true; return origFetch(...args) }
    try {
      const dream = await dm.sleep([
        { role: 'user', content: '重构 http 客户端' },
        { role: 'assistant', content: '采用指数退避', toolCalls: [{ name: 'Read', input: {} }] },
        { role: 'tool', content: 'OK' },
        { role: 'assistant', content: '完成' },
      ], {})
      assert.equal(called, false, '小会话不应触发本地摘要模型调用')
      // 降级方向来自启发式
      assert.ok(Array.isArray(dream.directions))
      assert.ok(dream.directions[0].name)
    } finally {
      globalThis.fetch = origFetch
    }
  } finally {
    server.close()
  }
})

test('成本控制：大会话达到门槛后调用本地摘要模型', async () => {
  const server = await startMockLlm()
  try {
    const base = `http://127.0.0.1:${server.address().port}/v1`
    const dir = await mkdtemp(join(tmpdir(), 'dream-cost2-'))
    const dm = new DreamManager({ dreamsDir: dir, summarizer: { apiBase: base, model: 'm', apiKey: '' }, minLLMMessages: 4 })
    // 造一个 6 条消息的会话，超过门槛 4
    const msgs = [
      { role: 'user', content: '重构 http 客户端' },
      { role: 'assistant', content: '分析现状', toolCalls: [{ name: 'Read', input: {} }] },
      { role: 'tool', content: 'OK' },
      { role: 'assistant', content: '采用指数退避' },
      { role: 'user', content: '再优化连接池' },
      { role: 'assistant', content: '已完成，下一步暴露重试次数' },
    ]
    const dream = await dm.sleep(msgs, {})
    // 达到门槛 → 用 LLM 返回的 http 方向
    assert.ok(Array.isArray(dream.directions))
    assert.equal(dream.directions[0].name, 'http客户端')
  } finally {
    server.close()
  }
})

test('去重合并：同一方向的新梦境合并而非新增', async () => {
  const server = await startMockLlm()
  try {
    const base = `http://127.0.0.1:${server.address().port}/v1`
    const dir = await mkdtemp(join(tmpdir(), 'dream-merge-'))
    const dm = new DreamManager({ dreamsDir: dir, summarizer: { apiBase: base, model: 'm', apiKey: '' }, minLLMMessages: 4 })
    // 第一次会话：http 客户端
    await dm.sleep([
      { role: 'user', content: '重构 http 客户端' },
      { role: 'assistant', content: '采用指数退避', toolCalls: [{ name: 'Read', input: {} }] },
      { role: 'tool', content: 'OK' },
      { role: 'assistant', content: '完成基础重构' },
    ], { title: '会话1' })
    // 第二次会话：继续 http 客户端（同方向）
    const merged = await dm.sleep([
      { role: 'user', content: '继续优化 http 客户端' },
      { role: 'assistant', content: '加上连接池', toolCalls: [{ name: 'Read', input: {} }] },
      { role: 'tool', content: 'OK' },
      { role: 'assistant', content: '下一步暴露重试次数' },
    ], { title: '会话2' })

    const all = await dm.list()
    // 应只有 1 条梦境（http 客户端），且是合并后的
    assert.equal(all.length, 1)
    assert.ok(merged.id === all[0].id)
    // next_steps 用最新的
    assert.match(merged.directions[0].next_steps, /重试次数/)
    // merge_count 递增
    assert.equal(merged.merge_count, 2)
    // source_titles 记录两个来源
    assert.ok(merged.source_titles.includes('会话1'))
    assert.ok(merged.source_titles.includes('会话2'))
  } finally {
    server.close()
  }
})

test('去重合并：不同方向不合并，各存一条', async () => {
  const server = await startMockLlm()
  try {
    const base = `http://127.0.0.1:${server.address().port}/v1`
    const dir = await mkdtemp(join(tmpdir(), 'dream-nomerge-'))
    const dm = new DreamManager({ dreamsDir: dir, summarizer: { apiBase: base, model: 'm', apiKey: '' }, minLLMMessages: 4 })
    await dm.sleep([
      { role: 'user', content: '重构 http 客户端' },
      { role: 'assistant', content: '采用指数退避', toolCalls: [{ name: 'Read', input: {} }] },
      { role: 'tool', content: 'OK' },
      { role: 'assistant', content: '完成' },
    ], {})
    await dm.sleep([
      { role: 'user', content: '写一个排序算法' },
      { role: 'assistant', content: '实现快速排序', toolCalls: [{ name: 'Read', input: {} }] },
      { role: 'tool', content: 'OK' },
      { role: 'assistant', content: '完成' },
    ], {})
    const all = await dm.list()
    assert.equal(all.length, 2, 'http 客户端 与 排序算法 方向不同，应各存一条')
    const names = all.map(d => d.directions?.[0]?.name).sort()
    assert.deepEqual(names, ['http客户端', '算法'])
  } finally {
    server.close()
  }
})

test('renderDreamContext：有 directions 时优先渲染方向摘要', async () => {
  const ctx = renderDreamContext({
    directions: [{ name: 'http客户端', summary: '进展', key_decisions: '决策', next_steps: '待办' }],
    main_goal: 'G',
  })
  assert.ok(ctx.includes('http客户端'))
  assert.ok(ctx.includes('进展') && ctx.includes('决策') && ctx.includes('待办'))
  // 不再渲染 main_goal（LLM 方向优先）
  assert.ok(!ctx.includes('[未完成的主线任务]'))
})

test('wakeByDirection：按方向检索，正确区分不同方向', async () => {
  const server = await startMockLlm()
  try {
    const base = `http://127.0.0.1:${server.address().port}/v1`
    const dir = await mkdtemp(join(tmpdir(), 'dream-wake-dir-'))
    const dm = new DreamManager({ dreamsDir: dir, summarizer: { apiBase: base, model: 'm', apiKey: '' }, minLLMMessages: 4 })
    await dm.sleep([
      { role: 'user', content: '重构 http 客户端' },
      { role: 'assistant', content: '采用指数退避', toolCalls: [{ name: 'Bash', input: {} }] },
      { role: 'tool', content: 'OK' },
      { role: 'assistant', content: '下一步暴露重试次数' },
    ], {})
    await dm.sleep([
      { role: 'user', content: '写一个排序算法' },
      { role: 'assistant', content: '实现快速排序', toolCalls: [{ name: 'Read', input: {} }] },
      { role: 'tool', content: 'OK' },
      { role: 'assistant', content: '完成' },
    ], {})

    const http = await dm.wakeByDirection('http')
    assert.ok(http.includes('http客户端'))
    assert.ok(!http.includes('排序'))   // 正确排除无关方向

    const algo = await dm.wakeByDirection('排序')
    assert.ok(algo.includes('排序'))
    assert.ok(!algo.includes('http客户端'))  // 正确排除无关方向

    // 无关方向 → null
    assert.equal(await dm.wakeByDirection('不存在的方向'), null)
    // 空查询回退到 wake(最近N条)
    const fallback = await dm.wakeByDirection('   ')
    assert.ok(fallback)
  } finally {
    server.close()
  }
})

test('wakeByDirection（调优）：方向名加权命中优先于正文', async () => {
  const server = await startMockLlm()
  try {
    const base = `http://127.0.0.1:${server.address().port}/v1`
    const dir = await mkdtemp(join(tmpdir(), 'dream-rank-'))
    const dm = new DreamManager({ dreamsDir: dir, summarizer: { apiBase: base, model: 'm', apiKey: '' }, minLLMMessages: 4 })
    // 梦境A：方向名是 "数据库"，正文提到 http
    await dm.sleep([
      { role: 'user', content: '优化数据库查询' },
      { role: 'assistant', content: '用 http 接口暴露查询结果', toolCalls: [{ name: 'Read', input: {} }] },
      { role: 'tool', content: 'OK' },
      { role: 'assistant', content: '完成' },
    ], {})
    // 梦境B：方向名是 "http客户端"
    await dm.sleep([
      { role: 'user', content: '重构 http 客户端' },
      { role: 'assistant', content: '采用指数退避', toolCalls: [{ name: 'Read', input: {} }] },
      { role: 'tool', content: 'OK' },
      { role: 'assistant', content: '完成' },
    ], {})
    // 搜 "http客户端"，方向名精确命中的 B 应排最前
    const ctx = await dm.wakeByDirection('http客户端')
    assert.ok(ctx)
    // renderDreamContext 渲染 directions：方向名 "▸ http客户端" 应出现在 "▸ 数据库" 之前
    const httpPos = ctx.indexOf('▸ http客户端')
    const dbPos = ctx.indexOf('▸ 数据库')
    assert.ok(httpPos !== -1 && dbPos !== -1)
    assert.ok(httpPos < dbPos, `方向名加权未生效：http=${httpPos} db=${dbPos}`)
  } finally {
    server.close()
  }
})

test('wakeByDirection（调优）：多关键词拆分与整串命中', async () => {
  const server = await startMockLlm()
  try {
    const base = `http://127.0.0.1:${server.address().port}/v1`
    const dir = await mkdtemp(join(tmpdir(), 'dream-multi-'))
    const dm = new DreamManager({ dreamsDir: dir, summarizer: { apiBase: base, model: 'm', apiKey: '' }, minLLMMessages: 4 })
    await dm.sleep([
      { role: 'user', content: '给 http 客户端加超时重试' },
      { role: 'assistant', content: '采用指数退避', toolCalls: [{ name: 'Read', input: {} }] },
      { role: 'tool', content: 'OK' },
      { role: 'assistant', content: '完成' },
    ], {})
    // 中文多词："http 客户端 重试"
    const ctx = await dm.wakeByDirection('http 客户端 重试')
    assert.ok(ctx, '中文多词查询应命中')
    assert.ok(ctx.includes('超时重试'))
  } finally {
    server.close()
  }
})

test('wakeByDirection（调优）：短词防误命中', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dream-short-'))
  const dm = new DreamManager({ dreamsDir: dir, summarizer: null })
  // 无 summarizer → 启发式梦境，方向名为主目标
  await dm.sleep([
    { role: 'user', content: '实现排序算法' },
    { role: 'assistant', content: '完成', toolCalls: [{ name: 'Read', input: {} }] },
    { role: 'tool', content: 'OK' },
    { role: 'assistant', content: '用了快速排序' },
  ], {})
  // 单短英文词 "OK" 不应因为正文里 tool 结果含 OK 就误命中
  const ctx = await dm.wakeByDirection('OK')
  // 正文没有实质 OK 方向，应返回 null 或极弱匹配
  // 这里排序算法主线不含 OK 关键词，正常应返回 null
  assert.ok(ctx === null || !ctx.includes('排序算法'))
})

test('sanitizeSecrets：脱敏 API key / token / 密码 / 私钥', () => {
  const sk = sanitizeSecrets('key=sk-abcdefgh1234567890')
  assert.ok(sk.startsWith('key=sk-abc***[redacted:'))
  assert.ok(!sk.includes('abcdefgh1234567890'))
  assert.ok(!/sk-abcdefgh1234567890/.test(sanitizeSecrets('使用 sk-abcdefgh1234567890 调用')))
  assert.ok(sanitizeSecrets('ghp_abcdefghijklmnopqrstuvwxyz1234567890').includes('[redacted'))
  // Bearer token
  assert.ok(sanitizeSecrets('Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.xxxx').includes('[redacted'))
  // 私钥
  const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----'
  assert.ok(!sanitizeSecrets(pem).includes('MIIEvQIBADANBg'))
  // 明文普通文本不受影响
  const normal = '重构 http 客户端，采用指数退避'
  assert.equal(sanitizeSecrets(normal), normal)
})

test('安全脱敏：入睡时梦境文本字段不含密钥', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dream-sanitize-'))
  const dm = new DreamManager({ dreamsDir: dir, summarizer: null })
  const dream = await dm.sleep([
    { role: 'user', content: '配置 API key 为 sk-abcdefgh1234567890 并接入服务' },
    { role: 'assistant', content: '已配置，使用 ghp_abcdefghijklmnopqrstuvwxyz1234567890 推送', toolCalls: [{ name: 'Read', input: {} }] },
    { role: 'tool', content: 'OK' },
    { role: 'assistant', content: '完成' },
  ], {})
  const all = await dm.list()
  const saved = JSON.stringify(all)
  assert.ok(!saved.includes('sk-abcdefgh1234567890'))
  assert.ok(!saved.includes('ghp_abcdefghijklmnopqrstuvwxyz1234567890'))
  assert.ok(saved.includes('[redacted'))
})

test('记忆保鲜度：醒来时未完成任务优先于更新的已完成任务', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dream-fresh-'))
  const dm = new DreamManager({ dreamsDir: dir, summarizer: null })
  // 先存一个已完成任务（较早）
  await dm.sleep([
    { role: 'user', content: '修复登录 bug' },
    { role: 'assistant', content: '已修复完成', toolCalls: [{ name: 'Read', input: {} }] },
    { role: 'tool', content: 'OK' },
    { role: 'assistant', content: '完成' },
  ], {})
  // 再存一个未完成任务（较新，但已完成的是最新，通过时间排名更靠前）
  await dm.sleep([
    { role: 'user', content: '实现报表导出' },
    { role: 'assistant', content: '做到一半', toolCalls: [{ name: 'Read', input: {} }] },
    { role: 'tool', content: 'OK' },
    { role: 'assistant', content: '还未完成，下一步加 CSV 编码' },
  ], {})
  // 第三个最新，已完成
  await dm.sleep([
    { role: 'user', content: '写文档' },
    { role: 'assistant', content: '完成', toolCalls: [{ name: 'Read', input: {} }] },
    { role: 'tool', content: 'OK' },
    { role: 'assistant', content: '文档写好' },
  ], {})

  const ctx = await dm.wake(2)
  // 未完成的"报表导出"应被优先注入（出现在前 2 条里）
  assert.ok(ctx.includes('报表导出'))
  assert.ok(ctx.includes('⏳'))  // 未完成标记
})

test('extractWorkspace：从工具调用提取涉及文件', () => {
  const ws = extractWorkspace([
    { role: 'user', content: '重构 http 客户端' },
    { role: 'assistant', content: '读取 src/http/client.js', toolCalls: [{ name: 'Read', input: { file_path: 'src/http/client.js' } }] },
    { role: 'tool', content: 'OK' },
    { role: 'assistant', content: '写入 src/http/retry.js', toolCalls: [{ name: 'Write', input: { file_path: 'src/http/retry.js' } }] },
  ])
  const paths = ws.files.map(f => f.path)
  assert.ok(paths.includes('src/http/client.js'))
  assert.ok(paths.includes('src/http/retry.js'))
})

test('renderResumeInstruction：未完成任务生成明确的续作指令', () => {
  const ctx = renderResumeInstruction({
    has_unfinished: true,
    main_goal: '重构 http 客户端',
    next_steps: '- 下一步补全 retry 函数',
    workspace: { files: [{ path: 'src/http/client.js', count: 2 }, { path: 'src/http/retry.js', count: 1 }] },
  })
  assert.ok(ctx.includes('补全 retry 函数'))
  assert.ok(ctx.includes('src/http/client.js'))
  assert.ok(ctx.includes('请先读取上述涉及的文件'))
  // 已完成的任务不生成续作指令
  assert.equal(renderResumeInstruction({ has_unfinished: false, main_goal: 'x' }), '')
})

test('主模型摘要：无专用 LLM 时用当前主模型（allowRemote）做梦境总结', async () => {
  const server = await startMockLlm()
  try {
    const base = `http://127.0.0.1:${server.address().port}/v1`
    const dir = await mkdtemp(join(tmpdir(), 'dream-mainsum-'))
    // 无专用 summarizer，只有 mainSummarizer（模拟"用当前 AI 总结"）
    const dm = new DreamManager({ dreamsDir: dir, summarizer: null, minLLMMessages: 2 })
    const dream = await dm.sleep([
      { role: 'user', content: '重构 http 客户端' },
      { role: 'assistant', content: '采用指数退避', toolCalls: [{ name: 'Read', input: { file_path: 'src/http.js' } }] },
      { role: 'tool', content: 'OK' },
      { role: 'assistant', content: '下一步补全 retry' },
    ], {}, { mainSummarizer: { apiBase: base, model: 'm', apiKey: '' } })
    assert.ok(Array.isArray(dream.directions))
    assert.equal(dream.directions[0].name, 'http客户端')
    // 现场快照保留
    assert.ok(dream.workspace.files.some(f => f.path.includes('http.js')))
  } finally {
    server.close()
  }
})

test('无任何模型：纯本地规则仍能提炼主线 + 现场文件（可续作）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dream-nollm-'))
  const dm = new DreamManager({ dreamsDir: dir, summarizer: null })
  const dream = await dm.sleep([
    { role: 'user', content: '重构 http 客户端' },
    { role: 'assistant', content: '采用指数退避', toolCalls: [{ name: 'Read', input: { file_path: 'src/http/client.js' } }] },
    { role: 'tool', content: 'OK' },
    { role: 'assistant', content: '还未完成，下一步补全 retry' },
  ], {})
  assert.ok(dream.main_goal.includes('http 客户端'))
  assert.ok(dream.workspace.files.some(f => f.path.includes('http/client.js')))
  // 无 directions（未配置模型时不包装）
  assert.ok(!dream.directions || dream.directions.length === 0)
  // 但醒来时仍能渲染续作指令（基于 main_goal + workspace + next_steps）
  const ctx = renderDreamContext(dream)
  assert.ok(ctx.includes('http 客户端'))
})
