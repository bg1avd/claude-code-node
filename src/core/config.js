/**
 * 配置管理
 * 对应原版: src/query/config.ts + src/utils/config.ts
 */
import { readFile, writeFile, rename, unlink, copyFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'

const PROJECT_CONFIG_FILE = '.claude-code/config.json'
const USER_CONFIG_FILE = join(homedir(), '.claude-code/config.json')

/**
 * 原子写文件：先写同目录临时文件，再 rename 覆盖目标。
 * rename 在同一文件系统上是原子操作 — 即使进程在写入中途崩溃/断电，
 * 也只会留下一个 .tmp-* 残留文件，绝不会把目标 JSON 写坏一半。
 * （直接 writeFile 覆盖已有文件在崩溃时可能留下截断的 JSON，导致配置丢失）
 */
async function atomicWriteFile(filePath, content) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`
  try {
    await writeFile(tmp, content, 'utf-8')
    await rename(tmp, filePath)
  } catch (e) {
    try { await unlink(tmp) } catch { /* 清理失败不掩盖原错误 */ }
    throw e
  }
}

/**
 * 默认配置
 */
const DEFAULTS = {
  model: 'deepseek-flash',
  apiBase: 'https://api.deepseek.com/v1',
  // Telegram 提示语言：'zh'/'中文' 等含中文标识 → 中文；
  // 留空则自动（TG 消息 from.language_code 是 zh → 中文，否则英文）
  language: '',
  maxTurns: 100,
  maxBudgetTokens: 1_000_000,
  permissionMode: 'ask',
  verbose: false,
  apiKey: '',
  // 会话目录：默认**机器级**（~/.cc-node/sessions，与 stdio 入口一致）。
  // 一台机器只需跑一个 cc-node；所有会话集中一处，便于 /resume 与「退出后续接上次话题」。
  sessionsDir: join(homedir(), '.cc-node', 'sessions'),
  dreamsDir: '.claude-code/dreams',
  dreamWakeRecent: 3,
  // 上下文自动压缩：到窗口阈值自动压缩（不卡死、不丢）。默认开；置 false 可关闭。
  autoCompact: true,
  // 启动自动续接「上一次会话」：等价默认 --resume last。默认开；置 false 则每次全新会话。
  autoContinue: true,
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
    // 额外的自定义工具目录（支持 ~ 展开）。机器级 ~/.cc-node/tools 与项目级
    // <cwd>/.claude-code/tools 会**自动扫描**，无需在此声明；此处用于挂其它位置的工具集。
    customDirs: [],
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
    // 顶层键来源追踪: 'user' | 'project' — 用于诊断"配置值到底来自哪个文件"
    this._keySources = {}
    // 每一层的**原始**解析结果（未合并）。供"分层叠加"型字段使用（如 identity）。
    this._raw = {}
  }

  /** 从项目目录加载配置 */
  async loadFromProject(projectDir) {
    this._projectPath = join(projectDir, PROJECT_CONFIG_FILE)
    await this._load(this._projectPath, 'project')
  }

  /** 从用户目录加载配置 */
  async loadFromUser() {
    await this._load(this._userPath, 'user')
  }

  /** 完整加载流程：用户级 → 项目级（项目级覆盖用户级） */
  async load(projectDir) {
    await this.loadFromUser()
    if (projectDir) await this.loadFromProject(projectDir)
  }

  /** 查询顶层键来自哪个配置源: 'user' | 'project' | null(内置默认) */
  keySource(key) {
    return this._keySources[key.split('.')[0]] || null
  }

  /**
   * 读取某个配置源(level: 'user' | 'project')的**原始**值（不参与合并）。
   * 用于需要"分层叠加"而非"高层覆盖低层"的字段——典型是 identity：
   * 机器级基线 + 目录级角色要**同时生效**，而 get() 只会返回覆盖后的单一值。
   */
  getRaw(level, key) {
    const d = this._raw?.[level]
    if (!d) return undefined
    if (!key) return d
    let cur = d
    for (const p of key.split('.')) {
      if (cur == null) return undefined
      cur = cur[p]
    }
    return cur
  }

  /**
   * 一次性迁移：把配置文件里残留的旧模型名 deepseek-chat 自动改名为 deepseek-flash。
   * 背景: 旧版 /window 曾把当时默认值 model:'deepseek-chat' 全量快照固化进配置文件，
   * 导致升级后新默认值永远不生效。DeepSeek 官方已由 V4.1 Flash 接管 deepseek-chat，
   * 改名即可无缝迁移，故启动时自动重写磁盘文件并更新内存。
   * 仅在 apiBase 指向 DeepSeek 官方时执行，避免误改第三方代理下的同名模型。
   * @returns {boolean} 是否发生了迁移
   */
  async migrateLegacyModelName(oldName = 'deepseek-chat', newName = 'deepseek-flash') {
    if (this.get('model') !== oldName) return false
    const apiBase = String(this.get('apiBase') || DEFAULTS.apiBase || '')
    if (!apiBase.includes('api.deepseek.com')) return false
    for (const p of [this._projectPath, this._userPath]) {
      if (!p) continue
      try {
        const disk = JSON.parse(await readFile(p, 'utf8'))
        if (disk && typeof disk === 'object' && disk.model === oldName) {
          disk.model = newName
          // 写前备份原文件（.bak，覆盖旧备份）— 迁移万一有问题可手工恢复
          try { await copyFile(p, p + '.bak') } catch { /* 备份失败不阻断迁移 */ }
          await atomicWriteFile(p, JSON.stringify(disk, null, 2))
          console.log(`🔄 已自动迁移 ${p}: model ${oldName} → ${newName}（deepseek-chat 已由 Flash 接管，原文件备份为 config.json.bak）`)
        }
      } catch { /* 文件不存在或不可写 — 跳过 */ }
    }
    this.set('model', newName)
    return true
  }

  async _load(filePath, level) {
    try {
      const raw = await readFile(filePath, 'utf-8')
      const data = JSON.parse(raw)
      if (level && data && typeof data === 'object' && !Array.isArray(data)) {
        for (const k of Object.keys(data)) this._keySources[k] = level
        this._raw[level] = data // 保留该层原始值（供 getRaw 分层读取）
      }
      this.data = this._deepMerge(this.data, data)
    } catch {
      // 文件不存在或不合法 — 使用默认值
    }
  }

  /**
   * 首次从「无项目配置的目录」启动时，生成一个带 `description` 自说明的配置模板。
   *
   * - 只在**启动**路径调用；运行时 /cd 不调用（关联项目不换角色、也不落文件）。
   * - 文件已存在则**不动**（返回 false）。
   * - 说明文案语言跟随机器级 `language`（含 zh/中文 → 中文，否则英文）。
   * - `description` 是纯文档，加载器忽略；真正生效的是同级的 `identity` / `systemPrompt` 等。
   *
   * @param {string} projectDir
   * @param {{language?: string}} [opts]
   * @returns {Promise<boolean>} 是否新建了文件
   */
  async ensureProjectTemplate(projectDir, { language = '' } = {}) {
    if (!projectDir) return false
    const dir = join(projectDir, '.claude-code')
    const filePath = join(dir, 'config.json')
    try {
      await readFile(filePath, 'utf-8')
      return false // 已存在 → 不动
    } catch { /* 不存在 → 生成 */ }

    const zh = /zh|中文|chinese|\bcn\b/i.test(String(language || ''))
    const template = zh
      ? {
          description: {
            identity: '可选。本目录 AI 扮演的角色与行为准则（自由文本，可多段，用 ## 分节）。留空 = 只用机器级基线（~/.claude-code/config.json 的 identity）。',
            systemPrompt: '可选。填了 = 整体替换内置默认提示词（一般别动）。',
          },
          identity: '',
        }
      : {
          description: {
            identity: 'Optional. The role & behavior rules the AI plays in this directory (free text; may use "## " sections). Empty = use only the machine-level baseline (~/.claude-code/config.json "identity").',
            systemPrompt: 'Optional. If set, fully replaces the built-in default system prompt (usually leave untouched).',
          },
          identity: '',
        }

    try {
      await mkdir(dir, { recursive: true })
      await atomicWriteFile(filePath, JSON.stringify(template, null, 2) + '\n')
      return true
    } catch {
      return false
    }
  }

  /** 保存到项目配置 */
  async saveToProject(projectDir) {
    const dir = join(projectDir, '.claude-code')
    await mkdir(dir, { recursive: true })
    const filePath = join(dir, 'config.json')
    await atomicWriteFile(filePath, JSON.stringify(this.data, null, 2))
  }

  /** 保存到用户配置 */
  async saveToUser() {
    const dir = join(homedir(), '.claude-code')
    await mkdir(dir, { recursive: true })
    await atomicWriteFile(this._userPath, JSON.stringify(this.data, null, 2))
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
    await atomicWriteFile(this._userPath, JSON.stringify(disk, null, 2))
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
