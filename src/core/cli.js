/**
 * CLI 入口 — 命令行解析和 REPL 循环
 * 对应原版: src/cli/ + src/entrypoints/
 */
import { createInterface } from 'readline'
import { QueryEngine, QueryEngineConfig } from './query-engine.js'
import { createDefaultRegistry } from '../tools/index.js'
import { SessionManager } from './session.js'
import { Config } from './config.js'
import { TokenBudget } from './token-budget.js'
import { PermissionChecker } from '../permission/permission.js'
import { ChannelManager } from '../channel/index.js'

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
  /exit          — Exit (also Ctrl+C)
  /quit          — Same as /exit
`

/**
 * 解析命令行参数
 */
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

  let i = 2 // skip node and script name
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
        console.log(`Usage: cc-node [options]

Options:
  -m, --model NAME          Model to use (required, e.g. deepseek-chat, qwen-plus, glm-4-flash)
  -s, --system-prompt TEXT  System prompt
  -p, --permission-mode     Permission mode: ask|always-allow|deny (default: ask)
  -t, --max-turns N         Max tool loop turns (default: 100)
  --api-base URL            API base URL (default: https://api.deepseek.com/v1)
  --api-key ***             API key (or set LLM_API_KEY env)
  -r, --resume ID           Resume a session
  -v, --verbose             Verbose mode
  --no-stream               Disable streaming
  -h, --help                Show this help

Environment variables:
  LLM_API_KEY        Universal API key (recommended)
  DEEPSEEK_API_KEY   DeepSeek API key (default)
  OPENAI_API_KEY     OpenAI API key
  QWEN_API_KEY       Qwen (DashScope) API key
  GLM_API_KEY        Zhipu GLM API key
  KIMI_API_KEY       Moonshot Kimi API key
  LLM_API_BASE       API base URL (default: https://api.deepseek.com/v1)

Channel environment variables:
  CC_NODE_CHANNEL_DEFAULT              Default channel name
  CC_NODE_CHANNEL_TELEGRAM_TOKEN       Telegram bot token
  CC_NODE_CHANNEL_TELEGRAM_CHAT_ID     Telegram chat ID
  CC_NODE_CHANNEL_WECOM_WEBHOOK_URL    WeCom webhook URL
  CC_NODE_CHANNEL_FEISHU_WEBHOOK_URL   Feishu webhook URL
  CC_NODE_CHANNEL_DISCORD_WEBHOOK_URL  Discord webhook URL
  CC_NODE_CHANNEL_SLACK_WEBHOOK_URL    Slack webhook URL
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

/**
 * 主入口
 */
export async function main() {
  const cliArgs = parseArgs(process.argv)

  // 加载配置
  const config = new Config()
  await config.load(process.cwd())

  // 合并 CLI 参数 > 项目配置 > 用户配置 > 默认值
  const model = cliArgs.model || config.get('model')
  const systemPrompt = cliArgs.systemPrompt || ''
  const permissionMode = cliArgs.permissionMode || config.get('permissionMode')
  const maxTurns = cliArgs.maxTurns || config.get('maxTurns')
  const apiBase = cliArgs.apiBase || config.get('apiBase') || process.env.LLM_API_BASE || ''
  const apiKey = cliArgs.apiKey || config.get('apiKey') || ''
  const verbose = cliArgs.verbose || config.get('verbose')

  // 创建工具注册表
  const registry = createDefaultRegistry()

  // 创建会话管理器
  const sessionManager = new SessionManager({
    sessionsDir: config.get('sessionsDir'),
  })

  // 恢复或创建会话
  let session
  if (cliArgs.resume) {
    session = await sessionManager.load(cliArgs.resume)
    if (!session) {
      console.error(`Session not found: ${cliArgs.resume}`)
      process.exit(1)
    }
  } else {
    session = await sessionManager.create()
  }

  // 创建查询引擎
  const engineConfig = new QueryEngineConfig({
    model,
    systemPrompt,
    permissionMode,
    maxTurns,
    apiBase,
    apiKey,
    verbose,
    tools: registry.getAll(),
  })
  const engine = new QueryEngine(engineConfig)

  // 恢复会话历史
  if (session?.messages?.length) {
    for (const msg of session.messages) {
      if (msg.role === 'user') {
        engine.state.messages.push({ role: 'user', content: msg.content })
      } else if (msg.role === 'assistant') {
        engine.state.messages.push({ role: 'assistant', content: msg.content })
      }
    }
  }

  const tokenBudget = new TokenBudget({
    maxTokens: config.get('maxBudgetTokens') || 200_000,
  })

  // 初始化通讯通道
  const channelManager = new ChannelManager({
    channels: config.get('channels') || {},
    defaultChannel: config.get('defaultChannel') || null,
  })

  // 一次性输入模式
  if (cliArgs.oneShot) {
    const result = await engine.processMessage(cliArgs.oneShot)
    console.log(result.response)
    // 一次性模式结束后发通知
    if (channelManager.list().length > 0) {
      await channelManager.sendTemplate('task-done', {
        task: cliArgs.oneShot.slice(0, 80),
        result: result.response.slice(0, 200),
      })
    }
    process.exit(0)
  }

  // REPL 模式
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> ',
  })

  console.log(BANNER)
  console.log(`Model: ${model} | Permission: ${permissionMode} | Tools: ${registry.getNames().join(', ')}`)
  if (channelManager.list().length > 0) {
    const chList = channelManager.list().join(', ')
    const def = channelManager.defaultChannel ? ` (default: ${channelManager.defaultChannel})` : ''
    console.log(`Channels: ${chList}${def}`)
  }
  console.log()
  rl.prompt()

  rl.on('line', async (line) => {
    const input = line.trim()
    if (!input) { rl.prompt(); return }

    // 命令处理
    if (input.startsWith('/')) {
      const [cmd, ...rest] = input.slice(1).split(' ')
      switch (cmd) {
        case 'help':
          console.log(HELP_TEXT)
          break
        case 'model':
          if (rest[0]) {
            engine.config.model = rest.join(' ')
            console.log(`Model switched to: ${engine.config.model}`)
          } else {
            console.log(`Current model: ${engine.config.model}`)
          }
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
          if (sessions.length === 0) {
            console.log('No sessions found')
          } else {
            for (const s of sessions) {
              console.log(`  ${s.id} — ${s.title} (${s.messageCount} msgs, ${s.updated})`)
            }
          }
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
        case 'budget':
          console.log(tokenBudget.format())
          break
        case 'channel': {
          const subCmd = rest.join(' ')
          if (subCmd === 'list' || subCmd === '') {
            const channels = channelManager.list()
            if (channels.length === 0) {
              console.log('No channels configured')
              console.log('Setup options:')
              console.log('  1. Environment: CC_NODE_CHANNEL_TELEGRAM_TOKEN=xxx CC_NODE_CHANNEL_TELEGRAM_CHAT_ID=xxx')
              console.log('  2. Config: .claude-code/config.json -> { "channels": { "telegram": { ... } } }')
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
            for (const r of results) {
              console.log(r.ok ? `✅ ${r.channel}: sent` : `❌ ${r.channel}: ${r.error}`)
            }
          } else if (subCmd.startsWith('test')) {
            const results = await channelManager.send('📡 cc-node channel test')
            for (const r of results) {
              console.log(r.ok ? `✅ ${r.channel}: test OK` : `❌ ${r.channel}: ${r.error}`)
            }
          } else {
            console.log('Usage:')
            console.log('  /channel list          — List configured channels')
            console.log('  /channel send <msg>    — Send message to channels')
            console.log('  /channel test          — Test channel connectivity')
          }
          break
        }
        case 'exit':
        case 'quit':
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
      const result = await engine.processMessage(input)

      // 输出助手回复
      console.log()
      console.log(result.response)
      console.log()

      // 保存到会话
      await sessionManager.appendMessage({ role: 'user', content: input })
      await sessionManager.appendMessage({ role: 'assistant', content: result.response })

      if (verbose) {
        console.log(`[Turns: ${result.turns} | Tools: ${result.toolResults.length}]`)
      }
    } catch (err) {
      console.error(`\nError: ${err.message}\n`)
      // 错误也通知
      if (channelManager.list().length > 0) {
        await channelManager.sendTemplate('error', {
          task: input.slice(0, 80),
          error: err.message.slice(0, 200),
        }).catch(() => {}) // 通知失败不影响主流程
      }
    }
    rl.prompt()
  })

  rl.on('close', () => {
    console.log('\nGoodbye!')
    process.exit(0)
  })
}
