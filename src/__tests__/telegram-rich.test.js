// ============================================================
//  telegram-rich.test.js — Telegram 富格式发送 + 三级降级单测
//  运行：node --test src/__tests__/telegram-rich.test.js
//  用 stub fetch 验证调用序列，不触网。
// ============================================================
import { test, afterEach } from 'node:test'
import assert from 'node:assert'
import { TelegramListener } from '../channel/tg-listener.js'

const realFetch = global.fetch
afterEach(() => { global.fetch = realFetch })

/** 建一个 bot，绕过速率限制；并清掉监听器的清理定时器避免挂住测试进程 */
function mkBot(richMode) {
  const tl = new TelegramListener({ channels: { telegram: { token: 'TEST', richMessages: richMode } } })
  tl.conversations.destroy()
  tl.bot.rateLimiter.waitForSlot = async () => true
  return tl.bot
}

/** stub 全局 fetch，记录调用；handler 返回 { data, status? }，缺省视为成功 */
function stubFetch(handler = () => ({ data: { ok: true, result: { message_id: 1 } } })) {
  const calls = []
  global.fetch = async (url, opts = {}) => {
    const method = String(url).split('/').pop()
    const body = opts.body ? JSON.parse(opts.body) : null
    const rec = { method, body }
    calls.push(rec)
    const r = handler(rec) || { data: { ok: true, result: { message_id: 1 } } }
    return { status: r.status ?? 200, json: async () => r.data }
  }
  return calls
}

test('富消息成功：只调 sendRichMessage，markdown 原样直传', async () => {
  const calls = stubFetch()
  const bot = mkBot()
  const md = '# 标题\n\n| A | B |\n|--|--|\n| 1 | 2 |'
  await bot.sendFormatted('123', md, { replyTo: 42 })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'sendRichMessage')
  assert.equal(calls[0].body.rich_message.markdown, md)
  assert.deepEqual(calls[0].body.reply_parameters, { message_id: 42 })
})

test('富消息 400 → 降级 HTML（Markdown 已转换）', async () => {
  const calls = stubFetch(({ method }) =>
    method === 'sendRichMessage'
      ? { data: { ok: false, error_code: 400, description: "can't parse" } }
      : { data: { ok: true, result: { message_id: 2 } } })
  const bot = mkBot()
  await bot.sendFormatted('123', '**bold** 和 `code`')
  assert.deepEqual(calls.map(c => c.method), ['sendRichMessage', 'sendMessage'])
  assert.equal(calls[1].body.parse_mode, 'HTML')
  assert.ok(calls[1].body.text.includes('<b>bold</b>'), '应转成 <b>')
  assert.ok(calls[1].body.text.includes('<code>code</code>'), '应转成 <code>')
})

test('富消息 404(method not found) → 记忆降级，后续不再重试富消息', async () => {
  const calls = stubFetch(({ method }) =>
    method === 'sendRichMessage'
      ? { data: { ok: false, error_code: 404, description: 'Not Found: method not found' } }
      : { data: { ok: true, result: { message_id: 3 } } })
  const bot = mkBot()
  await bot.sendFormatted('123', 'hi')
  await bot.sendFormatted('123', 'again')
  assert.equal(bot.richDisabled, true)
  assert.equal(calls.filter(c => c.method === 'sendRichMessage').length, 1, '只应尝试一次')
  assert.equal(calls.filter(c => c.method === 'sendMessage').length, 2)
})

test("richMode='off' → 从不调用 sendRichMessage", async () => {
  const calls = stubFetch()
  const bot = mkBot('off')
  await bot.sendFormatted('123', '**b**')
  assert.equal(calls.filter(c => c.method === 'sendRichMessage').length, 0)
  assert.equal(calls[0].method, 'sendMessage')
})

test('HTML 也失败 → 兜底纯文本（无 parse_mode）', async () => {
  const calls = stubFetch(({ method, body }) => {
    if (method === 'sendRichMessage') return { data: { ok: false, error_code: 400, description: 'x' } }
    if (body && body.parse_mode) return { data: { ok: false, error_code: 400, description: "can't parse entities" } }
    return { data: { ok: true, result: { message_id: 9 } } }
  })
  const bot = mkBot()
  await bot.sendFormatted('123', '**bold**')
  const sm = calls.filter(c => c.method === 'sendMessage')
  assert.equal(sm.length, 2)
  assert.equal(sm[0].body.parse_mode, 'HTML')
  assert.ok(!('parse_mode' in sm[1].body), '最后一条应为纯文本')
})

test('超长文本自动分片（富消息 32768 上限）', async () => {
  const calls = stubFetch()
  const bot = mkBot()
  const long = Array.from({ length: 4000 }, (_, i) => `第 ${i} 行 这是内容内容内容内容内容`).join('\n')
  await bot.sendFormatted('123', long)
  const rich = calls.filter(c => c.method === 'sendRichMessage')
  assert.ok(rich.length > 1, '应拆成多条')
  assert.ok(rich[1].body.rich_message.markdown.startsWith('📎 (2/'), '第 2 条应有分片头')
})

test('429 → 自动等待重试', async () => {
  let n = 0
  const calls = stubFetch(() => {
    n++
    if (n === 1) return { data: { ok: false, error_code: 429, parameters: { retry_after: 0 } } }
    return { data: { ok: true, result: { message_id: 7 } } }
  })
  const bot = mkBot()
  await bot.sendFormatted('123', 'hi')
  assert.equal(calls.length, 2)
  assert.equal(calls[0].method, 'sendRichMessage')
  assert.equal(calls[1].method, 'sendRichMessage')
})

test('editFormatted：富编辑走 editMessageText + rich_message（markdown 直传）', async () => {
  const calls = stubFetch()
  const bot = mkBot()
  const md = '# 标题\n\n| A | B |\n|--|--|\n| 1 | 2 |'
  await bot.editFormatted('123', 55, md)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'editMessageText')
  assert.equal(calls[0].body.message_id, 55)
  assert.equal(calls[0].body.rich_message.markdown, md)
})

test('editFormatted：富编辑 400 → 降级 HTML edit（Markdown 已转换）', async () => {
  const calls = stubFetch(({ body }) =>
    body && body.rich_message
      ? { data: { ok: false, error_code: 400, description: 'x' } }
      : { data: { ok: true, result: { message_id: 55 } } })
  const bot = mkBot()
  await bot.editFormatted('123', 55, '**bold** 与 `code`')
  assert.equal(calls.length, 2)
  assert.ok(calls[0].body.rich_message, '先试富编辑')
  assert.equal(calls[1].body.parse_mode, 'HTML')
  assert.ok(calls[1].body.text.includes('<b>bold</b>'), '应转成 <b>')
  assert.ok(calls[1].body.text.includes('<code>code</code>'), '应转成 <code>')
})
