/**
 * 会话管理
 * 对应原版: src/utils/sessionState.ts + src/utils/sessionStorage.ts
 */
import { readFile, writeFile, mkdir, readdir, rm, chmod } from 'fs/promises'
import { resolve, join } from 'path'
import { homedir } from 'os'
import { randomBytes } from 'crypto'

// 会话目录默认落在**机器级** ~/.cc-node/sessions（一台机器一个 cc-node，会话集中一处）。
// 与 src/stdio/server.js 的会话目录一致，也与 config.DEFAULTS.sessionsDir 一致。
const DEFAULT_SESSIONS_DIR = join(homedir(), '.cc-node', 'sessions')

/** 旧版自动标题的形态：`Session 2026-10-24T08:07:39`（纯时间戳，列表里无法分辨） */
const AUTO_TITLE_RE = /^Session \d{4}-\d{2}-\d{2}T[\d:.]+$/

/**
 * 从首条用户消息里提炼会话标题。
 *
 * 为什么需要：自动标题原本是 `Session <ISO 时间戳>`，会话列表里一屏全是
 * 长得一样的行。手机端只有一个会话库、又看不到终端，靠时间戳根本找不到
 * 想要的对话。这里用首条 user 消息做标题，成本最低、信息量最大。
 */
function deriveTitle(content, max = 40) {
  const s = String(content ?? '')
    .replace(/```[\s\S]*?```/g, ' ')        // 去掉代码块（占了标题位置又不可读）
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')  // 图片 markdown
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*`_~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!s) return ''
  return s.length > max ? s.slice(0, max) + '…' : s
}

export class SessionManager {
  constructor(options = {}) {
    this.sessionsDir = options.sessionsDir || resolve(process.cwd(), DEFAULT_SESSIONS_DIR)
    this.currentSession = null
  }

  /** 确保会话目录存在（v1.1: 目录权限 0700） */
  async ensureDir() {
    await mkdir(this.sessionsDir, { recursive: true, mode: 0o700 })
  }

  /**
   * 创建新会话
   *
   * @param {string} [title] 会话标题
   * @param {object} [meta]
   * @param {string} [meta.cwd] 会话归属目录（默认 process.cwd()）。
   *   记它是为了让「启动时续接上一次会话」能按**当前目录**挑，
   *   而不是把别的项目的对话续接进来（一个项目一份上下文）。
   */
  async create(title = '', meta = {}) {
    await this.ensureDir()
    // M4 fix: 使用 crypto.randomBytes 生成不可预测的会话 ID
    const id = `session-${Date.now()}-${randomBytes(8).toString('hex')}`
    const session = {
      id,
      title: title || `Session ${new Date().toISOString().slice(0, 19)}`,
      // 标题是自动生成的（时间戳占位）→ 允许首条用户消息把它改写成可读标题。
      // 显式命名过的会话永远不动。
      titleAuto: !title,
      cwd: meta.cwd || process.cwd(),
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      messages: [],
      state: { turnCount: 0, budgetUsed: 0 },
    }
    await this.save(session)
    this.currentSession = session
    return session
  }

  /** 保存会话（v1.1: 文件权限 0600，防止其他用户读取敏感对话内容） */
  async save(session) {
    await this.ensureDir()
    // v4.0.0 兜底：会话必须有归属目录。缺失时视为"当前目录"——
    // 老会话被 /resume 加载后继续用、或由 stdio 侧创建时，都会在这里被补齐，
    // 之后就能参与「按目录自动续接」。
    if (!session.cwd) session.cwd = process.cwd()
    session.updated = new Date().toISOString()
    const filePath = join(this.sessionsDir, `${session.id}.json`)
    await writeFile(filePath, JSON.stringify(session, null, 2), { encoding: 'utf-8', mode: 0o600 })
    return session
  }

  /** 加载会话 */
  async load(sessionId) {
    const filePath = join(this.sessionsDir, `${sessionId}.json`)
    try {
      const data = await readFile(filePath, 'utf-8')
      const session = JSON.parse(data)
      // v4.0.0：老会话没有 cwd。被显式加载 = 用户"要在当前目录继续它"，
      // 就地认领（下次 save 会落盘），这样它也能进入「按目录自动续接」的候选集。
      if (!session.cwd) session.cwd = process.cwd()
      this.currentSession = session
      return session
    } catch (err) {
      if (err.code === 'ENOENT') {
        return null
      }
      throw err
    }
  }

  /**
   * 只读地取一个会话（**不改变 currentSession**）。
   *
   * 为什么单独加：load() 会把 currentSession 指针切走 —— 那是"用户要求切换"的语义。
   * 而远程视图拉取某个会话的历史只是**看**，绝不能顺手把内核的当前上下文换掉。
   * @returns {Promise<object|null>} 会话对象；不存在返回 null
   */
  async read(sessionId) {
    if (!sessionId) return null
    try {
      const data = await readFile(join(this.sessionsDir, `${sessionId}.json`), 'utf-8')
      return JSON.parse(data)
    } catch (err) {
      if (err.code === 'ENOENT') return null
      throw err
    }
  }

  /** 列出所有会话 */
  async list() {    await this.ensureDir()
    const files = await readdir(this.sessionsDir)
    const sessions = []
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      try {
        const data = await readFile(join(this.sessionsDir, file), 'utf-8')
        const session = JSON.parse(data)
        sessions.push({
          id: session.id,
          title: session.title,
          // 会话归属目录（4.0.0 起记录；更早的会话没有这个字段 → undefined）
          cwd: session.cwd || '',
          created: session.created,
          updated: session.updated,
          messageCount: session.messages?.length || 0,
        })
      } catch { /* skip corrupted */ }
    }
    // 按更新时间倒序
    sessions.sort((a, b) => new Date(b.updated) - new Date(a.updated))
    return sessions
  }

  /**
   * 列出某个目录下的会话（按 updated 倒序）。
   * 供「启动时续接本项目的上一次会话」使用 —— 一个项目一份上下文。
   * @param {string} [cwd] 默认当前工作目录
   */
  async listForCwd(cwd = process.cwd()) {
    const all = await this.list()
    return all.filter(s => s.cwd === cwd)
  }

  /** 删除会话 */
  async delete(sessionId) {
    const filePath = join(this.sessionsDir, `${sessionId}.json`)
    try {
      await rm(filePath)
      if (this.currentSession?.id === sessionId) {
        this.currentSession = null
      }
      return true
    } catch {
      return false
    }
  }

  /** 获取或创建当前会话 */
  async getOrCreate(title) {
    if (this.currentSession) return this.currentSession
    return this.create(title)
  }

  /** 追加消息到当前会话 */
  async appendMessage(message) {
    if (!this.currentSession) await this.getOrCreate()

    const entry = {
      role: message.role,
      content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
      timestamp: new Date().toISOString(),
    }

    // 保存 tool_calls 信息（assistant 消息可能包含工具调用）
    if (message.toolCalls && message.toolCalls.length > 0) {
      entry.toolCalls = message.toolCalls.map(tc => ({
        id: tc.id,
        name: tc.name,
        input: tc.input,
      }))
    }

    // 保存 tool_call_id（tool 结果消息）
    if (message.tool_call_id) {
      entry.tool_call_id = message.tool_call_id
    }

    this.currentSession.messages.push(entry)

    // 首条用户消息 → 把时间戳标题换成可读标题（只改一次；显式命名过的永不覆盖）
    if (message.role === 'user') {
      const cur = this.currentSession
      const auto = cur.titleAuto === true || AUTO_TITLE_RE.test(cur.title || '')
      if (auto) {
        const t = deriveTitle(entry.content)
        // 太短的输入（"hi"、"1"、"y"）当标题没有任何区分度，等下一句
        if (t.length >= 4) {
          cur.title = t
          cur.titleAuto = false
        }
      }
    }

    await this.save(this.currentSession)
    return this.currentSession
  }
}
