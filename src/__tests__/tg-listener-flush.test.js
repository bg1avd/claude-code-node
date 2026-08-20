import { test } from 'node:test'
import assert from 'node:assert'
import { TelegramListener } from '../channel/tg-listener.js'

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms))

/**
 * 构造一个用 mock _fetch 的 TelegramListener，用于验证 flushOffset 的排他锁逻辑。
 * 为避免 _poll 无限循环导致测试进程无法退出，测试通过直接设置挂起状态来驱动。
 */
function makeListener() {
  const listener = new TelegramListener({ channels: { telegram: { token: 'test-token' } } })
  listener._loadOffset = () => 0
  listener._saveOffset = () => {}

  const calls = []
  // 模拟一个可被 abort 的挂起请求（等价于 _poll 正在长轮询挂起）
  listener._fetch = async (url, options = {}) => {
    const body = JSON.parse(options.body || '{}')
    calls.push({ tgTimeout: body.timeout, httpTimeout: options.timeout })

    // Telegram 长轮询 = body.timeout > 0（如 _poll 传 30）；flushOffset 传 0 立即返回。
    if ((body.timeout || 0) > 0) {
      return new Promise((resolve, reject) => {
        if (options.signal) {
          options.signal.addEventListener('abort', () => {
            const e = new Error('aborted')
            e.name = 'AbortError'
            reject(e)
          }, { once: true })
        }
      })
    }
    return { ok: true, json: async () => ({ ok: true, result: [] }) }
  }

  return { listener, calls }
}

test('flushOffset 会取消挂起的 _poll 长轮询并独占连接（消除 409 竞态）', async () => {
  const { listener, calls } = makeListener()

  // 模拟 _poll 正处于长轮询挂起：设置 _polling 与一个可 abort 的 AbortController
  const pollAbort = new AbortController()
  listener._polling = true
  listener._pollAbort = pollAbort
  // 让 mock 的挂起请求真正绑定到该 signal（模拟 _poll 正在 await 它）
  const pendingReq = listener._fetch(`${listener.bot.apiBase}/getUpdates`, {
    method: 'POST', headers: {}, timeout: 60000, signal: pollAbort.signal,
    body: JSON.stringify({ offset: 1, timeout: 30 }),
  })
  // 预先消费可能的拒绝（flush 会 abort 它），避免 unhandled rejection 被记为测试失败
  const pendingReqSettled = pendingReq.catch(() => {})

  // 调用 flushOffset（模拟 /quit 前的确认消费）
  const flushPromise = listener.flushOffset()
  await tick(20)

  // flush 应立即 abort 掉挂起的 poll 请求
  assert.strictEqual(pollAbort.signal.aborted, true, 'flushOffset 应 abort 挂起的 _poll 长轮询')
  // 等待挂起请求因 abort 结束
  await pendingReqSettled
  // flushOffset 自身不应直接修改 _polling（由 _poll 的 finally 清理）
  assert.strictEqual(listener._polling, true, 'flush 不应直接改 _polling（由 _poll 的 finally 清理）')
  // 模拟真实 _poll 的 finally：请求结束后立即清理 _polling（真实 _poll 会这样做），
  // 使 flushOffset 的等待循环立即退出，贴近真实时序并避免 2s deadline。
  listener._polling = false
  await flushPromise

  assert.strictEqual(listener._flushLock, false, 'flush 应释放排他锁')

  // flush 应发起 body.timeout:0 的 getUpdates（确认消费），且不与他人并发
  const flushCall = calls.find((c) => c.tgTimeout === 0)
  assert.strictEqual(flushCall !== undefined, true, 'flushOffset 应发起 timeout:0 的 getUpdates')
  // 恰好 2 次请求：1 次挂起的长轮询 + 1 次 flush（无并发重复请求）
  assert.strictEqual(calls.length, 2, '不应有多余的并发 getUpdates')

  listener.conversations.destroy() // 清理 setInterval 定时器，避免测试进程残留
})

test('flushOffset 未挂起长轮询时也能正常 flush', async () => {
  const { listener, calls } = makeListener()

  await listener.flushOffset()

  const flushCall = calls.find((c) => c.tgTimeout === 0)
  assert.strictEqual(flushCall !== undefined, true, 'flushOffset 应发起确认消费请求')
  assert.strictEqual(calls.length, 1, '仅 1 次请求（flush）')
  assert.strictEqual(listener._flushLock, false, 'flush 应释放排他锁')

  listener.conversations.destroy() // 清理 setInterval 定时器，避免测试进程残留
})
