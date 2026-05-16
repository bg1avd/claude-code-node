/**
 * 配置管理
 * 对应原版: src/query/config.ts + src/utils/config.ts
 */
import { readFile, writeFile, mkdir } from 'fs/promises'
import { resolve, join } from 'path'
import { existsSync } from 'fs'
import { homedir } from 'os'

const PROJECT_CONFIG_FILE = '.claude-code/config.json'
const USER_CONFIG_FILE = join(homedir(), '.claude-code/config.json')

/**
 * 默认配置
 */
const DEFAULTS = {
  model: 'deepseek-chat',
  apiBase: 'https://api.deepseek.com/v1',
  maxTurns: 100,
  maxBudgetTokens: 1_000_000,
  permissionMode: 'ask',
  verbose: false,
  apiKey: '',
  sessionsDir: '.claude-code/sessions',
  tools: {
    bash: { timeout: 120, allowed: true },
    fileRead: { maxLines: 2000, maxSizeKB: 256 },
    webFetch: { timeout: 30, maxChars: 100000 },
  },
    channels: {},
    defaultChannel: null,
  mcp: {
    servers: {},
  },
}

export class Config {
  constructor() {
    this.data = { ...DEFAULTS }
    this._projectPath = null
    this._userPath = USER_CONFIG_FILE
  }

  /** 从项目目录加载配置 */
  async loadFromProject(projectDir) {
    this._projectPath = join(projectDir, PROJECT_CONFIG_FILE)
    await this._load(this._projectPath)
  }

  /** 从用户目录加载配置 */
  async loadFromUser() {
    await this._load(this._userPath)
  }

  /** 完整加载流程：用户级 → 项目级（项目级覆盖用户级） */
  async load(projectDir) {
    await this.loadFromUser()
    if (projectDir) await this.loadFromProject(projectDir)
  }

  async _load(filePath) {
    try {
      const raw = await readFile(filePath, 'utf-8')
      const data = JSON.parse(raw)
      this.data = this._deepMerge(this.data, data)
    } catch {
      // 文件不存在或不合法 — 使用默认值
    }
  }

  /** 保存到项目配置 */
  async saveToProject(projectDir) {
    const dir = join(projectDir, '.claude-code')
    await mkdir(dir, { recursive: true })
    const filePath = join(dir, 'config.json')
    await writeFile(filePath, JSON.stringify(this.data, null, 2), 'utf-8')
  }

  /** 保存到用户配置 */
  async saveToUser() {
    const dir = join(homedir(), '.claude-code')
    await mkdir(dir, { recursive: true })
    await writeFile(this._userPath, JSON.stringify(this.data, null, 2), 'utf-8')
  }

  /** 获取配置值（支持点号路径，如 "tools.bash.timeout"） */
  get(key) {
    if (!key) return this.data
    const parts = key.split('.')
    let current = this.data
    for (const part of parts) {
      if (current == null) return undefined
      current = current[part]
    }
    return current
  }

  /** 设置配置值 */
  set(key, value) {
    const parts = key.split('.')
    let current = this.data
    for (let i = 0; i < parts.length - 1; i++) {
      if (current[parts[i]] == null) current[parts[i]] = {}
      current = current[parts[i]]
    }
    current[parts[parts.length - 1]] = value
  }

  /** 深度合并 */
  _deepMerge(target, source) {
    const result = { ...target }
    for (const key of Object.keys(source)) {
      if (
        source[key] &&
        typeof source[key] === 'object' &&
        !Array.isArray(source[key]) &&
        target[key] &&
        typeof target[key] === 'object' &&
        !Array.isArray(target[key])
      ) {
        result[key] = this._deepMerge(target[key], source[key])
      } else {
        result[key] = source[key]
      }
    }
    return result
  }

  /** 导出为 JSON */
  toJSON() {
    return { ...this.data }
  }
}
