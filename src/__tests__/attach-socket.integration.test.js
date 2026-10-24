// ============================================================
//  attach-socket.integration.test.js — 真实 Unix socket 通路测试
//
//  与 attach-hub.test.js 的分工：
//    · attach-hub.test.js        用假 socket 测「协议逻辑」
//    · 本文件                     用真实 net 服务端测「线缆」：编码、分包、粘包、关闭
//
//  这两类问题只有真开一个 socket 才会暴露（半行 JSON、多行粘在一个 chunk 里）。
//
//  运行：node --test src/__tests__/attach-socket.integration.test.js
// ============================================================
import { test } from 'node:test'
import assert from 'node:assert'
import { createServer, connect } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir, platform } from 'node:os'
import { join } from 'node:path'
import { AttachHub } from '../core/attach-hub.js'
import { EventBus } from '../core/event-bus.js'

const isWin = platform() === 'win32'

/** 起一个真实 socket 服务端，返回 { sockPath, hub, bus, close } */
async function startServer() {
  const bus = new EventBus()
  const engine = { state: { isRunning: false }, abort: () => {} }
  const submitted = []
  const hub = new AttachHub({
    bus,
    engine,
    sessionManager: { currentSession: { id: 'sess-int' }, list: async () => [] },
    onSubmit: async (text) => { submitted.push(text) },
  })

  const dir = mkdtempSync(join(tmpdir(), 'ccnode-attach-'))
  const sockPath = isWin ? `\\\\.\\pipe\\ccnode-test-${Date.now()}` : join(dir, 'repl.sock')

  const server = createServer((client) => hub.addClient(client))
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(sockPath, resolve)
  })

  return {
    sockPath, hub, bus, submitted,
    close: async () => {
      hub.dispose()
      await new Promise(r => server.close(r))
      try { rmSync(dir, { recursive: true, force: true }) } catch {}
    },
  }
}

/** 连上 socket，收集服务端推送的消息 */
function connectClient(sockPath) {
  return new Promise((resolve, reject) => {
    const sock = connect(sockPath)
    const msgs = []
    let buf = ''
    const waiters = []

    sock.setEncoding('utf8')
    sock.on('connect', () => resolve({ sock, msgs, send: (o) => sock.write(JSON.stringify(o) + '\n'), waitFor }))
    sock.on('error', reject)
    sock.on('data', (chunk) => {
      buf += chunk
      const lines = buf.split('\n')
      buf = lines.pop()
      for (const line of lines) {
        if (!line.trim()) continue
        msgs.push(JSON.parse(line))
      }
      for (const w of [...waiters]) {
        const hit = msgs.find(w.pred)
        if (hit) { waiters.splice(waiters.indexOf(w), 1); w.resolve(hit) }
      }
    })

    function waitFor(pred, timeoutMs = 2000) {
      const hit = msgs.find(pred)
      if (hit) return Promise.resolve(hit)
      return new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error('等待消息超时')), timeoutMs)
        waiters.push({ pred, resolve: (m) => { clearTimeout(t); res(m) } })
      })
    }
  })
}

test('真实 socket：attach → 收 attached → 输入 → 事件广播回客户端', async () => {
  const srv = await startServer()
  try {
    const cli = await connectClient(srv.sockPath)
    cli.send({ type: 'attach', role: 'controller' })

    const attached = await cli.waitFor(m => m.type === 'attached')
    assert.equal(attached.role, 'controller')
    assert.equal(attached.session, 'sess-int')

    cli.send({ type: 'input', text: '来自 socket 的输入' })
    // 等 onSubmit 落地（真实 I/O 有延迟）
    await new Promise(r => setTimeout(r, 50))
    assert.deepEqual(srv.submitted, ['来自 socket 的输入'])

    srv.bus.emit('tool/call', { reqId: 'r1', name: 'Bash', input: { cmd: 'ls' } })
    const tc = await cli.waitFor(m => m.type === 'tool/call')
    assert.equal(tc.name, 'Bash')

    cli.sock.destroy()
  } finally {
    await srv.close()
  }
})

test('真实 socket：分包 —— 半行 JSON 跨 chunk 到达也能正确解析', async () => {
  const srv = await startServer()
  try {
    const cli = await connectClient(srv.sockPath)

    const payload = JSON.stringify({ type: 'attach', role: 'controller' })
    // 故意切成三段写入，模拟网络分片 / 管道边界
    cli.sock.write(payload.slice(0, 5))
    await new Promise(r => setTimeout(r, 20))
    cli.sock.write(payload.slice(5, 15))
    await new Promise(r => setTimeout(r, 20))
    cli.sock.write(payload.slice(15) + '\n')

    const attached = await cli.waitFor(m => m.type === 'attached')
    assert.equal(attached.role, 'controller')
    cli.sock.destroy()
  } finally {
    await srv.close()
  }
})

test('真实 socket：粘包 —— 两条消息挤在一个 chunk 里都不得丢', async () => {
  const srv = await startServer()
  try {
    const cli = await connectClient(srv.sockPath)

    const two = JSON.stringify({ type: 'attach', role: 'controller' }) + '\n' +
                JSON.stringify({ type: 'input', text: '粘包输入' }) + '\n'
    cli.sock.write(two)

    const attached = await cli.waitFor(m => m.type === 'attached')
    assert.ok(attached)
    await new Promise(r => setTimeout(r, 50))
    assert.deepEqual(srv.submitted, ['粘包输入'], '同 chunk 的第二条也必须被处理')
    cli.sock.destroy()
  } finally {
    await srv.close()
  }
})

test('真实 socket：客户端断开后 hub 摘掉它，不泄漏订阅者', async () => {
  const srv = await startServer()
  try {
    const cli = await connectClient(srv.sockPath)
    cli.send({ type: 'attach', role: 'viewer' })
    await cli.waitFor(m => m.type === 'attached')
    assert.equal(srv.hub.stats().clients, 1)

    cli.sock.destroy()
    await new Promise(r => setTimeout(r, 60))
    assert.equal(srv.hub.stats().clients, 0, '断开后必须从 hub 摘除')
  } finally {
    await srv.close()
  }
})
