/**
 * CLI 入口 — 命令行解析和 REPL 循环
 * 对应原版: src/cli/ + src/entrypoints/
 * 
 * v1.2: 增加 Unix socket 服务，让 cc-notify 能发现并转发消息
 */
import * as readline from 'readline'
import { createMultilineInput } from './multiline-input.js'
import { createServer as createNetServer } from 'net'
import { writeFileSync, unlinkSync, existsSync, mkdirSync, readFileSync, chmodSync } from 'fs'
import { join } from 'path'
import { QueryEngine, QueryEngineConfig } from './query-engine.js'
import { createDefaultRegistry } from '../tools/index.js'
import { SessionManager } from './session.js'
import { Config } from './config.js'
import { TokenBudget } from './token-budget.js'
import { ChannelManager } from '../channel/index.js'
import { CostTracker } from './cost-tracker.js'
import { compactMessages } from './compact.js'
import {
  detectContextWindow,
  parseWindowArg,
  formatTokens,
  windowSourceLabel,
  WINDOW_SOURCE,
} from './context-window.js'
import { isLocalLlmServer } from '../utils/index.js'
import { SOCK_DIR, SOCK_PATH, CC_NODE_PID } from './paths.js'
import { renderHeadpiece } from './headpiece.js'
import { TelegramListener } from '../channel/tg-listener.js'
import { fetchViaSocks5 } from '../channel/tg-proxy.js'

// ============================================================
// Unix Socket — 让 cc-notify 能发现 cc-node
// ============================================================



/**
 * 启动 Unix socket 服务器
 * cc-notify 通过此 socket 转发消息给已运行的 cc-node
 */
function startSocketServer(engine, session, sessionManager, channelManager, verbose) {
  mkdirSync(SOCK_DIR, { recursive: true })

  // v1.1 修复: 安全清理残留 socket — 检查 PID 文件确认进程已死
  if (existsSync(SOCK_PATH)) {
    let shouldClean = true
    if (existsSync(CC_NODE_PID)) {
      try {
        const oldPid = parseInt(readFileSync(CC_NODE_PID, 'utf8').trim(), 10)
        // 检查旧进程是否还活着
        process.kill(oldPid, 0) // 如果进程存在且活着，这不会抛出
        shouldClean = false // 旧进程还活着，不要清理
        console.error(`cc-node already running (PID ${oldPid}). Use /exit first or kill ${oldPid}`)
        process.exit(1)
      } catch {
        // 旧进程已死，安全清理
      }
    }
    if (shouldClean) {
      try { unlinkSync(SOCK_PATH) } catch {}
    }
  }

  const server = createNetServer((client) => {
    // v1.1: socket 连接来源验证 — 只允许同用户连接
    // Unix socket 本身通过文件系统权限保护
    let buffer = ''

    client.on('data', async (data) => {
      buffer += data.toString()

      // 按行解析 JSON 消息
      const lines = buffer.split('\n')
      buffer = lines.pop() // 保留不完整的行

      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const msg = JSON.parse(line)
          if (msg.type === 'user_input' && msg.text) {
            // 转发到引擎处理
            const result = await engine.processMessage(msg.text)
            const reply = JSON.stringify({ type: 'reply', text: result.response }) + '\n'
            client.write(reply)

            // 保存到会话
            await sessionManager.appendMessage({ role: 'user', content: msg.text })
            await sessionManager.appendMessage({ role: 'assistant', content: result.response })
      // M5: 保存 engine state 到 session
      session.state = session.state || {}
      session.state.turnCount = engine.state.turnCount
      session.state.costHistory = engine.costTracker.history.slice(-50) // 只保留最近50条
      await sessionManager.save(session)
          } else if (msg.type === 'ping') {
            client.write(JSON.stringify({ type: 'pong', pid: process.pid }) + '\n')
          }
        } catch (e) {
          client.write(JSON.stringify({ type: 'error', text: e.message }) + '\n')
        }
      }
    })

    client.on('error', () => {}) // 忽略连接断开
  })

  server.listen(SOCK_PATH, () => {
    // v1.1 修复: socket 文件权限 0600（仅所有者可读写），阻止其他用户连接
    // Windows named pipe 不支持 chmod，跳过
    try { if (!process.platform.startsWith('win')) chmodSync(SOCK_PATH, 0o600) } catch {}
    // 写 PID 文件（权限 0644）
    writeFileSync(CC_NODE_PID, String(process.pid), { mode: 0o644 })
  })

  // 关键修复: 监听 socket 失败时绝不能崩溃（如 Windows 权限 / 端口占用）。
  // 否则触发 Unhandled 'error' event 导致整个 cc-node 进程退出。
  server.on('error', (err) => {
    console.error(`⚠️  Socket 监听失败（${err.code || err.message}）— cc-notify 远程转发将不可用，但 REPL 仍可正常使用。`)
    console.error(`   Path: ${SOCK_PATH}`)
  })

  // 退出时清理
  const cleanup = () => {
    try { unlinkSync(SOCK_PATH) } catch {}
    try { unlinkSync(CC_NODE_PID) } catch {}
  }
  process.on('SIGTERM', cleanup)
  process.on('SIGINT', cleanup)
  process.on('exit', cleanup)

  return server
}

// ============================================================
// Banner & Help
// ============================================================

// ============================================================
// Banner & Help
// ============================================================

// 版本号（从 package.json 读取或手动更新）
let CC_NODE_VERSION = '2.2.7'
try {
  const pkgPath = new URL('../../package.json', import.meta.url)
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  CC_NODE_VERSION = pkg.version || CC_NODE_VERSION
} catch {}

