/**
 * CLI 入口 — 命令行解析和 REPL 循环
 * 对应原版: src/cli/ + src/entrypoints/
 * 
 * v1.2: 增加 Unix socket 服务，让 cc-notify 能发现并转发消息
 */
import { createInterface } from 'readline'
import { createServer as createNetServer } from 'net'
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs'
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

  // 清理残留 socket 文件
  if (existsSync(SOCK_PATH)) {
    try { unlinkSync(SOCK_PATH) } catch {}
  }

  const server = createNetServer((client) => {
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
    // 写 PID 文件
    writeFileSync(CC_NODE_PID, String(process.pid))
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

const BANNER = `
╔═══════════════════════════════════════════════╗
║   AI Code Agent — Node.js Edition            ║
║   OpenAI-Compatible · DeepSeek Default        ║
║   Type '/help' for commands                   ║
║   Type '/exit' or Ctrl+C to quit              ║
╚═══════════════════════════════════════════════╝
`.trim()

const HELP_TEXT = `
Commands:
  /help          — Show this help
  /model NAME    — Switch model
  /tools         — List available tools
  /session       — Show session info
  /sessions      — List all sessions
  /clear         — Clear conversation
  /config KEY    — Show config value
  /budget        — Show token budget
  /channel CMD   — Manage notification channels (list|send|test)
  /cost          — Show API cost report
  /compact       — Manually compact conversation context
  /exit          — Exit (also Ctrl+C)
  /quit          — Same as /exit
`

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

  const costTracker = new CostTracker({ model })

  const engineConfig = new QueryEngineConfig({
    model, systemPrompt, permissionMode, maxTurns, apiBase, apiKey, verbose,
    tools: registry.getAll(),
    noStream: cliArgs.noStream,
    costTracker,
    tokenBudget,
  })
  const engine = new QueryEngine(engineConfig)

  // M5: 恢复会话历史和状态
  if (session?.messages?.length) {
    for (const msg of session.messages) {
      if (msg.role === 'user') engine.state.messages.push({ role: 'user', content: msg.content })
      else if (msg.role === 'assistant') engine.state.messages.push({ role: 'assistant', content: msg.content })
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

  const tokenBudget = new TokenBudget({ maxTokens: config.get('maxBudgetTokens') || 200_000 })

  const channelManager = new ChannelManager({
    channels: config.get('channels') || {},
    defaultChannel: config.get('defaultChannel') || null,
  })

  // 一次性输入模式
  if (cliArgs.oneShot) {
    const result = await engine.processMessage(cliArgs.oneShot)
    console.log(result.response)
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

  console.log(BANNER)
  console.log(`Model: ${model} | Permission: ${permissionMode} | Tools: ${registry.getNames().join(', ')}`)
  console.log(`Socket: ${SOCK_PATH} (cc-notify can connect)`)
  if (channelManager.list().length > 0) {
    const chList = channelManager.list().join(', ')
    const def = channelManager.defaultChannel ? ` (default: ${channelManager.defaultChannel})` : ''
    console.log(`Channels: ${chList}${def}`)
  }
  console.log()
  rl.prompt()

  // 共享的消息处理函数（REPL 和 socket 都用）
  async function processInput(input) {
    return engine.processMessage(input)
  }

  rl.on('line', async (line) => {
    const input = line.trim()
    if (!input) { rl.prompt(); return }

    if (input.startsWith('/')) {
      const [cmd, ...rest] = input.slice(1).split(' ')
      switch (cmd) {
        case 'help': console.log(HELP_TEXT); break
        case 'model':
          if (rest[0]) { engine.config.model = rest.join(' '); console.log(`Model → ${engine.config.model}`) }
          else console.log(`Model: ${engine.config.model}`)
          break
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
        case 'cost':
          console.log(engine.costTracker.formatReport())
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
