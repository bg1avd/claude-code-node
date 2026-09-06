/**
 * 从 config.json 的 `mcp.servers` 装载远程 MCP 工具 → 注入 ToolRegistry。
 *
 * 这是「B：通用 MCP 接线」的核心：用户在配置里写好 mcp.servers 后，
 * 运行时自动连接每个 MCP server、把它们暴露的 tool 变成可被模型直接调用的 ToolDef。
 * 不配置 mcp.servers 就完全不生效，不影响任何既有功能。
 *
 * 健壮性设计：
 *   - 连接是 best-effort：超时/连不上只告警跳过，绝不阻塞 CLI 启动、绝不崩进程
 *   - 每个 MCP 服务器连接可带超时（connectTimeoutMs 或默认 8s）
 *   - 工具命名：为避免与内置工具撞名/被模型滥用，用 "<server>:<tool>"
 *     形式注册，并在 description 里标注来源服务器。
 *   - 权限：与 webSearchTool 一致走普通 ask 确认流，不绕过安全模型。
 */
import { MCPRegistry } from './index.js'
import { ToolDef } from '../types/index.js'

/** 连接单个 server 的超时（毫秒），防止网络卡住拖慢启动 */
const DEFAULT_CONNECT_TIMEOUT = 8000

function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 连接超时(>${ms}ms)`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * 把一个远程 tool 定义转成本地 ToolDef 代理。
 * 代理 handler 触发真正调用（经 MCPClient.callTool）。
 * @param {MCPClient} client
 * @param {string} serverName
 * @param {object} remoteTool {name, description, inputSchema}
 * @returns {ToolDef}
 */
export function remoteToolToToolDef(client, serverName, remoteTool) {
  const localName = `${serverName}:${remoteTool.name}`
  const def = new ToolDef(
    localName,
    (remoteTool.description || '') + `\n[通过 MCP 服务器「${serverName}」提供]`,
    remoteTool.inputSchema || { type: 'object', properties: {} },
    async (input, _ctx) => {
      const res = await client.callTool(remoteTool.name, input || {})
      // MCP tools/call 结果 content 是数组（[{type:'text',text}] 等）→ 拼接成文本
      const content = res && res.content
      if (Array.isArray(content)) {
        return content
          .map((c) => (c && c.type === 'text' ? c.text : (c && c.text) || JSON.stringify(c)))
          .join('\n')
      }
      return (res && (res.text !== undefined ? res.text : JSON.stringify(res))) || '[空结果]'
    },
    'ask', // 走普通需要确认的权限流
  )
  // 标记来源，便于 tools 列表/审计识别来自 MCP 的工具
  def._mcpserver = serverName
  def._mcptool = remoteTool.name
  return def
}

/**
 * 依据 config 的 mcp.servers 连接并生成 MCP 工具的 ToolDef 列表。
 *
 * @param {object|null} config  Config 对象（有 .get），或 null
 * @param {object} [opts]
 * @param {(msg:string)=>void} [opts.log]       日志（默认 console.error）
 * @param {boolean} [opts.exposeRaw]            内部使用，测试注入
 * @returns {Promise<{tools:ToolDef[], registry:MCPRegistry|null, warnings:string[]}>}
 */
export async function loadMcpToolsFromConfig(config, opts = {}) {
  const log = opts.log || ((m) => console.error(m))
  const warnings = []
  if (!config) return { tools: [], registry: null, warnings }

  // 兼容两种调用：传 Config 实例（带 .get）或传已解出的 mcp 对象
  let mcpObj = null
  try {
    if (config && typeof config.get === 'function') {
      mcpObj = config.get('mcp') || {}
    } else if (config && config.mcp) {
      mcpObj = config.mcp
    }
  } catch {
    mcpObj = {}
  }
  const serversConfig = (mcpObj && mcpObj.servers) || {}

  const names = Object.keys(serversConfig)

  if (names.length === 0) return { tools: [], registry: null, warnings } // 未配置 mcp → 不影响

  const registry = new MCPRegistry()
  const defs = []
  for (const name of names) {
    const serverCfg = serversConfig[name]
    if (!serverCfg) continue
    registry.register(name, serverCfg)
    const connectMs = serverCfg.connectTimeoutMs || serverCfg.timeoutMs || DEFAULT_CONNECT_TIMEOUT
    try {
      const client = await withTimeout(registry.connect(name), connectMs, `MCP server「${name}」`)
      const remoteTools = client && client.tools ? client.tools : []
      if (!remoteTools.length) {
        warnings.push(`MCP server「${name}」已连接但未暴露任何工具`)
        continue
      }
      for (const rt of remoteTools) {
        defs.push(remoteToolToToolDef(client, name, rt))
      }
      log(`[mcp] 已加载服务器「${name}」 → ${remoteTools.map((t) => t.name).join(', ')}`)
    } catch (err) {
      // best-effort：单个坏服务器不影响其它
      warnings.push(`MCP server「${name}」加载失败: ${(err && err.message) || err}`)
      log(`[mcp] 服务器「${name}」连接失败: ${(err && err.message) || err}（跳过）`)
      try { registry.close(name) } catch { /* ignore */ }
    }
  }

  return { tools: defs, registry, warnings }
}

/** 关闭所有已连接的 MCP（进程退出前调用） */
export async function closeMcpTools(registry) {
  if (registry) await registry.closeAll().catch(() => {})
}
