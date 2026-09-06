/**
 * MCP 客户端远程 HTTP(streamable) 能力单测
 *
 * 不依赖任何外部服务器：内联起一个"最小 MCP HTTP fixture"服务器，
 * 校验扩展后的 MCPClient/Registry 在 type:'http' 时能：
 *   - 用 Authorization: Bearer 透传鉴权头
 *   - 完成 initialize / tools/list / tools/call
 *   - close() 不抛错
 *
 * 该 fixture 只实现协议外围，不含真实搜索逻辑（搜索逻辑在独立 mcp-search-server 仓库）。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { MCPRegistry } from '../mcp/index.js'

// ---------- 最小 MCP HTTP fixture 服务器 ----------
let lastAuthHeader = ''
function startFixtureServer({ requiresAuth = true } = {}) {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      lastAuthHeader = req.headers['authorization'] || ''
      if (requiresAuth && !lastAuthHeader.startsWith('Bearer ')) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end('{"error":"unauthorized"}')
        return
      }
      // 读取 body
      let body = ''
      for await (const c of req) body += c
      let msg
      try { msg = JSON.parse(body) } catch {
        res.writeHead(400).end(); return
      }
      const send = (obj, status = 200) => {
        const payload = JSON.stringify(obj)
        res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
        res.end(payload)
      }
      const { id, method } = msg
      const noId = id === undefined || id === null
      switch (method) {
        case 'initialize':
          return noId ? send({}, 202) : send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '0' } } })
        case 'notifications/initialized':
        case 'notifications/cancelled':
        case 'notifications/message':
          return send({}, 202) // 通知
        case 'ping':
          return noId ? send({}, 202) : send({ jsonrpc: '2.0', id, result: {} })
        case 'tools/list':
          return send({ jsonrpc: '2.0', id, result: { tools: [{ name: 'search', description: 'fixture search', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }] } })
        case 'tools/call': {
          return noId ? send({}, 202) : send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'fixture result for ' + (msg.params?.arguments?.query || '') }], isError: false } })
        }
        case 'shutdown':
          return noId ? send({}, 202) : send({ jsonrpc: '2.0', id, result: null })
        default:
          return noId ? send({}, 202) : send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'unknown ' + method } }, 400)
      }
    })
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

let fixture
let url

before(async () => {
  fixture = await startFixtureServer()
  url = `http://127.0.0.1:${fixture.address().port}/mcp`
})

after(async () => {
  try { fixture && await new Promise((r) => fixture.close(r)) } catch { /* ignore */ }
})

test('type:http + token：连接、发现工具、调用、鉴权头透传', async () => {
  const registry = new MCPRegistry()
  registry.register('remote', { type: 'http', url, token: 'my-secret-token' })
  await registry.connect('remote')

  const tools = registry.getAllTools()
  assert.ok(tools.some((t) => t.name === 'search'))
  assert.equal(tools.find((t) => t.name === 'search')._mcpServer, 'remote')

  const res = await registry.callTool('remote', 'search', { query: 'hello' })
  assert.ok(res.content && Array.isArray(res.content))
  assert.match(res.content[0].text, /fixture result for hello/)

  await registry.closeAll()
})

test('客户端把 token 以 Authorization: Bearer 原样透传', async () => {
  lastAuthHeader = ''
  const registry = new MCPRegistry()
  registry.register('tok', { type: 'http', url, token: 'k3y-abc-123' })
  await registry.connect('tok')
  // fixture 收到 initialize 时已记录 header —— 断言它带上了 Bearer k3y-abc-123
  assert.equal(lastAuthHeader, 'Bearer k3y-abc-123')
  await registry.closeAll()
})

test('服务器强制鉴权时，不带 token 的初始化被 401 拒绝并抛出可读错误', async () => {
  const strictServer = await startFixtureServer({ requiresAuth: true })
  const strictUrl = `http://127.0.0.1:${strictServer.address().port}/mcp`
  try {
    const registry = new MCPRegistry()
    // 不配 token → 其它情形由 client 抛错（此处配错 token 前缀场景无触发 401，
    // 改用不暴露 token 而是发空 Auth 会更贴近真实：下面直接模拟无 Bearer 前缀）
    registry.register('nokey', { type: 'http', url: strictUrl, token: '' })
    await assert.rejects(() => registry.connect('nokey'), /连接失败|401|error/)
  } finally {
    await new Promise((r) => strictServer.close(r))
  }
})
