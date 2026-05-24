/**
 * CLI 入口 — 命令行解析和 REPL 循环
 * 对应原版: src/cli/ + src/entrypoints/
 * 
 * v1.2: 增加 Unix socket 服务，让 cc-notify 能发现并转发消息
 */
import { createInterface } from 'readline'
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
import { autoCompact } from './compact.js'
import { SOCK_DIR, SOCK_PATH, CC_NODE_PID } from './paths.js'

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
    try { chmodSync(SOCK_PATH, 0o600) } catch {}
    // 写 PID 文件（权限 0644）
    writeFileSync(CC_NODE_PID, String(process.pid), { mode: 0o644 })
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

  const col1 = 30 // 机器人列
  const col2 = 42 // 标题列
  const col3 = inner - col1 - col2 - 2 // 信息列

  // ANSI 颜色
  const BLUE = '\x1b[34m'
  const CYAN = '\x1b[36m'
  const RESET = '\x1b[0m'

  // 原始机器人（宽21）
  const robotRaw = [
    '      ╭───────╮      ',
    '┌───────────────────┐',
    '│    ██       ██    │',
    '│                   │',
    '│      ██████       │',
    '└───────────────────┘'
  ]

  // 颜色化：边框蓝，眼睛/嘴巴青
  const colorize = (line) =>
    line
      .replace(/[┌└─╭╮]/g, BLUE + '$&' + RESET)
      .replace(/[█]/g, CYAN + '$&' + RESET)

  const robotColored = robotRaw.map(colorize)

  // 在 col1 内居中（考虑 ESC 序列不看长度，按可见长度21 计算）
  const leftPad = 4 // (30 - 21) / 2 = 4.5 => 4 left, 5 right
  const rightPad = 5
  const robotLines = robotColored.map(line => ' '.repeat(leftPad) + line + ' '.repeat(rightPad))

  // 标题列（居中）
  const pad = (s, w, align = 'center') => {
    if (s.length >= w) return s
    const sp = w - s.length
    if (align === 'center') {
      const l = Math.floor(sp / 2)
      return ' '.repeat(l) + s + ' '.repeat(sp - l)
    }
    return s + ' '.repeat(sp)
  }

  const titleLines = [
    pad('AI Code Agent', col2, 'center'),
    pad('Node.js Edition', col2, 'center'),
    pad('', col2, 'center'),
    pad('─'.repeat(col2 - 2), col2, 'center'),
    pad('/help — commands · /exit — quit', col2, 'center'),
    pad('', col2, 'center')
  ]

  // 信息列（右对齐）
  const sessionId = session?.id || '??????'
  const infoLines = [
    pad(`Turns: ${session?.state?.turnCount ?? 0}  •  Tools: 0`, col3, 'right'),
    pad(`Model: ${model}`, col3, 'right'),
    pad(`Permission: ${permissionMode}`, col3, 'right'),
    pad(`Budget: 0 / ${maxTokens ?? 200000}`, col3, 'right'),
    pad(`Session: ${sessionId?.toString().slice(-6)}`, col3, 'right'),
    pad('', col3, 'right')
  ]

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
  /config KEY    — Show config value
  /budget        — Show token budget
  /channel CMD   — Manage notification channels (list|send|test)
  /cost          — Show API cost report
  /compact       — Manually compact conversation context
  /cd PATH       — Change working directory
  /allow [tool]  — Allow a tool for the current session (default: all)
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

  sessions:"/sessions\n  List all saved sessions.\n  Shows session ID, title, message count, and last update time.",

  clear:   "/clear\n  Clear the current conversation context.\n  Starts a fresh session. Previous messages are not sent to the API anymore.\n\n  Note: Does not delete saved sessions.",

  config:  "/config [key]\n  Without key: show the entire config as JSON.\n  With a key path: show the value for that specific path.\n\n  Example: /config\n  Example: /config model",

  budget:  "/budget\n  Show token budget usage for the current session.\n  Displays how many tokens have been used vs the limit.",

  channel: "/channel <list|send|test>\n  Manage notification channels.\n\n  Subcommands:\n    list       — List all configured notification channels\n    send <msg> — Send a message via all channels\n    test       — Send a test message to verify channels\n\n  Requires channel environment variables to be set at startup.",

  cost:    "/cost\n  Show API cost report.\n  Displays total tokens used and estimated cost in USD.\n  Supports pricing for: DeepSeek, OpenAI, Qwen, GLM, Kimi.",

  compact: "/compact\n  Manually trigger context compression.\n  Compresses the conversation history to fit within the token budget.\n  Keeps recent turns intact, compresses older ones.\n\n  Typically triggered automatically at 80% budget usage.",

  cd:      "/cd <path>\n  Change the working directory of cc-node.\n  Affects all subsequent tool executions (Bash, Read, Write, etc.).\n\n  Without path: show the current working directory.\n\n  Example: /cd /home/raolin/projects\n  Example: /cd ..",

  allow:   "/allow [tool_name]\n  Allow a tool to execute without confirmation for this session.\n  Without tool name: allows ALL tools.\n\n  Example: /allow\n  Example: /allow Bash",

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

  const config = new Config()
  await config.load(process.cwd())

  const model = cliArgs.model || config.get('model')
  const systemPrompt = cliArgs.systemPrompt || ''
  const permissionMode = cliArgs.permissionMode || config.get('permissionMode')
  const maxTurns = cliArgs.maxTurns || config.get('maxTurns')
  const apiBase = cliArgs.apiBase || config.get('apiBase') || process.env.LLM_API_BASE || ''
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
  const tokenBudget = new TokenBudget({ maxTokens: config.get('maxBudgetTokens') || 200_000 })
  const costTracker = new CostTracker({ model })

  const engineConfig = new QueryEngineConfig({
    model, systemPrompt, permissionMode, maxTurns, apiBase, apiKey, verbose,
    tools: registry.getAll(),
    noStream: cliArgs.noStream,
    costTracker,
    tokenBudget,
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
    console.log(result.response)
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

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' })

  // 将 readline 注入引擎配置，用于 ask 模式确认和 AskUserQuestion 工具
  if (permissionMode === 'ask') {
    engine.config.onConfirmTool = async (toolName, input) => {
      return new Promise((resolve) => {
        const snippet = JSON.stringify(input).slice(0, 120) || '(no params)'
        rl.question(`\n⚠️  Allow tool "${toolName}"?\n   Input: ${snippet}\n   (y/N) `, (answer) => {
          resolve(answer.toLowerCase().startsWith('y'))
        })
      })
    }
  }
  engine.config.readline = rl

  console.log(buildBanner({ model, permissionMode, session, maxTokens: tokenBudget.maxTokens }))
  console.log(`Model: ${model} | Permission: ${permissionMode} | Tools: ${registry.getNames().join(', ')}`)
  console.log(`Socket: ${SOCK_PATH} (cc-notify can connect)`)
  if (channelManager.list().length > 0) {
    const chList = channelManager.list().join(', ')
    const def = channelManager.defaultChannel ? ` (default: ${channelManager.defaultChannel})` : ''
    console.log(`Channels: ${chList}${def}`)
  }
  console.log()
  rl.prompt()

  // REPL 消息处理包装（留作扩展点）
  async function processInput(input) {
    return engine.processMessage(input)
  }

  rl.on('line', async (line) => {
    const input = line.trim()
    if (!input) { rl.prompt(); return }

    if (input.startsWith('/')) {
      const [cmd, ...rest] = input.slice(1).split(' ')
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
          if (rest[0]) { engine.config.model = rest.join(' '); console.log(`Model → ${engine.config.model}`) }
          else console.log(`Model: ${engine.config.model}`)
          break
        case 'models': {
          const apiBase = engine.config.apiBase
          const apiKey = engine.config.apiKey
          if (!apiKey) { console.log('❌ API key not configured'); break }
          const modelsUrl = apiBase.replace(/\/+$/, '') + '/models'
          console.log(`📡 Fetching models from ${modelsUrl}...`)
          try {
            const res = await fetch(modelsUrl, { headers: { 'Authorization': `Bearer ${apiKey}` } })
            if (!res.ok) { console.log(`❌ API error: ${res.status}`); break }
            const data = await res.json()
            const models = data.data || []
            if (models.length === 0) { console.log('No models returned'); break }
            console.log(`\nAvailable models (${models.length}):`)
            models.forEach((m, i) => {
              const id = m.id || m
              console.log(`  ${(i + 1).toString().padStart(2)}. ${id}`)
            })
            console.log('\nType a number to select, or model name directly:')
            const answer = await new Promise(resolve => rl.question('> ', resolve))
            const num = parseInt(answer, 10)
            let selected
            if (!isNaN(num) && num >= 1 && num <= models.length) {
              selected = models[num - 1].id || models[num - 1]
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
        case 'config':
          if (rest[0]) {
            const val = config.get(rest.join(' '))
            console.log(`${rest.join(' ')} = ${JSON.stringify(val, null, 2)}`)
          } else {
            console.log(JSON.stringify(config.toJSON(), null, 2))
          }
          break
        case 'budget': console.log(tokenBudget.format()); break
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
          const allowTool = rest.join(' ') || '*'
          engine.permissionChecker.allowForSession(allowTool, '*')
          console.log(`✅ Tool "${allowTool}" allowed for this session`)
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
            const { compacted, messages } = autoCompact(engine.state.messages, engine.tokenBudget, { keepRecentTurns: 4 })
            if (compacted) {
              engine.state.messages = messages
              console.log('✅ Context compressed')
            } else {
              console.log('ℹ️  No compression needed')
            }
          } else {
            console.log('Token budget not configured')
          }
          break
        }
        case 'exit': case 'quit':
          console.log('Goodbye!')
          process.exit(0)
        default:
          console.log(`Unknown command: /${cmd}. Type /help for available commands.`)
      }
      rl.prompt()
      return
    }

    // 发送到引擎
    try {
      const result = await processInput(input)
      console.log()
      console.log(result.response)
      console.log()
      await sessionManager.appendMessage({ role: 'user', content: input })
      await sessionManager.appendMessage({ role: 'assistant', content: result.response })
      // 保存引擎状态到会话
      session.state = session.state || {}
      session.state.turnCount = engine.state.turnCount
      session.state.costHistory = engine.costTracker.history.slice(-50)
      await sessionManager.save(session)
      if (verbose) console.log(`[Turns: ${result.turns} | Tools: ${result.toolResults.length}]`)
      // 显示费用（即使非 verbose 也显示）
      if (engine.costTracker && engine.costTracker.totalApiCalls > 0) {
        console.log(engine.costTracker.formatShort())
      }
    } catch (err) {
      console.error(`\nError: ${err.message}\n`)
      if (channelManager.list().length > 0) {
        await channelManager.sendTemplate('error', {
          task: input.slice(0, 80), error: err.message.slice(0, 200),
        }).catch(() => {})
      }
    }
    rl.prompt()
  })

  rl.on('close', () => { console.log('\nGoodbye!'); process.exit(0) })
}
