/**
 * attach-client.js — `cc-node attach`：把当前终端的 stdin/stdout 变成内核的一个视图
 *
 * 它不是"另一个 cc-node"。它连的是**用户自己在终端启动的那个进程**，
 * 因此看到的是同一份上下文、同一份调度器、同一个正在跑的回合。
 *
 * 用法
 * ----
 *   cc-node attach                      # 可输入（controller），接当前会话
 *   cc-node attach --viewer             # 只读围观（手机改、电脑看）
 *   cc-node attach --since 1234         # 断线重连：补齐 seq>1234 的结构性事件
 *   cc-node attach --sock /tmp/x.sock   # 自定义 socket（测试 / 多实例）
 *
 * 设计约束
 * --------
 * **绝不自动 spawn 内核**。内核没在跑时给出明确提示并退出 ——
 * 进程的存在必须和"我知道它在哪"绑定（否则用户 kill 掉的还会丢梦境）。
 */

import { connect } from 'node:net'
import { createInterface } from 'node:readline'
import { existsSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'

const DEFAULT_SOCK = platform() === 'win32'
  ? '\\\\.\\pipe\\cc-node'
  : join(homedir(), '.cc-node', 'repl.sock')

// ANSI
const C = {
  dim: s => `\x1b[2m${s}\x1b[0m`,
  cyan: s => `\x1b[36m${s}\x1b[0m`,
  green: s => `\x1b[32m${s}\x1b[0m`,
  red: s => `\x1b[31m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  bold: s => `\x1b[1m${s}\x1b[0m`,
}

/** 解析 attach 子命令参数 */
function parseAttachArgs(argv) {
  const opts = { sock: DEFAULT_SOCK, role: 'controller', sinceSeq: 0 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--viewer' || a === '--read-only') opts.role = 'viewer'
    else if (a === '--controller') opts.role = 'controller'
    else if (a === '--sock') opts.sock = argv[++i]
    else if (a === '--since') opts.sinceSeq = Number(argv[++i]) || 0
    else if (a === '--help' || a === '-h') opts.help = true
  }
  return opts
}

const HELP = `
cc-node attach — 接入正在运行的 cc-node（同一份上下文）

用法:
  cc-node attach [选项]

选项:
  --viewer            只读模式（不能输入/中断/确认）
  --since <seq>       断线重连：补齐 seq 大于该值的事件
  --sock <path>       自定义 socket 路径（默认 ~/.cc-node/repl.sock）
  -h, --help          显示帮助

说明:
  内核必须已在终端启动。本命令**不会**自动拉起新进程。

交互命令:
  /sessions           列出会话
  /resume <id>        切换会话（会同时改变终端那边的上下文）
  /new                新建会话（等于终端 /clear，会清掉所有视图的上下文）
  /messages [n]       读当前会话的完整消息（默认 200 条，来自会话文件）
  /history [n]        补最近 n 个回合的正文（断线重连后有用，默认 5）
  /schedules          查看定时任务
  /abort 或 Ctrl+C    中断当前回合
  /quit 或 Ctrl+D     退出
`

/**
 * 入口
 * @param {string[]} argv 不含 "attach" 本身的参数
 */
export async function runAttach(argv = []) {
  const opts = parseAttachArgs(argv)

  if (opts.help) {
    process.stdout.write(HELP)
    return
  }

  if (!existsSync(opts.sock) && platform() !== 'win32') {
    console.error(C.red('✗ cc-node 未运行'))
    console.error(C.dim(`  找不到 socket: ${opts.sock}`))
    console.error(C.dim('  请先在另一个终端运行 cc-node，然后再执行本命令。'))
    process.exitCode = 1
    return
  }

  await new Promise((resolve) => {
    const sock = connect(opts.sock)
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY })

    let connected = false
    let busy = false          // 本视图认为内核是否在跑
    let streamedThisTurn = false
    let pendingConfirm = null // 正在等待用户回答的确认请求 id
    let buf = ''
    let closing = false

    const write = (s) => { try { process.stdout.write(s) } catch {} }

    function finish(code = 0) {
      if (closing) return
      closing = true
      try { rl.close() } catch {}
      try { sock.destroy() } catch {}
      process.exitCode = code
      resolve()
    }

    sock.setEncoding('utf8')
    sock.on('connect', () => {
      connected = true
      sock.write(JSON.stringify({ type: 'attach', role: opts.role, sinceSeq: opts.sinceSeq }) + '\n')
    })
    sock.on('data', (chunk) => {
      buf += chunk
      const lines = buf.split('\n')
      buf = lines.pop()
      for (const line of lines) {
        if (!line.trim()) continue
        let ev
        try { ev = JSON.parse(line) } catch { continue }
        renderEvent(ev)
      }
    })
    sock.on('error', (e) => {
      if (!connected) {
        console.error(C.red(`✗ 连接失败: ${e.code || e.message}`))
        console.error(C.dim('  内核可能刚退出。请重新在终端启动 cc-node。'))
        finish(1)
      } else {
        console.error(C.yellow(`\n⚠ 连接中断: ${e.message}`))
        finish(0)
      }
    })
    sock.on('close', () => {
      if (!closing) {
        write(C.dim('\n（内核已关闭连接）\n'))
        finish(0)
      }
    })

    // ---------------- 渲染 ----------------
    function renderEvent(ev) {
      switch (ev.type) {
        case 'attached':
          busy = !!ev.running
          write(C.dim(`✓ 已接入 cc-node (pid ${ev.pid}) · ${ev.role === 'controller' ? '可输入' : '只读'} · ` +
            `session ${String(ev.sessionTitle || ev.session || 'new').slice(0, 24)}\n`))
          if (ev.cwd || ev.model || ev.permissionMode) {
            write(C.dim(`  ${ev.cwd || '?'} · ${ev.model || '?'} · 权限 ${ev.permissionMode || '?'}\n`))
          }
          if (busy) write(C.dim('  （当前有回合在跑，会从此刻开始显示进度）\n'))
          if (ev.queued) write(C.dim(`  （有 ${ev.queued} 条排队的输入将按序执行）\n`))
          write(C.dim('  输入消息回车发送 · Ctrl+C 中断回合 · Ctrl+D 或 /quit 退出\n'))
          write(C.dim('  /sessions 会话列表 · /resume <id> 切换 · /new 新建 · /history [n] 补回合正文 · /schedules 定时任务\n\n'))
          prompt()
          return

        case 'turn/start':
          busy = true
          streamedThisTurn = false
          write(C.dim('\n── 回合开始 ──\n'))
          return

        case 'turn/snapshot':
          if (ev.text) { write(ev.text); streamedThisTurn = true }
          return

        case 'stream':
          if (ev.kind === 'reasoning') {
            if (ev.text) write(C.dim(ev.text))
          } else if (ev.text) {
            write(ev.text)
            streamedThisTurn = true
          }
          return

        case 'tool/call':
          write(`\n${C.cyan('⚙ ' + ev.name)} ${C.dim(clip(ev.input, 160))}\n`)
          return

        case 'tool/result':
          write(ev.ok ? C.green(`  ✓ ${ev.name} 完成\n`) : C.red(`  ✗ ${ev.name} 失败: ${clip(ev.summary, 200)}\n`))
          return

        case 'confirm/request':
          pendingConfirm = ev.id
          write(C.yellow(`\n⚠ ${ev.question}\n   ${C.dim(clip(ev.snippet, 200))}\n`))
          write(C.yellow('   回答 y=允许 / n=拒绝 / a=本会话全部允许 › '))
          return

        case 'confirm/resolved': {
          if (pendingConfirm === ev.id) pendingConfirm = null
          const who = ev.by ? ` (${ev.by})` : ''
          write(C.dim(`   确认结果: ${ev.answer}${who}\n`))
          return
        }

        case 'turn/end':
          busy = false
          if (ev.error) write(C.red(`\n✗ 回合出错: ${ev.error}\n`))
          else if (!streamedThisTurn && ev.text) write(ev.text)
          write(C.dim(`\n── 回合结束（${ev.turns} 轮${ev.aborted ? ' · 已中断' : ''}）──\n`))
          prompt()
          return

        case 'status':
          busy = ev.state === 'running'
          return

        case 'queued':
          write(C.dim(`  ⏳ 已排队（第 ${ev.position} 位）\n`))
          return

        case 'notice':
          write(C.dim(`  ${ev.text}\n`))
          return

        case 'command/output':
          // 远程发的 /命令 的输出（不是内核事件，所以原样打印）
          write(ev.text.endsWith('\n') ? ev.text : ev.text + '\n')
          prompt()
          return

        case 'sessions':
          write(C.bold('\n会话列表:\n'))
          for (const s of ev.list || []) {
            write(`  ${String(s.id).slice(0, 8)}  ${s.title || '(无标题)'}  ${C.dim(s.updatedAt || s.updated || '')}\n`)
          }
          write(C.dim('  切换：/resume <id> · 新建：/new\n'))
          prompt()
          return

        case 'session/messages': {
          const list = ev.messages || []
          if (ev.error) { write(C.red(`\n✗ ${ev.error}\n`)); prompt(); return }
          write(C.bold(`\n会话 ${String(ev.sessionId || '').slice(0, 8)} 共 ${ev.total} 条消息` +
            `${ev.truncated ? '（已截断）' : ''}:\n`))
          for (const m of list) {
            const role = m.role === 'user' ? C.cyan('你') : C.green('AI')
            const ts = (m.timestamp || '').slice(11, 19)
            write(`\n${role} ${C.dim(ts)}\n${String(m.content ?? '').slice(0, 4000)}\n`)
          }
          prompt()
          return
        }

        case 'scheduler/list': {
          if (ev.available === false) {
            write(C.dim('\n（本内核没有调度器）\n'))
            prompt()
            return
          }
          const list = ev.tasks || []
          if (!list.length) { write(C.dim('\n（没有待办定时任务）\n')); prompt(); return }
          write(C.bold(`\n待办 ${list.length} 条:\n`))
          for (const t of list) {
            const flag = t.status === 'running' ? '🏃 执行中' : '⏳'
            write(`  ${t.id}  [${t.kind}] ${flag}  ${t.dueDesc || ''}\n`)
            if (t.text) write(C.dim(`        ${String(t.text).slice(0, 60)}\n`))
            if (t.cmd) write(C.dim(`        $ ${String(t.cmd).slice(0, 60)}\n`))
          }
          prompt()
          return
        }

        case 'schedule/triggered':
          write(C.dim(`\n⏰ 定时任务触发: ${ev.taskId}${ev.cmd ? ` (${String(ev.cmd).slice(0, 60)})` : ''}\n`))
          return

        case 'schedule/finished':
          write(C.dim(`⏰ 定时任务结束: ${ev.taskId} → ${ev.status}\n`))
          return

        case 'session/loaded': {
          const label = {
            new: '🆕 已新建会话', clear: '🧹 会话已清空', cd: '📂 已切换项目',
            resume: '🔁 会话已切换', load: '🔁 会话已切换',
          }[ev.reason] || '🔁 会话已变更'
          write(C.green(`\n${label}: ${ev.title || ev.id}\n`))
          if (ev.cwd) write(C.dim(`   目录: ${ev.cwd}\n`))
          prompt()
          return
        }

        case 'turn/history': {
          const list = ev.turns || []
          if (!list.length) {
            write(C.dim('  （没有可补的回合）\n'))
            prompt()
            return
          }
          write(C.bold(`\n最近 ${list.length} 个回合:\n`))
          for (const t of list) {
            const time = new Date(t.ts).toLocaleTimeString()
            write(C.dim(`\n── ${time}${t.aborted ? ' · 已中断' : ''}${t.error ? ' · 出错' : ''} ──\n`))
            write((t.error ? C.red(t.error) : (t.text || C.dim('(空)'))) + '\n')
          }
          prompt()
          return
        }

        case 'error':
          write(C.red(`\n✗ ${ev.text}\n`))
          prompt()
          return
      }
    }

    function prompt() {
      if (opts.role === 'viewer') return
      write(C.bold('› '))
    }

    // ---------------- 输入 ----------------
    rl.on('line', (line) => {
      const text = line.trim()

      // 确认应答优先消费
      if (pendingConfirm) {
        const a = text.toLowerCase()
        if (a === 'y' || a === 'n' || a === 'a') {
          sock.write(JSON.stringify({ type: 'confirm', id: pendingConfirm, answer: a }) + '\n')
          pendingConfirm = null
          return
        }
        // 其它输入视为放弃回答（让用户继续正常对话）
        pendingConfirm = null
        write(C.dim('  （已跳过确认，超时后自动拒绝）\n'))
      }

      if (!text) { prompt(); return }
      if (text === '/quit' || text === '/exit') { finish(0); return }
      if (text === '/abort' || text === '/stop') {
        sock.write(JSON.stringify({ type: 'abort' }) + '\n')
        return
      }
      if (text === '/sessions') {
        sock.write(JSON.stringify({ type: 'session_list' }) + '\n')
        return
      }
      if (text === '/resume' || text.startsWith('/resume ')) {
        const id = text.slice('/resume'.length).trim()
        if (!id) {
          write(C.yellow('用法: /resume <session-id>（先用 /sessions 查）\n'))
          prompt()
          return
        }
        sock.write(JSON.stringify({ type: 'session_load', sessionId: id }) + '\n')
        return
      }
      if (text === '/history' || text.startsWith('/history ')) {
        const n = Number(text.split(/\s+/)[1]) || 5
        sock.write(JSON.stringify({ type: 'turn_history', limit: n }) + '\n')
        return
      }
      if (text === '/new') {
        sock.write(JSON.stringify({ type: 'session_new' }) + '\n')
        return
      }
      if (text === '/schedules' || text === '/schedule') {
        sock.write(JSON.stringify({ type: 'scheduler_list' }) + '\n')
        return
      }
      if (text === '/messages' || text.startsWith('/messages ')) {
        const n = Number(text.split(/\s+/)[1]) || 200
        sock.write(JSON.stringify({ type: 'session_messages', limit: n }) + '\n')
        return
      }

      sock.write(JSON.stringify({ type: 'input', text }) + '\n')
      // 输入已提交；回合开始后会有输出，这里不急着显示提示符
    })

    rl.on('close', () => finish(0))

    // Ctrl+C：有回合在跑就中断，否则退出（与终端 REPL 语义一致）
    rl.on('SIGINT', () => {
      if (busy) {
        sock.write(JSON.stringify({ type: 'abort' }) + '\n')
        write(C.yellow('\n（已请求中断）\n'))
      } else {
        finish(0)
      }
    })
  })
}

function clip(v, max) {
  const s = typeof v === 'string' ? v : (() => { try { return JSON.stringify(v) } catch { return String(v) } })()
  return s.length > max ? s.slice(0, max) + '…' : s
}
