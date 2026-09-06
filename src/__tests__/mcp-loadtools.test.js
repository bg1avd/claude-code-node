/**
 * MCP 工具装载桥（loadMcpToolsFromConfig）测试
 *   - 用内联 fixture MCP http server 作为 config.mcp.servers 目标
 *   - 验证：连接后把远程 "search" tool 变成本地 ToolDef（命名 <server>:<tool>）
 *   - 验证 props：name/description/parameters 正确 + handler 调用能返回远程结果
 *   - 验证：未配置 mcp.servers → 返回空、不产生工具
 *   - 验证：配置了但服务器连不上 → 返回空 tools + warnings，且不抛错（best-effort）
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { loadMcpToolsFromConfig, remoteToolToToolDef } from '../mcp/loadTools.js'
import { ToolDef } from '../types/index.js'

// ---- fixture MCP HTTP server（实现最小 tools/list + tools/call）----
function startMcpFixture() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      let body = ''
      for await (const c of req) body += c
      let msg
      try { msg = JSON.parse(body) } catch { res.writeHead(400); res.end(); return }
      const { id, method } = msg || {}
      const send = (obj, status = 200) => {
        const s = JSON.stringify(obj)
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(s)
      }
      switch (method) {
        case 'initialize':
          return send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fx', version: '1' } } })
        case 'notifications/initialized':
        case 'notifications/cancelled':
          return send({ jsonrpc: '2.0' }, 202)
        case 'tools/list':
          return send({ jsonrpc: '2.0', id, result: { tools: [{ name: 'search', description: 'remote search', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }] } })
        case 'tools/call':
          return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'remote:' + (msg.params?.arguments?.query || '') }], isError: false } })
        case 'ping':
          return send({ jsonrpc: '2.0', id, result: {} })
        default:
          return send({ jsonrpc: '2.0', id, error: { code: -32601 } }, 400)
      }
    })
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

let fx
let fxUrl
let cfgWithServer

before(async () => {
  fx = await startMcpFixture()
  fxUrl = `http://127.0.0.1:${fx.address().port}/mcp`
  cfgWithServer = {
    get: (key) => (key === 'mcp' ? { servers: { fx: { type: 'http', url: fxUrl } } } : undefined),
  }
})
after(async () => {
  try { fx && await new Promise((r) => fx.close(r)) } catch { /* ignore */ }
})

test('config 含 mcp.servers 时：装载出 <server>:<tool> ToolDef 并可真实调用', async () => {
  const { tools, registry } = await loadMcpToolsFromConfig(cfgWithServer)
  assert.ok(tools.length === 1)
  const def = tools[0]
  assert.equal(def.name, 'fx:search')
  assert.ok(def instanceof ToolDef)
  assert.match(def.description, /fx/)
  assert.deepEqual(Object.keys(def.parameters.properties), ['query'])
  // handler 真正经 HTTP 调到远程
  const text = await def.handler({ query: 'hello' }, {})
  assert.equal(text, 'remote:hello')
  await registry.closeAll()
})

test('未配置 mcp.servers → 返回空且不抛错', async () => {
  const { tools } = await loadMcpToolsFromConfig({ get: (k) => (k === 'mcp' ? {} : undefined) })
  assert.deepEqual(tools, [])
  const { tools: t2 } = await loadMcpToolsFromConfig(null)
  assert.deepEqual(t2, [])
})

test('配置了但目标连不上 → best-effort：空 tools + warnings，不抛致命错', async () => {
  const cfg = { get: () => ({ servers: { dead: { type: 'http', url: 'http://127.0.0.1:1/mcp', connectTimeoutMs: 400 } } }) }
  let warningMsg = ''
  const log = (m) => { warningMsg = m }
  const { tools, warnings, registry } = await loadMcpToolsFromConfig(cfg, { log })
  assert.deepEqual(tools, [])
  assert.ok(warnings.length >= 1)
  assert.ok(warningMsg.includes('dead'))
  // 不抛错才代表不拖垮 CLI 启动
})

test('remoteToolToToolDef 的 ask 权限 & 元标记', () => {
  const fakeClient = { callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }) }
  const def = remoteToolToToolDef(fakeClient, 'banana', { name: 'peel', description: 'a', inputSchema: { type: 'object' } })
  assert.equal(def.name, 'banana:peel')
  assert.equal(def.permissionLevel, 'ask')
  assert.equal(def._mcpserver, 'banana')
  assert.equal(def._mcptool, 'peel')
})
