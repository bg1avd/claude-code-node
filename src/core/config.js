/**
 * 配置管理
 * 对应原版: src/query/config.ts + src/utils/config.ts
 */
import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'

const PROJECT_CONFIG_FILE = '.claude-code/config.json'
const USER_CONFIG_FILE = join(homedir(), '.claude-code/config.json')

/**
 * 默认配置
 */
const DEFAULTS = {
  model: 'deepseek-flash',
  apiBase: 'https://api.deepseek.com/v1',
  maxTurns: 100,
  maxBudgetTokens: 1_000_000,
  permissionMode: 'ask',
  verbose: false,
  apiKey: '',
  sessionsDir: '.claude-code/sessions',
  dreamsDir: '.claude-code/dreams',
  dreamWakeRecent: 3,
  dream: {
    maxRetain: 50,
    minLLMMessages: 8, // 会话达到此消息数才调用本地摘要模型（省成本）
    // 本地小模型摘要（可选）：配置后入睡时用该模型把会话整理成"按方向分类"的总结，
    // 不占用付费/云端主模型 token。示例：
    // { "apiBase": "http://127.0.0.1:11434/v1", "model": "qwen2.5:7b", "apiKey": "" }
    // 未配置时自动降级为纯本地启发式摘要（离线可用）。
    summarizer: null,
  },
  tools: {
    bash: { timeout: 120, allowed: true },
    fileRead: { maxLines: 2000, maxSizeKB: 256 },
    webFetch: { timeout: 30, maxChars: 100000 },
  },
  web: {
    fetch: {
      maxChars: 100000,
      maxBytes: 10485760,  // 10MB
      timeoutMs: 30000,
      maxRedirects: 5,
      fallbackProvider: 'safe-jina',  // 直连失败时的兜底 provider
      jinaApiKey: '',                  // 可选（匿名约 20 RPM）
    },
  },
  channels: {},
  defaultChannel: null,
  qqbot: {
    enabled: false,
    accounts: {
      default: {
        enabled: true,
        appId: '',
        clientSecret: '',
        dmPolicy: 'open',
        groupPolicy: 'open',
        allowFrom: ['*'],
        defaultTargets: {}
      }
    },
    defaultAccount: 'default',
    globalDmPolicy: 'open',
    globalGroupPolicy: 'open',
    globalAllowFrom: ['*']
  },
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

  /**
   * 只持久化单个键到用户级配置（支持点路径）。
   * 与 saveToUser 的区别：saveToUser 写【内存全量快照】，会把当时未改动的默认值
   * （如 model）一并固化进用户配置文件，之后升级改默认值也永远不生效（用户级 > 默认）。
   * 本方法只改磁盘文件上的这一个键，其余内容原样保留，不引入快照固化。
   */
  async saveKeyToUser(key, value) {
    this.set(key, value)
    let disk = {}
    try {
      disk = JSON.parse(await readFile(this._userPath, 'utf8')) || {}
      if (typeof disk !== 'object' || Array.isArray(disk)) disk = {}
    } catch { /* 文件不存在或不合法 → 从空对象开始 */ }
    const parts = key.split('.')
    let cur = disk
    for (let i = 0; i < parts.length - 1; i++) {
      if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {}
      cur = cur[parts[i]]
    }
    cur[parts[parts.length - 1]] = value
    await mkdir(join(homedir(), '.claude-code'), { recursive: true })
    await writeFile(this._userPath, JSON.stringify(disk, null, 2), 'utf-8')
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
