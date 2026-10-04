// ============================================================
//  telegram-tools.test.js — telegram_send_message 工具「富文本优先」路径单测
//  运行：node --test src/__tests__/telegram-tools.test.js
//  用 stub fetch 验证调用序列，不触网。
// ============================================================
import { test, afterEach } from 'node:test'
import assert from 'node:assert'

process.env.CC_NODE_CHANNEL_TELEGRAM_TOKEN = 'TEST_TOKEN'
process.env.CC_NODE_CHANNEL_TELEGRAM_CHAT_ID = '999'

const realFetch = global.fetch
afterEach(() => { global.fetch = realFetch })

const { telegramTools } = await import('../tools/telegram-tools.js')
const sendMsg = telegramTools.find(t => t.name === 'telegram_send_message')

/** stub 全局 fetch，记录调用；handler 返回 { data, status? }，缺省视为成功 */
function stubFetch(handler = () => ({ data: { ok: true, result: { message_id: 1, chat: { id: 999 } } } })) {
  const calls = []
  global.fetch = async (url, opts = {}) => {
    const method = String(url).split('/').pop()
    const body = opts.body ? JSON.parse(opts.body) : null
    const rec = { method, body }
    calls.push(rec)
    const r = handler(rec) || { data: { ok: true, result: { message_id: 1, chat: { id: 999 } } } }
    return { status: r.status ?? 200, json: async () => r.data }
  }
  return calls
}

test('默认走富文本：调用 sendRichMessage，markdown 原样直传', async () => {
  const calls = stubFetch()
  const md = '# 标题\n\n| A | B |\n|--|--|\n| 1 | 2 |'
  const r = await sendMsg.handler({ text: md })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'sendRichMessage')
  assert.equal(calls[0].body.rich_message.markdown, md)
  assert.equal(r.mode, 'rich')
  assert.equal(r.messageId, 1)
})

test('显式 parseMode=HTML → 走旧接口 sendMessage（兼容精确控制）', async () => {
  const calls = stubFetch()
  const r = await sendMsg.handler({ text: '<b>hi</b>', parseMode: 'HTML' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'sendMessage')
  assert.equal(calls[0].body.parse_mode, 'HTML')
  assert.equal(r.mode, 'legacy:HTML')
})

test('富消息失败 → 自动降级到 sendMessage(HTML)，Markdown 已转换', async () => {
  const calls = stubFetch(({ method }) =>
    method === 'sendRichMessage'
      ? { data: { ok: false, error_code: 400, description: 'x' } }
      : { data: { ok: true, result: { message_id: 3, chat: { id: 999 } } } })
  await sendMsg.handler({ text: '**bold** 与 `code`' })
  assert.deepEqual(calls.map(c => c.method), ['sendRichMessage', 'sendMessage'])
  assert.equal(calls[1].body.parse_mode, 'HTML')
  assert.ok(calls[1].body.text.includes('<b>bold</b>'), '应转成 <b>')
  assert.ok(calls[1].body.text.includes('<code>code</code>'), '应转成 <code>')
})

test('richMode=off → 直接走旧接口，不试富消息', async () => {
  const calls = stubFetch()
  await sendMsg.handler({ text: '**b**', richMode: 'off' })
  assert.equal(calls.filter(c => c.method === 'sendRichMessage').length, 0)
  assert.equal(calls[0].method, 'sendMessage')
})

test('缺 text → 返回错误', async () => {
  stubFetch()
  const r = await sendMsg.handler({ text: '' })
  assert.match(String(r), /ERROR/)
})