// 生成 Claude Code 风格的三栏 Banner
function buildBanner({ model, permissionMode, session, maxTokens }) {
  const width = 112
  const inner = width - 2
  const leftLabel = ` CC-Node v${CC_NODE_VERSION} `
  const top = `╭${leftLabel}${'─'.repeat(inner - leftLabel.length)}╮`
  const bottom = `╰${'─'.repeat(inner)}╯`

  const col1 = 24 // 左侧头标列（头标宽度 20 + 边距）
  const col2 = 50 // 标题列
  const col3 = inner - col1 - col2 - 2 // 信息列

  // 头标（独立模块 headpiece.js 提供，替换只需改该文件）
  const headpiece = renderHeadpiece({ colWidth: col1 })
  const robotLines = headpiece.lines

  // 去掉 ANSI 转义码，返回真实可见长度
  const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '')

  // 辅助函数：字符串填充（忽略 ANSI 颜色码计算真实长度，正确处理嵌入在字符串中的 ANSI）
  const realLen = (s) => stripAnsi(s).length

  const pad = (s, w, align = 'left') => {
    const rlen = realLen(s)
    if (rlen >= w) {
      // 需要截断，但保留 ANSI 序列
      const result = stripAnsi(s).substring(0, w)
      // 把截断后的字符对应的 ANSI 序列加回去（简化处理：只保留前导 ANSI）
      const leadingAnsi = s.match(/^(\x1b\[[0-9;]*m)*/)?.[0] || ''
      return leadingAnsi + result
    }
    const spaces = w - rlen
    const afterAnsi = stripAnsi(s) // 纯文本
    let result
    if (align === 'center') {
      const l = Math.floor(spaces / 2)
      result = ' '.repeat(l) + afterAnsi + ' '.repeat(spaces - l)
    } else if (align === 'right') {
      result = ' '.repeat(spaces) + afterAnsi
    } else {
      result = afterAnsi + ' '.repeat(spaces)
    }
    // 加回前导 ANSI
    const leadingAnsi = s.match(/^(\x1b\[[0-9;]*m)*/)?.[0] || ''
    return leadingAnsi + result
  }

  // 标题列（居中，行数匹配 robotLines，内容放在中间行）
  const baseTitleLines = [
    pad('AI Code Agent', col2, 'center'),
    pad('Node.js Edition', col2, 'center'),
    pad('', col2, 'center'),
    pad('─'.repeat(col2 - 2), col2, 'center'),
    pad('/help — commands · /exit — quit', col2, 'center')
  ]
  // 内容从第2行开始（让分隔线与机器人中间横线对齐）
  const titleStart = 1
  const titleLines = []
  for (let i = 0; i < robotLines.length; i++) {
    const ti = i - titleStart
    if (ti >= 0 && ti < baseTitleLines.length) {
      titleLines.push(baseTitleLines[ti])
    } else {
      titleLines.push(pad('', col2, 'center'))
    }
  }

  // 信息列（右对齐，内容放在中间行）
  const sessionId = session?.id || '??????'
  const baseInfoLines = [
    pad(`Turns: ${session?.state?.turnCount ?? 0}  •  Tools: 0`, col3, 'right'),
    pad(`Model: ${model}`, col3, 'right'),
    pad(`Permission: ${permissionMode}`, col3, 'right'),
    pad(`Budget: 0 / ${maxTokens ?? 200000}`, col3, 'right'),
    pad(`Session: ${sessionId?.toString().slice(-6)}`, col3, 'right')
  ]
  const infoStart = 1
  const infoLines = []
  for (let i = 0; i < robotLines.length; i++) {
    const ti = i - infoStart
    if (ti >= 0 && ti < baseInfoLines.length) {
      infoLines.push(baseInfoLines[ti])
    } else {
      infoLines.push(pad('', col3, 'right'))
    }
  }

  // 构建每行：│ col1 │ col2 │ col3 │
  const lines = [top]
  const empty = `│${' '.repeat(inner)}│`
  lines.push(empty)

  for (let i = 0; i < robotLines.length; i++) {
    lines.push(`│${robotLines[i]}│${titleLines[i]}│${infoLines[i]}│`)
  }

  lines.push(empty)
  lines.push(bottom)
  return lines.join('\n')
}

const HELP_TEXT = `
Commands:
  /help          — Show this help
  /model NAME    — Switch model
  /models        — List available models from current API
  /tools         — List available tools
  /session       — Show session info
  /sessions      — List all sessions
  /clear         — Clear conversation
  /stop          — Stop current AI work (when stuck/long)
  /config KEY    — Show config value
  /budget        — Show token budget
  /window [N]    — Show/set context window (e.g. /window 128k, /window auto)
  /channel CMD   — Manage notification channels (list|send|test)
  /cost          — Show API cost report
  /compact       — Manually compact conversation context
  /cd PATH       — Change working directory
  /allow [tool|all|reset] — Allow tools for this session (default: all)
  /allow all   — automatically allow all subsequent tools
  /allow reset — reset to ask mode
  /allow <tool> — allow specific tool (e.g. Bash)
  /resume <session-id> — Resume a saved conversation
  /exit          — Exit (also Ctrl+C)
  /quit          — Same as /exit

  Use "/help <cmd>" for detailed help on a specific command.
`

const DETAILED_HELP = {
  help:    "/help [command]\n  Show help. Without argument: list all commands.\n  With a command name: show detailed help for that command.\n\n  Example: /help model",

  model:   "/model <model_name>\n  Switch the LLM model in real-time.\n  The change takes effect immediately for the next message.\n  You can use any model name supported by your current API provider.\n\n  Example: /model deepseek-chat\n  Example: /model gpt-4o",

  models:  "/models\n  Fetch and display all available models from the current API provider.\n  Shows a numbered list, then prompts you to select by number or name.\n  Requires a configured API key (the one you used to start cc-node).\n  Uses the endpoint: <apiBase>/models",

  tools:   "/tools\n  List all available tools that cc-node can use.\n  Shows tool names with their short descriptions.\n\n  Tools include: Bash, Read, Edit, Write, Glob, Grep,\n  WebFetch, WebSearch, AskUserQuestion, GitTool",

  session: "/session\n  Show current session information:\n  - Session ID\n  - Session title\n  - Number of messages\n  - Number of tool call turns",

  sessions:"/sessions\n  List all saved sessions.\n  Shows session ID, title, message count, and last update time.\n\n  Use /resume <session-id> to restore a saved conversation.",

  resume:  "/resume <session-id>\n  Restore a saved conversation by session ID.\n  Session ID can be the full ID or the numeric index from /sessions list.\n\n  Example: /resume session-1779605332906-52da0706986efa67\n  Example: /resume 1 (resume the first session in the list)",

  clear:  "/clear\n  Clear the current conversation context.\n  Starts a fresh session. Previous messages are not sent to the API anymore.\n\n  Note: Does not delete saved sessions.",

  stop:  "/stop\n  Stop the currently running AI work.\n  Use when the AI appears stuck or takes too long to respond.\n  Sends an abort signal to interrupt the current task.\n  After stopping, you can issue a new command.",

  config:  "/config [key]\n  Without key: show the entire config as JSON.\n  With a key path: show the value for that specific path.\n\n  Example: /config\n  Example: /config model",

  budget:  "/budget\n  Show token budget usage for the current session.\n  Displays how many tokens have been used vs the limit.",

  window:  "/window [N|auto|reset]\n  Show or set the LLM context window (max tokens allowed in conversation).\n  This is the hard ceiling for auto-compression — context will never exceed it.\n\n  Subcommands:\n    (no arg)   — Show current window + its source (manual/probe/table/fallback) + usage\n    /window 128k — Manually set window (persisted to config). Accepts K/M suffix:\n                  64k, 128k, 200k, 1m, or a raw number like 131072.\n    /window auto  — Clear manual override, return to auto-detection (next message re-detects).\n    /window reset — Clear manual override AND re-detect now.\n\n  Manual setting takes priority over auto-detection and survives restart.\n  Auto-detection itself is NOT persisted (re-runs at each startup).\n\n  Examples:\n    /window\n    /window 128k\n    /window 64k\n    /window auto\n    /window reset",

  channel: "/channel <list|send|test>\n  Manage notification channels.\n\n  Subcommands:\n    list       — List all configured notification channels\n    send <msg> — Send a message via all channels\n    test       — Send a test message to verify channels\n\n  Requires channel environment variables to be set at startup.",

  cost:    "/cost\n  Show API cost report.\n  Displays total tokens used and estimated cost in USD.\n  Supports pricing for: DeepSeek, OpenAI, Qwen, GLM, Kimi.",

  compact: "/compact\n  Manually trigger context compression.\n  Compresses the conversation history to fit within the token budget.\n  Keeps recent turns intact, compresses older ones.\n\n  Typically triggered automatically at 80% budget usage.",

  cd:      "/cd <path>\n  Change the working directory of cc-node.\n  Affects all subsequent tool executions (Bash, Read, Write, etc.).\n\n  Without path: show the current working directory.\n\n  Example: /cd /home/yourname/projects\n  Example: /cd ..",

  allow:   "/allow [tool|all|reset]\n  Manage tool permissions for this session.\n\n  Options:\n    <tool>   — allow a specific tool (e.g. Bash, Write, Read)\n    all      — automatically allow ALL remaining tools for this session\n    reset    — reset to ask mode (ask for each tool)\n    (no arg) — same as /allow all\n\n  When asked to confirm a tool, you can also type:\n    y — allow this once\n    a — allow all for the rest of the session\n\n  Example: /allow Bash\n  Example: /allow all\n  Example: /allow reset",

  exit:    "/exit\n  Exit cc-node. Same as Ctrl+C or /quit.",
  quit:    "/quit\n  Exit cc-node. Same as Ctrl+C or /exit.",
}

// ============================================================
// 参数解析
// ============================================================

function parseArgs(argv) {
  const args = {
    model: 'deepseek-chat',
    systemPrompt: '',
    permissionMode: 'ask',
    maxTurns: 100,
    verbose: false,
    apiBase: 'https://api.deepseek.com/v1',
    resume: null,
    noStream: false,
    maxMessages: 0,
    smallModel: false,
  }

  let i = 2
  while (i < argv.length) {
    const arg = argv[i]
    switch (arg) {
      case '--model': case '-m': args.model = argv[++i]; break
      case '--system-prompt': case '-s': args.systemPrompt = argv[++i]; break
      case '--permission-mode': case '-p': args.permissionMode = argv[++i]; break
      case '--max-turns': case '-t': args.maxTurns = parseInt(argv[++i], 10); break
      case '--api-key': args.apiKey = argv[++i]; break
      case '--api-base': args.apiBase = argv[++i]; break
      case '--resume': case '-r': args.resume = argv[++i]; break
      case '--verbose': case '-v': args.verbose = true; break
      case '--no-stream': args.noStream = true; break
      case '--max-messages': args.maxMessages = parseInt(argv[++i], 10); break
      case '--small-model': args.smallModel = true; break
      case '--stdio': args.stdio = true; break
      case '--with-notify': args.withNotify = true; break
      case '--version':
        const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
        console.log(pkg.version)
        process.exit(0)
      case '--help': case '-h':
        console.log(`Usage: cc-node [options] [prompt]

Options:
  -m, --model NAME          Model to use
  -s, --system-prompt TEXT  System prompt
  -p, --permission-mode     Permission mode: ask|always-allow|deny
  -t, --max-turns N         Max tool loop turns (default: 100)
  --api-base URL            API base URL
  --api-key ***             API key (or set LLM_API_KEY env)
  -r, --resume ID           Resume a session
  --version                 Show version
  -v, --verbose             Verbose mode
  --no-stream               Disable streaming
  --max-messages N          Fold history when message count exceeds N (default: 0 = off)
  --small-model             Enable small-model adaptation (tool-call enforcement, filler retry, intent guidance)
  --with-notify             Start built-in channel listener (Telegram)
                            (replaces cc-notify daemon — no external script needed)
  -h, --help                Show this help

Environment variables:
  LLM_API_KEY, DEEPSEEK_API_KEY, OPENAI_API_KEY,
  QWEN_API_KEY, GLM_API_KEY, KIMI_API_KEY, LLM_API_BASE

Channel environment variables:
  CC_NODE_CHANNEL_DEFAULT, CC_NODE_CHANNEL_TELEGRAM_TOKEN,
  CC_NODE_CHANNEL_TELEGRAM_CHAT_ID, CC_NODE_CHANNEL_WECOM_WEBHOOK_URL,
  CC_NODE_CHANNEL_FEISHU_WEBHOOK_URL, CC_NODE_CHANNEL_DISCORD_WEBHOOK_URL,
  CC_NODE_CHANNEL_SLACK_WEBHOOK_URL

Unix Socket (for cc-notify):
  ${SOCK_PATH}  — cc-notify 通过此 socket 转发消息
`)
        process.exit(0)
      default:
        if (!arg.startsWith('-')) {
          args.oneShot = argv.slice(i).join(' ')
          i = argv.length
        }
        break
    }
    i++
  }
  return args
}

// ============================================================
// 主入口
// ============================================================

export async function main() {
  const cliArgs = parseArgs(process.argv)

  // P1: stdio 服务器模式（JSON-RPC 2.0 over NDJSON，供桥接层/外部客户端接入）
  if (cliArgs.stdio) {
    const { StdioServer } = await import('../stdio/server.js')
    const server = new StdioServer({ cliArgs })
    server.start()
    return
  }

  const config = new Config()
  await config.load(process.cwd())

  const apiBase = cliArgs.apiBase || config.get('apiBase') || process.env.LLM_API_BASE || ''
  // apiBase 指向自建本地服务（Ollama / llama.cpp / vLLM 等）时允许缺省 apiKey
  const localApiBase = isLocalLlmServer(apiBase)
  let model = cliArgs.model || config.get('model') || ''
  // 未指定模型 → 自动从 API 拉取模型列表让用户选择
  // 本地自建服务即使无 key 也尝试拉取（这些服务通常无需认证）
  if (!model && apiBase) {
    const apiKeyForModels = cliArgs.apiKey || config.get('apiKey') || process.env.LLM_API_KEY || process.env.DEEPSEEK_API_KEY || ''
    if (apiKeyForModels || localApiBase) {
      try {
        const modelsUrl = apiBase.replace(/\/+$/, '') + '/models'
        console.log('⚠️  未指定模型，正在从 API 获取可用模型列表...')
        const res = await fetch(modelsUrl, {
          headers: {
            'Content-Type': 'application/json',
            ...(apiKeyForModels ? { 'Authorization': `Bearer ${apiKeyForModels}` } : {}),
          },
        })
        if (res.ok) {
          const data = await res.json()
          const models = data.data || []
          if (models.length > 0) {
            console.log(`\n可用模型 (${models.length}):`)
            models.forEach((m, i) => {
              const id = m.id || m
              console.log(`  ${(i + 1).toString().padStart(2)}. ${id}`)
            })
            console.log('输入编号选择，或直接输入模型名（回车跳过用 deepseek-chat）:')
            // 用 readline 等待输入（此时 REPL 还没启动，需要临时创建）
            const tmpRl = readline.createInterface({ input: process.stdin, output: process.stdout })
            const answer = await new Promise(resolve => tmpRl.question('> ', resolve))
            tmpRl.close()
            const num = parseInt(answer, 10)
            if (!isNaN(num) && num >= 1 && num <= models.length) {
              model = models[num - 1].id || models[num - 1]
            } else if (answer.trim()) {
              model = answer.trim()
            } else {
              model = 'deepseek-chat'
            }
            console.log(`✅ Model → ${model}`)
          } else {
            model = 'deepseek-chat'
            console.log('API 返回空模型列表，使用默认: deepseek-chat')
          }
        } else {
          model = 'deepseek-chat'
          console.log('无法获取模型列表，使用默认: deepseek-chat')
        }
      } catch (e) {
        model = 'deepseek-chat'
        console.log(`获取模型列表失败 (${e.message})，使用默认: deepseek-chat`)
      }
    } else {
      model = 'deepseek-chat'
    }
  } else if (!model) {
    model = 'deepseek-chat'  // 无 apiBase 也无 model → DeepSeek 默认
  }
  const DEFAULT_SYSTEM_PROMPT = `You are cc-node, an AI coding assistant. Configuration files: user-level ~/.claude-code/config.json, project-level .claude-code/config.json (in project root). Runtime files (pid/socket): ~/.cc-node/. Never reference settings.json or .claude.json — those paths do not exist.`
const systemPrompt = cliArgs.systemPrompt || DEFAULT_SYSTEM_PROMPT
  const permissionMode = cliArgs.permissionMode || config.get('permissionMode')
  const maxTurns = cliArgs.maxTurns || config.get('maxTurns')
  const apiKey = cliArgs.apiKey || config.get('apiKey') || ''
  const verbose = cliArgs.verbose || config.get('verbose')

  const registry = createDefaultRegistry()
  const sessionManager = new SessionManager({ sessionsDir: config.get('sessionsDir') })

  let session
  if (cliArgs.resume) {
    session = await sessionManager.load(cliArgs.resume)
    if (!session) { console.error(`Session not found: ${cliArgs.resume}`); process.exit(1) }
  } else {
    session = await sessionManager.create()
  }

  // M1 fix: tokenBudget 必须在 engineConfig 之前定义，否则 TDZ ReferenceError
  // 上下文窗口来源：手动指定 > API 探测 > 内置表 > 安全兜底
  //   - 手动指定（config.maxBudgetTokens > 0）优先，且持久化
  //   - 自动探测结果不落盘，每次启动重新探测（方案 A）
  let windowSource = WINDOW_SOURCE.FALLBACK
  const tokenBudget = new TokenBudget({
    maxTokens: config.get('maxBudgetTokens') || 0,
  })

  /** 重新探测并应用上下文窗口（供启动 & /window reset & /model 切换后调用） */
  async function reapplyWindow() {
    const manual = config.get('maxBudgetTokens') || 0
    const { window: win, source } = await detectContextWindow({
      model,
      apiBase,
      apiKey,
      manualWindow: manual,
    })
    tokenBudget.setWindow(win, source)
    windowSource = source
    return { window: win, source }
  }

  // 启动即探测一次（若已手动指定，则直接应用手动值）
  await reapplyWindow()

  const costTracker = new CostTracker({ model })

  const engineConfig = new QueryEngineConfig({
    model, systemPrompt, permissionMode, maxTurns, apiBase, apiKey, verbose,
    tools: registry.getAll(),
    noStream: cliArgs.noStream,
    costTracker,
    tokenBudget,
    configStore: config,
    // 消息条数上限（折叠早期历史，解决本地小模型"条数过多变傻"）；0 = 关闭
    maxMessages: cliArgs.maxMessages || config.get('maxMessages') || 0,
    // 小模型适配模式（强制工具调用 + 敷衍重试 + 意图引导 + 工具精简）
    smallModel: cliArgs.smallModel || config.get('smallModel') || false,
  })
  const engine = new QueryEngine(engineConfig)

  // M5: 恢复会话历史和状态 — 完整恢复所有角色（含 tool_calls、tool 结果）
  if (session?.messages?.length) {
    for (const msg of session.messages) {
      const entry = { role: msg.role, content: msg.content }
      if (msg.role === 'assistant' && msg.toolCalls?.length > 0) {
        entry.toolCalls = msg.toolCalls
      }
      if (msg.role === 'tool' && msg.tool_call_id) {
        entry.tool_call_id = msg.tool_call_id
      }
      engine.state.messages.push(entry)
    }
    // 恢复 turn count
    if (session.state?.turnCount) engine.state.turnCount = session.state.turnCount
    // 恢复费用记录
    if (session.state?.costHistory) {
      for (const record of session.state.costHistory) {
        engine.costTracker.recordUsage(record)
      }
    }
  }


  const channelManager = new ChannelManager({
    channels: config.get('channels') || {},
    defaultChannel: config.get('defaultChannel') || null,
  })

  // 一次性输入模式
  if (cliArgs.oneShot) {
    // 一次性模式下用户已明确表达了执行意图，自动批准所有工具调用
    if (engine.permissionChecker.mode === 'ask') {
      engine.config.onConfirmTool = async () => true
    }
    const result = await engine.processMessage(cliArgs.oneShot)
    // 引擎已流式输出正文（无 onDelta 时引擎内部直写终端）→ 不再重复打印，避免"回答两次"
    if (!engine.lastStreamed) console.log(result.response)
    // 保存会话
    session = await sessionManager.create(`one-shot: ${cliArgs.oneShot.slice(0, 50)}`)
    await sessionManager.appendMessage({ role: 'user', content: cliArgs.oneShot })
    await sessionManager.appendMessage({ role: 'assistant', content: result.response })
    if (channelManager.list().length > 0) {
      await channelManager.sendTemplate('task-done', {
        task: cliArgs.oneShot.slice(0, 80),
        result: result.response.slice(0, 200),
      }).catch(() => {})
    }
    process.exit(0)
  }

  // REPL 模式 — 启动 Unix socket 让 cc-notify 能发现
  startSocketServer(engine, session, sessionManager, channelManager, verbose)

  // ============================================================
  // REPL 输入处理 — 多行输入（读取完整输入再处理）
  //
  // 不再用 readline 的 line 事件（它遇到 \n 就提交当前行，导致
  // 多行文本被断句，后续行在引擎忙时被丢弃）。
  // 改用 keypress + raw mode 自己管理输入缓冲（见 multiline-input.js）：
  //   - Enter（\r）→ 提交整段输入（含内嵌换行）
  //   - Ctrl+Enter / Alt+Enter / Ctrl+J → 折行，多行输入（不提交）
  //   - 可打印字符回显、退格、上下方向键历史、Ctrl+C
  //   - 非 TTY（管道/重定向）回退到 readline line 事件
  // ============================================================
  const inputCtrl = createMultilineInput({
    prompt: '> ',
    onSubmit: (text) => { processInputLine(text) },
    onExit: () => { process.exit(0) },
  })

  // 显示提示符
  function showPrompt() {
    inputCtrl.showPrompt()
  }

  // 单行问题收集（权限确认 / /models 选择 / AskUserQuestion）
  // 返回 Promise<string>，在 keypress 模式下与多行输入共用同一 stdin，
  // 避免 readline 的 question 与主循环 keypress 互相干扰。
  function askQuestion(questionText) {
    return inputCtrl.ask(questionText)
  }

  // 兼容对象：供 AskUserQuestion 工具和引擎的 ctx.readline.question() 使用
  const rl = {
    question: (q, cb) => { askQuestion(q).then(cb) },
  }

  // Telegram 双向通道（可选）：tgListener 监听 Telegram 消息，tgChatId 记录回复目标
  let tgListener = null
  let tgChatId = null
  let tgReplyTarget = null
  // 当前正在处理的请求来源（'cli' | 'telegram'）— 用于权限确认等按来源分支的逻辑
  let currentSource = 'cli'
  // 等待中的 Telegram 权限确认（resolve 回调）— 远程用户回复 y/n/a 时响应
  let pendingConfirm = null
  // 最近一次 /models 拉取的模型列表（供 /model <编号> 选择）
  let modelList = []
  // /models 从 Telegram 发出后，等待用户回复编号/名字来选择模型
  let pendingModelSelect = false
  // 流式输出标志 — onDelta 已实时把回答输出到终端时，不再重复打印完整 response
  let streamedText = false

  // 处理输入行
  // source: 'cli' 来自终端输入, 'telegram' 来自 Telegram
  async function processInputLine(input, source = 'cli', tgChatId = null) {
    const trimmed = input.trim()
    if (!trimmed) { showPrompt(); return }

    // 记录当前请求来源，供 onConfirmTool 等按来源分支的逻辑使用
    currentSource = source

    // 关键：来自 Telegram 的消息，如果当前正在等待远程权限确认（pendingConfirm），
    // 则把它当作确认回复（y/n/a）处理，而不是当作新的 REPL 输入。
    // 注意：/ 开头的命令优先走命令分支，不被权限确认拦截（否则 /quit、/stop 会被吞）。
    // （AskUserQuestion 已改为异步发问，不再依赖 pendingAskUser 挂起结构——用户回复
    //   作为正常消息进入引擎处理，无锁死/发呆问题。）
    if (source === 'telegram' && pendingConfirm && !trimmed.startsWith('/')) {
      const confirm = pendingConfirm
      pendingConfirm = null
      const a = trimmed.toLowerCase()
      if (a === 'a') {
        try { engine.permissionChecker.allowAllForSession() } catch {}
        confirm(true)
      } else if (a === 'y') {
        confirm(true)
      } else if (a === 'n') {
        confirm(false)
      } else {
        // 不是 y/n/a，忽略这次（不打断确认等待），但也可能是误发，继续等待
        pendingConfirm = confirm
        if (tgListener?.bot) {
          await sendTelegram('⚠️ 请回复 y（允许一次）/ n（拒绝）/ a（本会话全部允许）', tgChatId || null).catch(() => {})
        }
      }
      return
    }

    // /models 从 Telegram 发出后，用户回复编号或名字来选择模型
    if (source === 'telegram' && pendingModelSelect && !trimmed.startsWith('/')) {
      const num = parseInt(trimmed, 10)
      let selected = ''
      if (!isNaN(num) && num >= 1 && num <= modelList.length) {
        selected = modelList[num - 1]
      } else if (modelList.includes(trimmed)) {
        selected = trimmed
      }
      // 无论是否是有效选择，都结束"等待选择"状态
      pendingModelSelect = false
      if (selected) {
        engine.config.model = selected
        console.log(`Model → ${selected}`)
        if (tgListener?.bot) {
          await sendTelegram(`✅ 已切换模型 → ${selected}`, tgChatId || null).catch(() => {})
        }
        return
      }
      // 不是有效选择 → 当作普通消息继续处理
    }

    if (trimmed.startsWith('/')) {
      // 用户输入了命令，取消可能存在的"等待模型选择"状态
      pendingModelSelect = false
      // 来自 Telegram 的命令：捕获 console 输出并回发到 Telegram
      const isTgCmd = source === 'telegram' && tgListener?.bot
      let tgOut = ''
      const origLog = console.log
      if (isTgCmd) {
        tgOut = ''
        console.log = (...args) => { tgOut += args.map(String).join(' ') + '\n'; origLog(...args) }
      }
      try {
      const [cmd, ...rest] = trimmed.slice(1).split(' ')
      switch (cmd) {
        case 'help':
          if (rest[0]) {
            const detail = DETAILED_HELP[rest[0].toLowerCase()]
            if (detail) console.log(detail)
            else console.log(`No detailed help for /${rest[0]}. Type /help for all commands.`)
          } else {
            console.log(HELP_TEXT)
          }
          break
        case 'model':
          // /model <名字或编号> — 支持用 /models 列表里的编号切换
          if (rest[0]) {
            const num = parseInt(rest[0], 10)
            if (!isNaN(num) && modelList.length > 0 && num >= 1 && num <= modelList.length) {
              engine.config.model = modelList[num - 1]
            } else {
              engine.config.model = rest.join(' ')
            }
            model = engine.config.model
            console.log(`Model → ${engine.config.model}`)
            // 切换模型后重新探测上下文窗口（仅当非手动指定时自动更新）
            if ((config.get('maxBudgetTokens') || 0) <= 0) {
              const { window: win, source } = await reapplyWindow()
              console.log(`  ↳ Context window → ${formatTokens(win)} (${windowSourceLabel(source)})`)
            }
          }
          else console.log(`Model: ${engine.config.model}`)
          break
        case 'window': {
          const arg = rest[0] ? rest.join(' ').trim() : ''
          if (!arg) {
            // 无参数：显示当前窗口 + 真实 context 用量
            // 用实时估算（estimateMessages）反映"当前 context 填充了多少窗口"，
            // 而非依赖 usage 上报的 inputTokens——本地网关不返回 usage 时
            // inputTokens 恒为 0，无法反映真实填充情况。
            const estTokens = engine.tokenBudget.estimateMessages(engine.state.messages)
            const windowTokens = engine.tokenBudget.maxTokens
            const reserved = engine.tokenBudget.reservedForOutput || 0
            const pct = windowTokens > 0
              ? Math.min(100, Math.round((estTokens / (windowTokens - reserved)) * 100))
              : 0
            console.log(`Context window: ${formatTokens(tokenBudget.maxTokens)} (${windowSourceLabel(windowSource)})`)
            console.log(`  Context used: ${estTokens.toLocaleString()} / ${windowTokens.toLocaleString()} (${pct}% of usable window)`)
            console.log(`  (real-time estimate; API-reported input: ${tokenBudget.inputTokens.toLocaleString()} tok)`)
            const manual = config.get('maxBudgetTokens') || 0
            if (manual > 0) console.log(`  Manual override: ${formatTokens(manual)} (persisted in config)`)
            break
          }
          const lower = arg.toLowerCase()
          if (lower === 'auto' || lower === 'reset') {
            // 清除手动指定并重新探测
            config.set('maxBudgetTokens', 0)
            try { await config.saveToUser() } catch {}
            const { window: win, source } = await reapplyWindow()
            console.log(`Cleared manual override. Context window → ${formatTokens(win)} (${windowSourceLabel(source)})`)
            break
          }
          const win = parseWindowArg(arg)
          if (!win) {
            console.log(`❌ Invalid window: "${arg}". Use a number or K/M suffix, e.g. /window 128k, /window 64k, /window 1m`)
            break
          }
          // 手动指定：立即生效 + 持久化
          tokenBudget.setWindow(win, WINDOW_SOURCE.MANUAL)
          windowSource = WINDOW_SOURCE.MANUAL
          config.set('maxBudgetTokens', win)
          try { await config.saveToUser() } catch (e) { console.log(`⚠️  Failed to persist to config: ${e.message}`) }
          console.log(`Context window → ${formatTokens(win)} (${windowSourceLabel(WINDOW_SOURCE.MANUAL)}, persisted)`)
          break
        }
        case 'models': {
          const apiBase = engine.config.apiBase
          const apiKey = engine.config.apiKey
          // 自建本地服务（Ollama/llama.cpp/vLLM）无需 apiKey 也能拉取模型列表
          const localServer = isLocalLlmServer(apiBase)
          if (!apiKey && !localServer) { console.log('❌ API key not configured'); break }
          const modelsUrl = apiBase.replace(/\/+$/, '') + '/models'
          console.log(`📡 Fetching models from ${modelsUrl}...`)
          try {
            const res = await fetch(modelsUrl, {
              headers: {
                'Content-Type': 'application/json',
                ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
              },
            })
            if (!res.ok) { console.log(`❌ API error: ${res.status}`); break }
            const data = await res.json()
            const models = data.data || []
            if (models.length === 0) { console.log('No models returned'); break }
            // 记录模型列表，供 /model <编号> 选择
            modelList = models.map(m => m.id || m)
            console.log(`\nAvailable models (${models.length}):`)
            modelList.forEach((id, i) => {
              console.log(`  ${(i + 1).toString().padStart(2)}. ${id}`)
            })
            // 来自 Telegram：直接列出，不等待 CLI 交互（用 /model 名字或编号 切换）
            if (source === 'telegram') {
              console.log('\nℹ️ 直接回复编号或模型名即可切换')
              pendingModelSelect = true  // 等待用户回复编号/名字来选择模型
              break
            }
            console.log('\nType a number to select, or model name directly:')
            const answer = await new Promise(resolve => rl.question('> ', resolve))
            const num = parseInt(answer, 10)
            let selected
            if (!isNaN(num) && num >= 1 && num <= modelList.length) {
              selected = modelList[num - 1]
            } else if (answer.trim()) {
              selected = answer.trim()
            }
            if (selected) {
              engine.config.model = selected
              console.log(`Model → ${selected}`)
            }
          } catch (err) {
            console.log(`❌ ${err.message}`)
          }
          break
        }
        case 'tools':
          console.log('Available tools:')
          for (const name of registry.getNames()) {
            const tool = registry.get(name)
            console.log(`  ${name} — ${tool.description.split('\n')[0]}`)
          }
          break
        case 'session':
          console.log(`Session: ${session.id}`)
          console.log(`Title: ${session.title}`)
          console.log(`Messages: ${session.messages?.length || 0}`)
          console.log(`Turns: ${engine.state.turnCount}`)
          break
        case 'resume': {
          if (rest.length === 0) {
            console.log('Usage: /resume <session-id> (from /sessions list)')
            break
          }
          const target = rest.join(' ')
          let sessionId = target
          if (/^\d+$/.test(target)) {
            const idx = parseInt(target, 10) - 1
            const list = await sessionManager.list()
            if (idx < 0 || idx >= list.length) {
              console.log(`❌ Session index out of range (1-${list.length})`)
              break
            }
            sessionId = list[idx].id
          }
          const loaded = await sessionManager.load(sessionId)
          if (!loaded) {
            console.log(`❌ Session not found: ${sessionId}`)
            break
          }
          session.id = loaded.id
          session.title = loaded.title
          session.messages = loaded.messages
          session.state = loaded.state || {}
          engine.state.messages = loaded.messages.map(m => ({
            role: m.role,
            content: m.content,
            toolCalls: m.toolCalls,
            toolCallId: m.toolCallId,
          }))
          engine.state.turnCount = loaded.state?.turnCount || 0
          if (engine.tokenBudget && loaded.state?.budgetUsed != null) {
            engine.tokenBudget.used = loaded.state.budgetUsed
          }
          console.log(`✅ Resumed session: ${loaded.title} (${loaded.id})`)
          console.log(`\n💡 Tip: Use /sessions to list, /resume <id> to switch.`)
          break
        }
        case 'sessions': {
          const sessions = await sessionManager.list()
          if (sessions.length === 0) console.log('No sessions found')
          else for (const s of sessions) console.log(`  ${s.id} — ${s.title} (${s.messageCount} msgs, ${s.updated})`)
          break
        }
        case 'clear':
          engine.reset()
          session = await sessionManager.create()
          console.log('Conversation cleared')
          break
        case 'stop':
          // 停止当前正在运行的 AI 工作（如卡死 / 长时间无响应时）。
          // AskUserQuestion 已改为异步发问（不挂起），无需在此取消 pending 等待。
          if (engine.state.isRunning) {
            engine.abort()
            console.log('⏹️  已发送停止信号，正在中止当前工作...')
          } else {
            console.log('（当前没有正在运行的任务）')
          }
          break
        case 'config':
          if (rest[0]) {
            const val = config.get(rest.join(' '))
            console.log(`${rest.join(' ')} = ${JSON.stringify(val, null, 2)}`)
          } else {
            console.log(JSON.stringify(config.toJSON(), null, 2))
          }
          break
        case 'budget': {
          console.log(tokenBudget.format())
          // 追加实时估算的 context 用量（本地网关不返回 usage 时 inputTokens 为 0，无法反映真实填充）
          const estTokens = engine.tokenBudget.estimateMessages(engine.state.messages)
          const winTk = engine.tokenBudget.maxTokens
          const pct = winTk > 0 ? Math.min(100, Math.round((estTokens / winTk) * 100)) : 0
          console.log(`  Context (est): ${estTokens.toLocaleString()} / ${winTk.toLocaleString()} (${pct}% of window)`)
          console.log(`Context window: ${formatTokens(tokenBudget.maxTokens)} (${windowSourceLabel(windowSource)}) | trigger: ${Math.round((tokenBudget.maxTokens * 0.8)).toLocaleString()} (80%)`)
          break
        }
        case 'channel': {
          const subCmd = rest.join(' ')
          if (subCmd === 'list' || subCmd === '') {
            const channels = channelManager.list()
            if (channels.length === 0) {
              console.log('No channels configured')
              console.log('Setup: CC_NODE_CHANNEL_TELEGRAM_TOKEN=xxx CC_NODE_CHANNEL_TELEGRAM_CHAT_ID=xxx')
            } else {
              console.log('Channels:')
              for (const ch of channels) {
                const isDefault = channelManager.defaultChannel === ch ? ' (default)' : ''
                console.log(`  - ${ch}${isDefault}`)
              }
            }
          } else if (subCmd.startsWith('send ')) {
            const text = subCmd.slice(5)
            const results = await channelManager.send(text)
            for (const r of results) console.log(r.ok ? `✅ ${r.channel}: sent` : `❌ ${r.channel}: ${r.error}`)
          } else if (subCmd.startsWith('test')) {
            const results = await channelManager.send('📡 cc-node channel test')
            for (const r of results) console.log(r.ok ? `✅ ${r.channel}: test OK` : `❌ ${r.channel}: ${r.error}`)
          } else {
            console.log('Usage: /channel list|send <msg>|test')
          }
          break
        }
        case 'allow': {
          const arg = rest.join(' ').toLowerCase()
          if (arg === 'all') {
            engine.permissionChecker.allowAllForSession()
            console.log('✅ All tools allowed for the rest of this session')
          } else if (arg === 'reset') {
            engine.permissionChecker.resetSessionAllow()
            console.log('✅ Session permission reset to normal (ask mode)')
          } else {
            const tool = arg || '*'
            engine.permissionChecker.allow(tool)
            console.log(`✅ Tool "${tool}" allowed for this session`)
          }
          break
        }
        case 'cost':
          console.log(engine.costTracker.formatReport())
          break
        case 'cd':
          if (rest.length === 0) {
            console.log(`Current directory: ${process.cwd()}`)
          } else {
            const target = rest.join(' ')
            try {
              process.chdir(target)
              const newCwd = process.cwd()
              engine.config.cwd = newCwd
              console.log(`📂 ${newCwd}`)
            } catch (err) {
              console.log(`❌ ${err.message}`)
            }
          }
          break
        case 'compact': {
          if (engine.tokenBudget) {
            // 手动压缩：用实时 token 估算判断是否需要压缩（而非滞后的 usagePercent），
            // 用户主动触发时总能真正压缩。
            const limit = engine.tokenBudget.maxTokens - engine.tokenBudget.reservedForOutput
            const est = engine.tokenBudget.estimateMessages(engine.state.messages)
            if (est > limit) {
              const messages = compactMessages(engine.state.messages, {
                maxTokens: Math.floor(engine.tokenBudget.maxTokens * 0.6),
                keepRecentTurns: 4,
              })
              engine.state.messages = messages
              console.log(`✅ Context compressed (${est} → ${engine.tokenBudget.estimateMessages(messages)} tokens)`)
            } else {
              console.log(`ℹ️  Context within window (${est}/${limit} tokens), no compression needed`)
            }
          } else {
            console.log('Token budget not configured')
          }
          break
        }
        case 'exit': case 'quit': {
          // 退出前确认消费 Telegram update（避免 /quit 等命令残留在服务器缓冲区，
          // 下次启动重放导致死循环起不来）。配合 tg-listener 的 offset 持久化双保险。
          if (tgListener?.bot) {
            try { await tgListener.flushOffset() } catch {}
          }
          console.log('Goodbye!')
          process.exit(0)
        }
        default:
          console.log(`Unknown command: /${cmd}. Type /help for available commands.`)
      }
      } finally {
        // 恢复 console.log 并把命令输出回发到 Telegram
        if (isTgCmd) {
          console.log = origLog
          if (tgOut.trim()) await sendTelegram(tgOut.trim(), tgChatId || null)
        }
      }
      showPrompt()
      return
    }

    // 发送到引擎 — 引擎忙（如正在处理上一条消息）时，提示而不是崩溃/吞掉
    if (engine.state.isRunning) {
      const busyMsg = '⏳ 引擎正在处理其他任务，请稍候或输入 /stop 停止当前任务。'
      console.log(busyMsg)
      if (source === 'telegram' && tgListener?.bot) {
        await sendTelegram(busyMsg, tgChatId || null).catch(() => {})
      }
      return
    }

    // 发送到引擎
    try {
      // 有 Telegram 通道时，流式推送思维链到当前回复目标，避免远程"以为没回应"
      const streamTarget = (source === 'telegram') ? (tgChatId || null) : (tgListener?.bot ? tgChatId || null : null)
      if (streamTarget) tgThinkingStart(streamTarget)
      const result = await processInput(input)
      // 处理结束，清掉思维链流（最终回复随后发送）
      tgThinkingEnd()
      console.log()
      // 正文已被 onDelta 实时流式输出到终端 → 不重复打印（否则出现"回答两次"的双层显示）。
      // 仅当没有流式输出（noStream / 流式失败 / 无 onDelta 回调）时才打印完整 response。
      if (!engine.lastStreamed && !streamedText) {
        console.log(result.response)
      }
      console.log()
      await sessionManager.appendMessage({ role: 'user', content: input })
      await sessionManager.appendMessage({ role: 'assistant', content: result.response })
      session.state = session.state || {}
      session.state.turnCount = engine.state.turnCount
      session.state.costHistory = engine.costTracker.history.slice(-50)
      await sessionManager.save(session)
      if (verbose) console.log(`[Turns: ${result.turns} | Tools: ${result.toolResults.length}]`)
      if (engine.costTracker && engine.costTracker.totalApiCalls > 0) {
        console.log(engine.costTracker.formatShort())
      }
      // 将 AI 回复同步发送到 Telegram（镜像 CLI 显示）
      if (tgListener?.bot && result?.response) {
        await sendTelegram(result.response, tgChatId || null)
      }
    } catch (err) {
      tgThinkingEnd()
      console.error(`\nError: ${err.message}\n`)
      if (tgListener?.bot) {
        await sendTelegram(`❌ Error: ${err.message}`, tgChatId || null)
      }
      if (channelManager.list().length > 0) {
        await channelManager.sendTemplate('error', {
          task: input.slice(0, 80), error: err.message.slice(0, 200),
        }).catch(() => {})
      }
    }
    showPrompt()
  }

  // 发送文本到 Telegram（支持分片，>4000 字符自动拆分）
  async function sendTelegram(text, chatId = null) {
    try {
      const target = chatId || tgChatId
      if (!target) return
      const MAX_LEN = 4000
      if (text.length <= MAX_LEN) {
        await tgListener.bot.sendMessage(target, text, { parseMode: 'HTML' })
      } else {
        const parts = []
        let cur = ''
        for (const line of text.split('\n')) {
          if (cur.length + line.length > 3800) { parts.push(cur); cur = line }
          else { cur += (cur ? '\n' : '') + line }
        }
        if (cur) parts.push(cur)
        for (let i = 0; i < parts.length; i++) {
          const header = i > 0 ? `📎 (${i + 1}/${parts.length})\n` : ''
          await tgListener.bot.sendMessage(target, header + parts[i], { parseMode: 'HTML' })
          await new Promise(r => setTimeout(r, 300))
        }
      }
    } catch (e) {
      console.error(`[TG] send failed: ${e.message}`)
    }
  }

  // ============================================================
  // 流式推送 → Telegram
  // 把引擎 onDelta 产出的生成内容（text / reasoning）实时推送到 Telegram，
  // 让远程用户看到 AI 正在工作，而不是"以为没回应"。
  // 采用节流 + 编辑同一消息的方式，避免刷屏和触发速率限制。
  // ============================================================
  const tgThinking = { buffer: '', timer: null, target: null, lastMsgId: null, flushing: false, typingTimer: null, lastResetAt: 0 }
  // 周期性重置"🧠 思考中…"消息，避免它无限膨胀成一个无法判断是否仍在工作的静态块。
  // 每隔 RESET_MS 就删掉旧消息、发一条新的，让用户每隔几秒看到一次明确的活动信号。
  const TG_THINKING_RESET_MS = 5000

  // Telegram 的 typing 提示约 5 秒后自动消失。若 cc-node 处理耗时较长
  //（如执行工具、读取文件、多轮思考），单次 sendChatAction 撑不住整个周期，
  // 用户会看到"正在输入"消失，误以为已完成/卡死。
  // 因此用一个心跳定时器在整轮处理期间每隔几秒重发一次 typing 动作，
  // 让"正在输入"持续显示，直到本轮处理完全结束（tgThinkingEnd 清掉定时器）。
  const TG_TYPING_HEARTBEAT_MS = 4000

  function tgStartTypingHeartbeat() {
    // 停止旧的，避免重复
    if (tgThinking.typingTimer) { clearInterval(tgThinking.typingTimer); tgThinking.typingTimer = null }
    if (!tgListener?.bot || !tgThinking.target) return
    tgThinking.typingTimer = setInterval(() => {
      if (!tgThinking.target) { tgStopTypingHeartbeat(); return }
      tgListener.bot.sendChatAction(tgThinking.target, 'typing').catch(() => {})
    }, TG_TYPING_HEARTBEAT_MS)
  }

  function tgStopTypingHeartbeat() {
    if (tgThinking.typingTimer) { clearInterval(tgThinking.typingTimer); tgThinking.typingTimer = null }
  }

  function tgThinkingStart(target) {
    tgThinking.target = target || null
    tgThinking.buffer = ''
    tgThinking.lastMsgId = null
    tgThinking.flushing = false
    tgThinking.lastResetAt = Date.now()
    // 先发送 typing 动作，让 Telegram 立即显示"正在输入"，并启动心跳保持持续显示
    if (tgListener?.bot && tgThinking.target) {
      tgListener.bot.sendChatAction(tgThinking.target, 'typing').catch(() => {})
      tgStartTypingHeartbeat()
    }
  }

  function tgThinkingPush(text) {
    if (!text || !tgListener?.bot || !tgThinking.target) return
    tgThinking.buffer += text
    // 只保留最近 8000 字符，避免无限增长
    if (tgThinking.buffer.length > 8000) tgThinking.buffer = tgThinking.buffer.slice(-8000)
    if (tgThinking.timer) clearTimeout(tgThinking.timer)
    // 首帧快速发送（500ms 聚合首段），之后节流编辑（1.5s）
    const delay = tgThinking.lastMsgId ? 1500 : 500
    tgThinking.timer = setTimeout(() => tgThinkingFlush(), delay)
  }

  async function tgThinkingFlush() {
    if (tgThinking.flushing) return // 防止并发
    if (tgThinking.timer) { clearTimeout(tgThinking.timer); tgThinking.timer = null }
    if (!tgListener?.bot || !tgThinking.target || !tgThinking.buffer) return
    tgThinking.flushing = true
    const target = tgThinking.target
    const body = `🧠 思考中…\n\n${tgThinking.buffer.slice(-3500)}`
    try {
      // 周期性重置：若已有一条消息且距上次重置超过阈值，删除旧消息并发新消息，
      // 让用户每隔几秒看到"🧠 思考中…"重新出现，明确 AI 仍在工作（而非已卡死/完成）。
      const needReset = tgThinking.lastMsgId && (Date.now() - tgThinking.lastResetAt) >= TG_THINKING_RESET_MS
      if (needReset) {
        tgListener.bot.deleteMessage(target, tgThinking.lastMsgId).catch(() => {})
        tgThinking.lastMsgId = null
        tgThinking.lastResetAt = Date.now()
      }
      if (tgThinking.lastMsgId) {
        await tgListener.bot.editMessage(target, tgThinking.lastMsgId, body, { parseMode: 'HTML' })
      } else {
        const res = await tgListener.bot.sendMessage(target, body, { parseMode: 'HTML' })
        tgThinking.lastMsgId = res?.message_id || null
      }
    } catch (e) {
      // 编辑失败（如消息被删）→ 重发一条新的
      tgThinking.lastMsgId = null
      try {
        const res = await tgListener.bot.sendMessage(target, body, { parseMode: 'HTML' })
        tgThinking.lastMsgId = res?.message_id || null
      } catch {}
    } finally {
      tgThinking.flushing = false
    }
  }

  function tgThinkingEnd() {
    if (tgThinking.timer) { clearTimeout(tgThinking.timer); tgThinking.timer = null }
    // 处理结束，停掉 typing 心跳 → "正在输入" 提示消失
    tgStopTypingHeartbeat()
    tgThinking.buffer = ''
    tgThinking.lastMsgId = null
    tgThinking.target = null
    tgThinking.flushing = false
  }

  // REPL 主循环 — 由 multiline-input 处理多行输入（keypress / 非TTY readline）
  // 输入由 createMultilineInput 在创建时挂接，start() 显示初始提示符
  inputCtrl.start()

  // 将 readline 兼容对象注入引擎配置，用于 ask 模式确认和 AskUserQuestion 工具
  if (permissionMode === 'ask') {
    engine.config.onConfirmTool = async (toolName, input) => {
      // 如果已经启用会话全局自动允许，直接通过
      if (engine.permissionChecker.sessionAllowAll) return true

      const snippet = JSON.stringify(input).slice(0, 120) || '(no params)'

      // Telegram 远程模式：把权限确认推送到 Telegram，等待远程用户回复 y/n/a
      if (currentSource === 'telegram' && tgListener?.bot) {
        const promptText = `⚠️  需要工具权限\n工具: ${toolName}\n输入: ${snippet}\n\n请回复：\ny = 允许一次\nn = 拒绝\na = 本会话全部允许`
        await sendTelegram(promptText, null).catch(() => {})
        return new Promise((resolve) => {
          // 60 秒内未回复则自动拒绝，避免远程确认永久挂起阻塞对话
          const timer = setTimeout(() => {
            if (pendingConfirm === resolve) pendingConfirm = null
            resolve(false)
          }, 60000)
          pendingConfirm = (val) => {
            clearTimeout(timer)
            resolve(val)
          }
        })
      }

      // 本地 CLI：用终端交互确认
      return new Promise((resolve) => {
        rl.question(`\n⚠️  Allow tool "${toolName}"?\n   Input: ${snippet}\n   (y/N/a) a=all session `, (answer) => {
          const a = answer.toLowerCase()
          if (a === 'a') {
            engine.permissionChecker.allowAllForSession()
            resolve(true)
          } else {
            resolve(a === 'y')
          }
        })
      })
    }
  }
  engine.config.readline = rl

  // AskUserQuestion 工具回调 — 按通道分流：
  // - Telegram 可用时：异步发问——发问题到 Telegram 后立即返回（不挂起 Promise、不锁死引擎），
  //   用户后续回复作为正常消息进入，由下一轮引擎处理时把回复当作回答。
  //   避免旧"挂起等待"结构导致会话卡死/发呆。
  // - CLI 本地模式：同步等待本地终端输入。
  engine.config.onAskUser = (question) => {
    if (tgListener?.bot && tgChatId) {
      const promptText = `❓ ${question}\n\n请直接回复你的回答。`
      sendTelegram(promptText, null).catch(() => {})
      // 立即返回，不挂起；用户回复会在下一轮以正常消息进入
      return `(已向用户提问，等待回复): ${question}`
    }
    // CLI 本地模式：同步等待终端输入
    return askQuestion(`❓ ${question}\n> `)
  }

  // ============================================================
  // Telegram 双向通道启动（可选）
  // 配置了 CC_NODE_CHANNEL_TELEGRAM_TOKEN 或 config 中 telegram 时启用：
  //  - CLI 的 AI 回复会同步镜像发送到 Telegram
  //  - Telegram 消息会作为 REPL 输入，与 CLI 共享同一个引擎和对话记忆
  // ============================================================
  const tgToken = process.env.CC_NODE_CHANNEL_TELEGRAM_TOKEN || config.get('channels')?.telegram?.token || ''
  // 关键修复: 使用 --with-notify 时，由 startBuiltinListeners 统一启动 Telegram 监听器，
  // 这里不能再独立启动一个，否则同一 token 会有两个 getUpdates 长轮询 → Telegram 报 HTTP 409 Conflict。
  if (tgToken && !cliArgs.withNotify) {
    try {
      tgListener = new TelegramListener({
        channels: {
          telegram: {
            token: tgToken,
            proxy: process.env.CC_NODE_CHANNEL_TELEGRAM_PROXY || config.get('channels')?.telegram?.proxy || '',
            apiBase: process.env.CC_NODE_CHANNEL_TELEGRAM_API_BASE || config.get('channels')?.telegram?.apiBase || '',
          },
        },
      })
      tgListener.start(async (msg) => {
        // Telegram 消息 → 复用 REPL 引擎处理（共享同一份对话记忆）
        tgChatId = msg.chatId || tgChatId
        tgReplyTarget = msg.replyTo || null
        const text = msg.text || msg.callbackData || ''
        if (!text) return
        // 普通消息和 / 命令都转给引擎（/命令由 processInputLine 处理）
        // 注意：tg-listener 已内部处理 /ping /status /run 等自己的命令，
        // 只有未识别的 / 命令（如 /models /stop /resume）才会到达这里。
        await processInputLine(text, 'telegram', msg.chatId)
      }).catch(e => console.error(`[TG] listener error: ${e.message}`))
      console.log(`✅ Telegram channel ready (bot ${tgToken.slice(0, 12)}...)`)
    } catch (e) {
      console.error(`[TG] init failed: ${e.message}`)
    }
  }

  // ============================================================
  // --with-notify: 内置频道监听器（替代 cc-notify 守护进程）
  // 当 cc-node 启动时同时启动 Telegram 监听器，
  // 无需外部 bash 脚本，跨平台（Windows/Linux/macOS）都能用。
  // ============================================================
  if (cliArgs.withNotify) {
    const { startBuiltinListeners } = await import('../channel/notify-daemon.js')
    // 启动内部的 notify 监听器（不 fork 新进程，直接在当前进程运行）
    const builtinNotify = await startBuiltinListeners({
      channels: config.get('channels') || {},
      defaultChannel: config.get('defaultChannel') || process.env.CC_NODE_CHANNEL_DEFAULT || null,
      onMessage: async (msg) => {
        // 记录全局回复目标，供权限确认 / AI 回复镜像发送到 Telegram 使用
        if (msg.chatId) tgChatId = msg.chatId
        if (msg.replyTo) tgReplyTarget = msg.replyTo
        // 来自外部的消息 → 转发到 REPL 引擎（含 / 命令，由 processInputLine 处理）
        const text = msg.text || ''
        if (text) {
          await processInputLine(text, msg.channel || 'external', msg.chatId)
        }
      },
    })
    // 关键：把 startBuiltinListeners 内置监听器的 tgListener 赋给全局 tgListener，
    // 否则 onConfirmTool 的 tgListener?.bot 恒为 false，权限确认不会推送 Telegram。
    if (builtinNotify?.tgListener) tgListener = builtinNotify.tgListener
    console.log('📡 Built-in channel listeners started (--with-notify)')
  }

  // ============================================================
  // 引擎流式回调 — 保持 CLI 实时输出，并把生成内容推送到 Telegram
  // onDelta 会在流式生成时被调用（{type:'text'|'reasoning', text}）。
  // 注意：DeepSeek 模型 thinking 被禁用时只有 text 事件、没有 reasoning，
  // 因此 text 也必须推送到 Telegram，否则远程看不到任何进度。
  // 设置 onDelta 后引擎不再直接写终端，因此这里需手动维持终端输出。
  // ============================================================
  engine.config.onDelta = ({ type, text }) => {
    // 保持 CLI 实时输出
    process.stdout.write(text)
    // 记录已有文本被实时输出到终端（供 processInputLine 判断是否需重复打印 response）
    if (type === 'text' && text) streamedText = true
    // 无论 text 还是 reasoning，都实时推送到 Telegram（节流）
    tgThinkingPush(text)
  }

  console.log(buildBanner({ model, permissionMode, session, maxTokens: tokenBudget.maxTokens }))
  console.log(`Model: ${model} | Permission: ${permissionMode} | Tools: ${registry.getNames().join(', ')}`)
  console.log(`Socket: ${SOCK_PATH} (cc-notify can connect)`)
  if (channelManager.list().length > 0) {
    const chList = channelManager.list().join(', ')
    const def = channelManager.defaultChannel ? ` (default: ${channelManager.defaultChannel})` : ''
    console.log(`Channels: ${chList}${def}`)
  }
  console.log()
  // 显示初始提示符
  showPrompt()

  // REPL 消息处理包装（留作扩展点）
  async function processInput(input) {
    return engine.processMessage(input)
  }
}

// ============================================================
// 全局退出处理 — 回收 stdin 的 raw mode
// ============================================================
function cleanupStdin() {
  try {
    if (process.stdin.isTTY) process.stdin.setRawMode(false)
    process.stdin.removeAllListeners('keypress')
  } catch {}
}

process.on('SIGINT', () => {
  cleanupStdin()
  process.exit(0)
})
process.on('SIGTERM', () => {
  cleanupStdin()
  process.exit(0)
})
process.on('exit', () => {
  cleanupStdin()
})
