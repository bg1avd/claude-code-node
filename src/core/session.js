/**
 * 会话管理
 * 对应原版: src/utils/sessionState.ts + src/utils/sessionStorage.ts
 */
import { readFile, writeFile, mkdir, readdir, rm } from 'fs/promises'
import { resolve, join } from 'path'
import { existsSync } from 'fs'
import { SessionState } from '../types/index.js'

const DEFAULT_SESSIONS_DIR = '.claude-code/sessions'

export class SessionManager {
  constructor(options = {}) {
    this.sessionsDir = options.sessionsDir || resolve(process.cwd(), DEFAULT_SESSIONS_DIR)
    this.currentSession = null
  }

  /** 确保会话目录存在 */
  async ensureDir() {
    await mkdir(this.sessionsDir, { recursive: true })
  }

  /** 创建新会话 */
  async create(title = '') {
    await this.ensureDir()
    const id = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const session = {
      id,
      title: title || `Session ${new Date().toISOString().slice(0, 19)}`,
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      messages: [],
      state: { turnCount: 0, budgetUsed: 0 },
    }
    await this.save(session)
    this.currentSession = session
    return session
  }

  /** 保存会话 */
  async save(session) {
    await this.ensureDir()
    session.updated = new Date().toISOString()
    const filePath = join(this.sessionsDir, `${session.id}.json`)
    await writeFile(filePath, JSON.stringify(session, null, 2), 'utf-8')
    return session
  }

  /** 加载会话 */
  async load(sessionId) {
    const filePath = join(this.sessionsDir, `${sessionId}.json`)
    try {
      const data = await readFile(filePath, 'utf-8')
      const session = JSON.parse(data)
      this.currentSession = session
      return session
    } catch (err) {
      if (err.code === 'ENOENT') {
        return null
      }
      throw err
    }
  }

  /** 列出所有会话 */
  async list() {
    await this.ensureDir()
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
    this.currentSession.messages.push({
      role: message.role,
      content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
      timestamp: new Date().toISOString(),
    })
    await this.save(this.currentSession)
    return this.currentSession
  }
}
