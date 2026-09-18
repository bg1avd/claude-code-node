/**
 * 梦境 (Dream) — 跨会话长期记忆 + LLM 方向分类摘要
 *
 * 背景：cc-node 是"用户只在需要编程时才打开"的 CLI 助手。每次关闭后，
 * 本次会话的记忆就丢失了；下次打开又要从零开始，用户得复述"上次做到哪了"。
 *
 * 本模块把"梦境"定义为【由打开/关闭驱动的入睡-醒来循环】：
 *   - 入睡 (sleep)：用户在退出（/exit）时，把本次会话沉淀成一条"梦境记录"
 *     （dream-*.json）存到 .claude-code/dreams/，永不覆盖，形成梦境流水账。
 *   - 醒来 (wake) ：下次打开 cc-node 时，读入最近 N 条梦境，把其中的
 *     next_steps / decisions / directions 作为系统上下文注入首轮对话。
 *
 * 【LLM 增强（方向分类摘要）】
 * 当用户在 config 的 `dream.summarizer` 配了【本地小模型】时（独立于主模型）：
 *   - 入睡时调用本地模型，把本次会话整理成【按方向分类】的总结摘要
 *     （directions: [{name, summary, key_decisions, next_steps}]），
 *     方向 = 技术栈 / 任务主题 / 模块。
 *   - 这不占用用户的付费/云端主模型 token —— 用本地免费小模型做。
 *   - 工作时可按方向检索（wakeByDirection），让 AI 先查到该方向的历史工作情况。
 * 未配置本地摘要模型时，自动降级为【纯本地启发式】（零 LLM 依赖，离线可用）。
 *
 * 因为用户"只在需要时打开"，每次关闭是天然入睡、每次打开是天然醒来，
 * 梦境由这个节律驱动，不需要常驻后台守护进程 —— 契合本软件的使用场景。
 */

import { readFile, writeFile, mkdir, readdir, rm } from 'fs/promises'
import { resolve, join } from 'path'
import { randomBytes } from 'crypto'
import { isLocalLlmServer, buildAuthHeaders } from '../utils/index.js'

const DEFAULT_DREAMS_DIR = '.claude-code/dreams'

// 敏感信息模式：用于入睡时对梦境文本字段脱敏，防止把密钥/Token 写进长期记忆。
// 以 [source, flags] 形式存储，sanitizeSecrets 每次 new RegExp 重建，
// 避免共享带 g 标志的正则对象的 lastIndex 跨调用残留导致漏匹配。
const SECRET_PATTERNS = [
  // 常见 API Key / Token 前缀
  ['\\b(sk-[A-Za-z0-9_-]{8,})\\b', 'g'],
  ['\\b(ghp_[A-Za-z0-9]{20,})\\b', 'g'],
  ['\\b(github_pat_[A-Za-z0-9_]{20,})\\b', 'g'],
  ['\\b(npm_[A-Za-z0-9]{20,})\\b', 'g'],
  ['\\b(xox[baprs]-[A-Za-z0-9-]{10,})\\b', 'g'],            // Slack token
  ['\\b(AKIA[A-Z0-9]{16})\\b', 'g'],                          // AWS access key
  ['\\b(Bearer\\s+[A-Za-z0-9._-]{12,})\\b', 'gi'],             // Authorization: Bearer xxx
  ['\\b(Authorization:\\s*Bearer\\s+[A-Za-z0-9._-]{12,})\\b', 'gi'],
  // 通用 token / 密码赋值（避免误伤普通词，要求含 = 或明确赋值语义）
  ['(\\b(?:api[_-]?key|token|secret|password|passwd|apikey|auth)\\b\\s*[=:]\\s*[\'"]?[A-Za-z0-9._\\-/+]{8,})', 'gi'],
  // 私钥
  ['-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\\s\\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----', 'g'],
]

// 脱敏替换：保留前缀首字符 + 长度提示，隐藏主体
function maskSecret(match, ..._groups) {
  const token = match.replace(/\s+/g, ' ')
  const prefix = token.slice(0, 6)
  return `${prefix}***[redacted:${token.length}]`
}

/**
 * 对梦境文本字段做敏感信息脱敏。
 * 返回脱敏后的新字符串；非字符串原样返回。
 */
export function sanitizeSecrets(text) {
  if (typeof text !== 'string') return text
  let out = text
  for (const [source, flags] of SECRET_PATTERNS) {
    out = out.replace(new RegExp(source, flags), maskSecret)
  }
  return out
}


// 结论性关键词：用于挑选 Key results / Decisions 里有价值的内容（避开过渡话术）
const CONCLUSION_HINTS = [
  '关键', '发现', '错误', '原因', '结论', '问题', '修复',
  '成功', '失败', '是因为', '在于', '导致', '需要', '找到', '定位到',
  '决定', '采用', '选择', '方案', '接口', '函数', '配置', '依赖',
  '下一步', '待办', 'TODO', '还未', '未完成', '继续',
]

/** 压缩连续重复字符（"xxx...xxx" → "x"），用于意图归一化去重 */
function squashRepeats(str) {
  let out = ''
  let last = ''
  for (const ch of str) {
    if (ch !== last) { out += ch; last = ch }
  }
  return out
}

/** 判断一条文本是否"有实质内容"（去填充后仍有信息量） */
function hasSubstance(content) {
  if (!content) return false
  const squashed = squashRepeats(String(content))
  const meaningful = squashed.replace(/\s+/g, '')
  return meaningful.length >= 6
}

/** 判断一条文本是否像"结论/决策/待办"（含关键词） */
function isConclusionLike(text) {
  const s = String(text)
  return CONCLUSION_HINTS.some(k => s.includes(k))
}

// 工具调用里可能携带文件路径的参数名
const FILE_PATH_KEYS = ['file_path', 'path', 'file', 'filepath', 'repo', 'root', 'cwd']
// 常见代码/配置文件扩展名
const FILE_EXT_RE = /\.(?:[jt]sx?|ts|py|json|yml|yaml|toml|ini|md|css|scss|html|go|rs|java|c|cpp|h|rb|php|sh|bash|sql|env|lock|vue|svelte)$/i

/**
 * 从一条消息里提取涉及的文件路径（工作现场快照素材）。
 * 来源：toolCalls 的 input 参数 + tool 结果/assistant 文本里的路径。
 * @param {object} msg — 消息
 * @param {Map<string, number>} fileMap — 累积文件→出现次数（就地更新）
 */
function extractFilesFromMsg(msg, fileMap) {
  // 1. 从 toolCalls 的 input 里提取
  if (msg.toolCalls) {
    for (const tc of msg.toolCalls) {
      const input = tc.input
      if (input && typeof input === 'object') {
        for (const key of FILE_PATH_KEYS) {
          const v = input[key]
          if (typeof v === 'string' && v) {
            const cleaned = v.split(/[\s#:]+/)[0] // 去掉可能的行号/参数
            if (cleaned.length >= 2) fileMap.set(cleaned, (fileMap.get(cleaned) || 0) + 1)
          }
        }
        // Bash 命令里也可能含路径（如 `cd src/foo`、`node server.js`），保守提取
        if (input.command && typeof input.command === 'string') {
          const cmds = input.command.match(/\b[\w./~-]+\.(?:[jt]sx?|js|ts|py|json|md|css|go|rs|c|cpp|h|sh|bash|yaml|yml|toml|ini|html)\b/gi)
          if (cmds) {
            for (const c of cmds) {
              if (!/\.(?:com|net|org|io|js\.map)/i.test(c)) fileMap.set(c, (fileMap.get(c) || 0) + 1)
            }
          }
        }
      }
    }
  }
  // 2. assistant 文本里的文件路径（如"写入 src/foo.js"）
  if (msg.role === 'assistant' && typeof msg.content === 'string') {
    const paths = msg.content.match(/\b[\w./~-]+\.(?:[jt]sx?|js|ts|py|json|md|css|go|rs|c|cpp|h|sh|bash|yaml|yml|toml|ini|html)\b/gi)
    if (paths) {
      for (const p of paths) {
        if (!/\.(?:com|net|org|io|js\.map)/i.test(p)) fileMap.set(p, (fileMap.get(p) || 0) + 1)
      }
    }
  }
}

/**
 * 从消息列表中提取"工作现场快照"：涉及的核心文件 + 最后动作。
 * @param {Array} messages — 会话消息
 * @returns {{ files: Array<{path:string,count:number}> }} 现场快照
 */
export function extractWorkspace(messages = []) {
  const fileMap = new Map()
  for (const msg of messages) extractFilesFromMsg(msg, fileMap)
  // 按出现次数降序，取前 12 个核心文件
  const files = [...fileMap.entries()]
    .map(([path, count]) => ({ path, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12)
  return { files }
}

/**
 * 从消息列表提炼梦境内容（纯本地启发式）
 *
 * @param {Array} messages — 会话消息（role/content/toolCalls）
 * @returns {object} 梦境结构化内容
 */
export function dreamFromMessages(messages = []) {
  const topics = []          // 用户意图（保留顺序）
  const seenIntents = new Set()
  const toolsUsed = new Set()
  const keyResults = []      // 有实质内容的结果
  const pending = []         // 疑似"未完成/下一步"内容
  let firstIntent = ''

  for (const msg of messages) {
    if (msg.role === 'user' && msg.content) {
      const intent = typeof msg.content === 'string'
        ? msg.content.split('\n')[0].slice(0, 100)
        : ''
      if (intent) {
        if (!firstIntent) firstIntent = intent
        const norm = squashRepeats(intent.replace(/\d+/g, 'N'))
        if (!seenIntents.has(norm)) {
          seenIntents.add(norm)
          topics.push(intent)
        }
      }
    }

    if (msg.role === 'assistant') {
      // 工具使用
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) toolsUsed.add(tc.name)
      }
      // 关键文本结果
      if (typeof msg.content === 'string' && hasSubstance(msg.content)) {
        const chunk = msg.content.slice(0, 400)
        keyResults.push(chunk)
        // 疑似"下一步/未完成"的表述
        if (/下一步|接下来|待办|TODO|还未|未完成|应该|需要.*继续|可以.*考虑/.test(chunk)) {
          pending.push(chunk.slice(0, 200))
        }
      }
    }

    if (msg.role === 'tool' && msg.content) {
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
      if (hasSubstance(content)) {
        keyResults.push(`[tool result]: ${content.slice(0, 160)}`)
      }
    }
  }

  // ---- 组装梦境内容 ----
  const goal = firstIntent

  // 关键结果：优先取【最早结论】+【最新结果】（首尾各一）
  let keyResultText = ''
  if (keyResults.length > 0) {
    const firstC = keyResults.find(k => isConclusionLike(k)) || keyResults[0]
    const last = keyResults[keyResults.length - 1]
    const pick = firstC === last ? [firstC] : [firstC, last]
    keyResultText = pick.map(k => `- ${k.trim()}`).join('\n')
  }

  // 待办/下一步：优先取带"未完成/下一步"标记的，否则取最后几条有结论的内容
  let nextStepsText = ''
  const pendingDedup = [...new Set(pending)]
  if (pendingDedup.length > 0) {
    nextStepsText = pendingDedup.slice(0, 5).map(t => `- ${t.trim()}`).join('\n')
  } else {
    const concluding = keyResults.filter(k => isConclusionLike(k)).slice(-3)
    if (concluding.length > 0) {
      nextStepsText = concluding.map(t => `- ${t.trim()}`).join('\n')
    }
  }

  // 决策/约定：带"决定/采用/方案/接口"的结论性内容
  const decisionHints = ['决定', '采用', '选择', '方案', '接口', '约定', '规范', '配置为']
  const decisions = [...new Set(
    keyResults.filter(k => decisionHints.some(h => k.includes(h)))
  )].slice(0, 5)

  return {
    main_goal: goal,
    key_results: keyResultText,
    next_steps: nextStepsText,
    has_unfinished: nextStepsText.length > 0 || pendingDedup.length > 0,
    decisions: decisions.map(d => d.trim()).slice(0, 5),
    tools_used: [...toolsUsed],
    topics: topics.slice(0, 10),
    workspace: extractWorkspace(messages),  // 工作现场快照（方案2）
  }
}

/**
 * 把梦境内容渲染成注入系统上下文的文本
 * @param {object} dream — dreamFromMessages 的结果
 * @returns {string}
 */
export function renderDreamContext(dream) {
  if (!dream) return ''
  const parts = []
  // LLM 方向分类摘要优先（若有），它是更精炼、更贴合"按方向记忆"的形态
  if (Array.isArray(dream.directions) && dream.directions.length > 0) {
    for (const dir of dream.directions) {
      const dirParts = []
      dirParts.push(`▸ ${dir.name || '方向'}`)
      if (dir.summary) dirParts.push(`  · 进展：${dir.summary}`)
      if (dir.key_decisions) dirParts.push(`  · 决策：${dir.key_decisions}`)
      if (dir.next_steps) dirParts.push(`  · 待办：${dir.next_steps}`)
      parts.push(dirParts.join('\n'))
    }
  } else {
    if (dream.main_goal) parts.push(`[未完成的主线任务]\n${dream.main_goal}`)
    if (dream.next_steps) parts.push(`[上次未完成的下一步]\n${dream.next_steps}`)
    if (dream.decisions?.length) parts.push(`[关键决策与约定]\n${dream.decisions.map(d => `- ${d}`).join('\n')}`)
    if (dream.key_results) parts.push(`[关键结果]\n${dream.key_results}`)
  }

  // 方案 3 — 续作指令：未完成任务 + 现场文件 → 明确的下一步动作，让第二天能无缝继续。
  const resume = renderResumeInstruction(dream)
  if (resume) parts.push(resume)

  return parts.join('\n\n')
}

/**
 * 生成"续作指令"（方案3）：把梦境里未完成的方向 + 涉及的文件，转成可执行的下一步。
 * 让 AI 醒来时知道"该打开哪个文件继续做哪件事"，而非只拿到一段摘要。
 * @param {object} dream — 梦境记录
 * @returns {string} 续作指令文本；无需续作时返回 ''
 */
export function renderResumeInstruction(dream) {
  if (!dream || !dream.has_unfinished) return ''
  const files = dream.workspace?.files?.map(f => f.path) || []
  const goal = dream.main_goal || dream.directions?.[0]?.name || ''
  // 清洗下一步文本：去 `- ` 前缀、去重复的"下一步"措辞、取第一条
  const rawSteps = dream.next_steps || dream.directions?.map(d => d.next_steps).filter(Boolean)[0] || ''
  const steps = String(rawSteps)
    .split('\n')
    .map(s => s.trim().replace(/^[-•]\s*/, ''))
    .filter(Boolean)
    .map(s => s.replace(/^(下一步|接下来|然后)[:：]?\s*/, ''))
    .join(' → ') || ''
  const parts = []
  parts.push('[续作指令 — 请优先继续以下未完成工作]')
  if (goal) parts.push(`任务：${goal}`)
  if (steps) parts.push(`下一步：${steps}`)
  if (files.length > 0) parts.push(`涉及文件：${files.slice(0, 6).join('、')}`)
  if (files.length > 0) parts.push(`提示：请先读取上述涉及的文件，接续未完成的部分。`)
  return parts.join('\n')
}


// ============================================================
// LLM 方向分类摘要
// ============================================================

/**
 * 用 LLM 把会话消息整理成【按方向分类】的总结。
 * 通过 OpenAI 兼容 /chat/completions 调用模型做摘要。
 *
 * 模型选择（优先级，由调用方决定传入哪个 summarizer）：
 *   - 专用本地小模型（dream.summarizer，默认首选）
 *   - 主模型（正常退出时用正在用的 AI 做总结）
 *
 * 成本控制（v2 调优）：
 *   - **输入精简**：先用启发式（dreamFromMessages）提炼出主线/关键结果/下一步
 *     作为骨架喂给 LLM，只附加有限的原始 user 意图，避免把全部过程噪音塞进
 *     请求（省 token、降低模型"迷失"概率）。
 *   - **隐私**：专用摘要模型默认只允许本地/内网地址；主模型（allowRemote=true）
 *     是用户显式授权"用当前 AI 做总结"，故放行云端。
 *
 * @param {Array} messages — 会话消息
 * @param {object} summarizer — { apiBase, model, apiKey }
 * @param {object} [opts] — { timeoutMs, verbose, allowRemote }
 * @returns {Promise<object|null>} { directions, summary }；失败返回 null（降级本地）
 */
export async function llmSummarizeDirections(messages, summarizer, opts = {}) {
  const timeoutMs = opts.timeoutMs || 120_000
  const verbose = opts.verbose || false
  const allowRemote = opts.allowRemote || false
  const apiBase = summarizer?.apiBase
  const model = summarizer?.model
  if (!apiBase || !model) return null

  // 隐私保护：专用摘要模型必须是本地/内网；主模型（allowRemote=true）显式放行
  if (!allowRemote && !isLocalLlmServer(apiBase)) {
    if (verbose) console.error(`💭 梦境摘要模型 ${apiBase} 非本地服务，为保护对话隐私已跳过 LLM 摘要，改用本地规则。`)
    return null
  }

  // 输入精简：用启发式提炼骨架，减少喂给 LLM 的噪音
  const skeleton = dreamFromMessages(messages)
  const userIntents = (skeleton.topics || []).slice(0, 6).join('\n')
  const keyResults = (skeleton.key_results || '').slice(0, 1500)
  const nextSteps = (skeleton.next_steps || '').slice(0, 800)
  const files = (skeleton.workspace?.files || []).slice(0, 8).map(f => f.path).join(', ')
  const raw = [
    `【用户意图】\n${userIntents || '(无)'}`,
    `【关键结果】\n${keyResults || '(无)'}`,
    `【疑似下一步】\n${nextSteps || '(无)'}`,
    `【涉及文件】\n${files || '(无)'}`,
  ].join('\n\n').slice(0, 8000)
  if (!raw.trim()) return null

  const sys = `你是一个项目记忆整理助手。请把下面这段编程会话的【结构化摘要】，整理成"按方向分类"的总结摘要。
方向（direction）指：技术栈、任务主题、模块、领域等主题类别。通常 1-3 个方向即可。
每个方向的 next_steps 必须是【明确、可执行的下一步动作】（如"打开 src/http.js 补全 retry 函数"），而不是泛泛的"继续优化"。
输出严格 JSON，不要任何多余文字：
{"directions":[{"name":"方向名","summary":"这个方向做了什么、进展如何","key_decisions":"关键决策/约定（无则空字符串）","next_steps":"明确的下一个可执行步骤"}],"overall":"整段会话的一句话总览"}`

  const body = {
    model,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: raw },
    ],
    max_tokens: 1024,
    temperature: 0.2,
    stream: false,
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const url = apiBase.replace(/\/+$/, '') + '/chat/completions'
    const headers = { 'Content-Type': 'application/json', ...(buildAuthHeaders(apiBase, summarizer.apiKey) || {}) }
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!res.ok) {
      if (verbose) console.error(`💭 梦境摘要模型返回 ${res.status}，降级本地规则。`)
      return null
    }
    const data = await res.json()
    const text = data?.choices?.[0]?.message?.content || ''
    const json = extractJson(text)
    if (!json) {
      if (verbose) console.error('💭 梦境摘要模型未返回合法 JSON，降级本地规则。')
      return null
    }
    // 容错：归一化 directions 结构
    const normalized = normalizeDirections(json, skeleton)
    if (verbose) console.error(`💭 已用模型生成方向分类梦境摘要（${normalized.directions?.length || 0} 个方向）。`)
    return normalized
  } catch (err) {
    if (verbose) console.error(`💭 梦境摘要调用失败（${err.name === 'AbortError' ? '超时' : err.message}），降级本地规则。`)
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 归一化 LLM 返回的 directions：清理空值、缺失字段，必要时用启发式兜底。
 * @param {object} json — LLM 返回的 { directions, overall }
 * @param {object} skeleton — dreamFromMessages 的启发式结果（兜底用）
 * @returns {object} 归一化后的 { directions, overall }
 */
function normalizeDirections(json, skeleton) {
  const overall = typeof json.overall === 'string' ? json.overall : ''
  const dirs = Array.isArray(json.directions) ? json.directions : []
  // 过滤非法方向，补齐缺失字段
  const clean = dirs
    .filter(d => d && typeof d === 'object' && (d.name || d.summary))
    .map(d => ({
      name: typeof d.name === 'string' && d.name.trim() ? d.name.trim() : (skeleton.main_goal || 'general'),
      summary: typeof d.summary === 'string' ? d.summary : '',
      key_decisions: typeof d.key_decisions === 'string' ? d.key_decisions : '',
      next_steps: typeof d.next_steps === 'string' ? d.next_steps : '',
    }))
  // 若 LLM 没给出任何有效方向，用启发式兜底一个
  if (clean.length === 0 && skeleton.main_goal) {
    clean.push({
      name: skeleton.main_goal,
      summary: skeleton.key_results,
      key_decisions: skeleton.decisions.join('；'),
      next_steps: skeleton.next_steps,
    })
  }
  return { directions: clean, overall }
}

/** 从 LLM 文本中提取首个 JSON 对象（容错 markdown 代码块 / 前后杂音） */
function extractJson(text) {
  if (!text) return null
  // 去掉 markdown ```json ``` 包裹
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fenced ? fenced[1] : text
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  try {
    const obj = JSON.parse(candidate.slice(start, end + 1))
    // 只要是有 directions 或 overall 的 JSON 都接受（缺失字段交给 normalizeDirections 兜底）
    if (obj && typeof obj === 'object' && ('directions' in obj || 'overall' in obj)) return obj
    return null
  } catch {
    return null
  }
}

// ============================================================
// DreamManager
// ============================================================

/**
 * DreamManager — 管理梦境记录的存储 + LLM 摘要 + 方向检索
 */
export class DreamManager {
  constructor(options = {}) {
    this.dreamsDir = options.dreamsDir || resolve(process.cwd(), DEFAULT_DREAMS_DIR)
    this.maxRetain = options.maxRetain || 50 // 最多保留多少条梦境文件（防无限膨胀）
    this.summarizer = options.summarizer || null // 专用本地摘要模型 { apiBase, model, apiKey, timeoutMs }
    this.mainSummarizer = options.mainSummarizer || null // 主模型（正常退出时用当前 AI 做总结）
    this.minLLMMessages = options.minLLMMessages || 8 // 会话达到此消息数才调用模型摘要
    this.verbose = options.verbose || false
  }

  /** 确保梦境目录存在（权限 0700，与 session 一致） */
  async ensureDir() {
    await mkdir(this.dreamsDir, { recursive: true, mode: 0o700 })
  }

  /**
   * 入睡 — 把会话沉淀为一条梦境记录
   *
   * @param {Array} messages — 会话消息
   * @param {object} meta — 附加信息（title, project, turnCount 等）
   * @param {object} opts — { minMessages, minTurns, useLLM } 有效入睡门槛 / 是否用 LLM
   * @returns {Promise<object|null>} 梦境记录；若未达门槛返回 null
   */
  async sleep(messages = [], meta = {}, opts = {}) {
    const minMessages = opts.minMessages ?? 3
    const minLLMMessages = opts.minLLMMessages ?? this.minLLMMessages ?? 8
    // 摘要来源优先级（方案1）：专用本地摘要模型 → 主模型 → 纯本地规则。
    // mainSummarizer 可从 opts 动态传入（正常退出时用当前 AI），也可构造时配置。
    const mainSummarizer = opts.mainSummarizer || this.mainSummarizer
    const hasAnyLlm = !!this.summarizer || !!mainSummarizer

    // 有效入睡门槛：消息太少或没实质内容就不存，避免垃圾梦境
    if (messages.length < minMessages) return null

    const content = dreamFromMessages(messages)
    if (!content.main_goal && !content.key_results) return null

    const dream = {
      id: `dream-${Date.now()}-${randomBytes(4).toString('hex')}`,
      created: new Date().toISOString(),
      project: meta.project || '',
      source_title: meta.title || '',
      turn_count: meta.turnCount || 0,
      ...content,
    }

    // 模型摘要：仅当配置了任一模型 且 会话规模达到 minLLMMessages 才调用。
    // 优先级：专用本地模型 → 主模型。失败自动降级，不影响入睡。
    if (hasAnyLlm && messages.length >= minLLMMessages) {
      const summarized = await this._summarizeWithModel(messages, meta, content, mainSummarizer)
      if (summarized) {
        dream.summary = summarized.summary
        dream.directions = summarized.directions
      } else {
        // 模型摘要失败 → 本地规则方向（含现场快照）
        dream.directions = [this._fallbackDirection(meta, content)]
      }
    } else if (hasAnyLlm) {
      // 小会话：不调模型，直接本地规则方向（省成本）
      dream.directions = [this._fallbackDirection(meta, content)]
    }

    // 安全：对梦境所有文本字段做敏感信息脱敏（API key/token/密码/私钥等）
    this._sanitizeDream(dream)
    // 安全边界：限制字段长度
    this._truncateDream(dream)

    await this.ensureDir()

    // 去重合并：若已有同方向的旧梦境，合并而非新增，避免记忆冗余。
    if (opts.merge !== false) {
      const existing = await this._findMergeTarget(dream)
      if (existing) {
        await this._mergeDreams(existing, dream, meta)
        return existing
      }
    }

    const filePath = join(this.dreamsDir, `${dream.id}.json`)
    await writeFile(filePath, JSON.stringify(dream, null, 2), { encoding: 'utf-8', mode: 0o600 })

    // 归档：超出 maxRetain 时删除最旧的梦境
    await this._prune()
    return dream
  }

  /**
   * 找与传入梦境【同方向】的已有梦境（用于合并）。
   * 方向相似判定：任一新方向名 与 任一旧方向名 高度相似。
   * @param {object} dream — 新入睡的梦境
   * @returns {Promise<object|null>} 匹配到的旧梦境，无则 null
   */
  async _findMergeTarget(dream) {
    const newDirs = (dream.directions || []).map(d => d?.name || '').filter(Boolean)
    const newNames = new Set([...(dream.main_goal ? [dream.main_goal] : []), ...newDirs])
    if (newNames.size === 0) return null

    const all = await this.list()
    for (const old of all) {
      if (old.id === dream.id) continue
      const oldDirs = (old.directions || []).map(d => d?.name || '').filter(Boolean)
      const oldNames = new Set([...(old.main_goal ? [old.main_goal] : []), ...oldDirs])
      for (const a of newNames) {
        for (const b of oldNames) {
          if (this._directionSimilarity(a, b)) return old
        }
      }
    }
    return null
  }

  /**
   * 判断两个方向名是否高度相似（可合并）。
   * 规则：归一化后精确相等，或一个包含另一个（且较长一方 ≥ 较短一方 + 2 字符）。
   * 保守：避免把 "http" 和 "https" 或不同主题误合并。
   */
  _directionSimilarity(a, b) {
    if (!a || !b) return false
    const na = a.trim().toLowerCase().replace(/[，,。\s]+/g, '')
    const nb = b.trim().toLowerCase().replace(/[，,。\s]+/g, '')
    if (!na || !nb) return false
    if (na === nb) return true
    // 包含关系（较长一方明显包含较短一方）
    const [longer, shorter] = na.length >= nb.length ? [na, nb] : [nb, na]
    // 短词过短（<3）不合并，防止 "http" 误合并 "http客户端" 以外的东西
    if (shorter.length < 3) return false
    return longer.includes(shorter)
  }

  /**
   * 把新梦境合并进旧梦境（更新旧文件），返回合并后的记录。
   * 合并规则（去重、保留演进）：
   *   - created 更新为最新；保留 original_created 记录首次时间
   *   - next_steps 用最新的（新梦境优先）
   *   - key_results / decisions / topics 合并去重（保留顺序，先旧后新）
   *   - 工具并集；has_unfinished 取或；turn_count 累加
   */
  async _mergeDreams(existing, incoming, meta) {
    const originalCreated = existing.original_created || existing.created
    // 合并 directions：按方向名去重，同名方向取较新的 summary/next_steps
    const dirMap = new Map()
    for (const d of existing.directions || []) {
      const key = (d.name || '').toLowerCase()
      if (key && !dirMap.has(key)) dirMap.set(key, d)
    }
    for (const d of incoming.directions || []) {
      const key = (d.name || '').toLowerCase()
      if (key) {
        if (dirMap.has(key)) {
          // 同名方向：合并 next_steps（新的优先），保留/合并 summary
          const cur = dirMap.get(key)
          cur.summary = d.summary || cur.summary
          if (d.next_steps) cur.next_steps = d.next_steps  // 最新进展
          if (d.key_decisions && !cur.key_decisions.includes(d.key_decisions)) {
            cur.key_decisions = [cur.key_decisions, d.key_decisions].filter(Boolean).join('；')
          }
        } else {
          dirMap.set(key, d)
        }
      }
    }

    const mergeLines = (oldStr, newStr) => {
      const lines = new Set()
      for (const l of String(oldStr || '').split('\n').map(s => s.trim()).filter(Boolean)) lines.add(l)
      for (const l of String(newStr || '').split('\n').map(s => s.trim()).filter(Boolean)) lines.add(l)
      return [...lines].join('\n')
    }
    const mergeArr = (oldArr, newArr) => {
      const set = new Set([...(oldArr || []).filter(Boolean), ...(newArr || []).filter(Boolean)])
      return [...set]
    }

    existing.original_created = originalCreated
    existing.created = incoming.created
    existing.turn_count = (existing.turn_count || 0) + (incoming.turn_count || 0)
    existing.updated = new Date().toISOString()
    existing.directions = [...dirMap.values()]
    existing.key_results = mergeLines(existing.key_results, incoming.key_results)
    existing.next_steps = incoming.next_steps || existing.next_steps  // 最新进展
    existing.decisions = mergeArr(existing.decisions, incoming.decisions)
    existing.topics = mergeArr(existing.topics, incoming.topics)
    existing.tools_used = mergeArr(existing.tools_used, incoming.tools_used)
    existing.has_unfinished = (existing.has_unfinished || incoming.has_unfinished) || false
    existing.merge_count = (existing.merge_count || 1) + 1
    // 合并工作现场快照：文件路径并集（按总出现次数排序）
    const fileMap = new Map()
    for (const f of existing.workspace?.files || []) fileMap.set(f.path, (fileMap.get(f.path) || 0) + f.count)
    for (const f of incoming.workspace?.files || []) fileMap.set(f.path, (fileMap.get(f.path) || 0) + f.count)
    existing.workspace = {
      files: [...fileMap.entries()]
        .map(([path, count]) => ({ path, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 12),
    }
    // 记录合并过的源标题（含旧梦境自身原有的 source_title）
    const srcTitles = new Set(existing.source_titles || [])
    if (existing.source_title) srcTitles.add(existing.source_title)
    if (meta?.title) srcTitles.add(meta.title)
    existing.source_titles = [...srcTitles]
    existing.source_title = meta?.title || existing.source_title

    // 安全边界：合并后再做一次脱敏（纵深防御）+ 限制字段长度
    this._sanitizeDream(existing)
    this._truncateDream(existing)

    const filePath = join(this.dreamsDir, `${existing.id}.json`)
    await writeFile(filePath, JSON.stringify(existing, null, 2), { encoding: 'utf-8', mode: 0o600 })
    return existing
  }

  /**
   * 限制单条梦境字段长度，防止合并过多后单文件膨胀。
   * 就地修改 dream；超长字段截断并在末尾加省略标记。
   */
  _truncateDream(dream, opts = {}) {
    const limit = {
      main_goal: opts.mainGoal || 200,
      key_results: opts.keyResults || 4000,
      next_steps: opts.nextSteps || 2000,
      summary: opts.summary || 500,
      dir_name: opts.dirName || 80,
      dir_text: opts.dirText || 1000,
      arr: opts.arr || 20,
    }
    const clip = (s, n) => {
      if (typeof s !== 'string' || s.length <= n) return s
      return s.slice(0, n) + '…[truncated]'
    }
    if (dream) {
      dream.main_goal = clip(dream.main_goal, limit.main_goal)
      dream.key_results = clip(dream.key_results, limit.key_results)
      dream.next_steps = clip(dream.next_steps, limit.next_steps)
      dream.summary = clip(dream.summary, limit.summary)
      if (Array.isArray(dream.decisions) && dream.decisions.length > limit.arr) dream.decisions = dream.decisions.slice(0, limit.arr)
      if (Array.isArray(dream.topics) && dream.topics.length > limit.arr) dream.topics = dream.topics.slice(0, limit.arr)
      if (Array.isArray(dream.directions)) {
        for (const dir of dream.directions) {
          dir.name = clip(dir.name, limit.dir_name)
          dir.summary = clip(dir.summary, limit.dir_text)
          dir.key_decisions = clip(dir.key_decisions, limit.dir_text)
          dir.next_steps = clip(dir.next_steps, limit.dir_text)
        }
      }
    }
    return dream
  }

  /** 降级：把启发式的下一步/决策包装成单一方向 */
  _fallbackDirection(meta, content) {
    return {
      name: meta.project || meta.title || content.main_goal || 'general',
      summary: content.key_results,
      key_decisions: content.decisions.join('；'),
      next_steps: content.next_steps,
    }
  }

  /**
   * 用模型生成方向分类摘要（方案1核心）。
   * 模型优先级：专用本地摘要模型 → 主模型（正常退出时用当前 AI）。
   * 任一模型调用成功即返回 { summary, directions }；全部失败返回 null（由调用方降级本地规则）。
   *
   * @param {Array} messages — 会话消息
   * @param {object} meta — 元信息
   * @param {object} content — dreamFromMessages 启发式结果
   * @param {object} [mainSummarizer] — 主模型（可从调用方动态传入）
   * @returns {Promise<{summary:string, directions:Array}|null>}
   */
  async _summarizeWithModel(messages, meta, content, mainSummarizer = null) {
    // 候选模型序列：专用本地 → 主模型
    const candidates = []
    if (this.summarizer) candidates.push({ summarizer: this.summarizer, allowRemote: false })
    const ms = mainSummarizer || this.mainSummarizer
    if (ms) candidates.push({ summarizer: ms, allowRemote: true })

    for (const { summarizer, allowRemote } of candidates) {
      const llm = await llmSummarizeDirections(messages, summarizer, {
        verbose: this.verbose,
        timeoutMs: summarizer?.timeoutMs,
        allowRemote,
      })
      if (llm) {
        return {
          summary: llm.overall || '',
          directions: Array.isArray(llm.directions) ? llm.directions : [],
        }
      }
    }
    return null
  }

  /** 对梦境记录的所有文本字段做敏感信息脱敏（就地修改） */
  _sanitizeDream(dream) {
    const scrub = (v) => sanitizeSecrets(v)
    if (dream) {
      dream.main_goal = scrub(dream.main_goal)
      dream.key_results = scrub(dream.key_results)
      dream.next_steps = scrub(dream.next_steps)
      dream.summary = scrub(dream.summary)
      dream.source_title = scrub(dream.source_title)
      dream.project = scrub(dream.project)
      if (Array.isArray(dream.decisions)) dream.decisions = dream.decisions.map(scrub)
      if (Array.isArray(dream.topics)) dream.topics = dream.topics.map(scrub)
      if (Array.isArray(dream.source_titles)) dream.source_titles = dream.source_titles.map(scrub)
      if (Array.isArray(dream.directions)) {
        for (const dir of dream.directions) {
          dir.name = scrub(dir.name)
          dir.summary = scrub(dir.summary)
          dir.key_decisions = scrub(dir.key_decisions)
          dir.next_steps = scrub(dir.next_steps)
        }
      }
    }
    return dream
  }

  /** 归档最旧的梦境文件，直到数量 ≤ maxRetain */
  async _prune() {
    try {
      const files = (await readdir(this.dreamsDir)).filter(f => f.startsWith('dream-') && f.endsWith('.json'))
      if (files.length <= this.maxRetain) return
      const sorted = files.sort()
      const toRemove = sorted.slice(0, sorted.length - this.maxRetain)
      for (const f of toRemove) {
        await rm(join(this.dreamsDir, f), { force: true })
      }
    } catch { /* 归档失败不致命 */ }
  }

  /**
   * 列出梦境（按创建时间倒序，最新在前）
   * @returns {Promise<Array>}
   */
  async list() {
    await this.ensureDir()
    const files = (await readdir(this.dreamsDir)).filter(f => f.startsWith('dream-') && f.endsWith('.json'))
    const dreams = []
    for (const f of files) {
      try {
        const data = await readFile(join(this.dreamsDir, f), 'utf-8')
        dreams.push(JSON.parse(data))
      } catch { /* skip corrupted */ }
    }
    dreams.sort((a, b) => new Date(b.created) - new Date(a.created))
    return dreams
  }

  /**
   * 醒来 — 读最近 N 条梦境，渲染成注入系统上下文的记忆文本
   *
   * @param {number} recent — 取最近几条（默认 3）
   * @returns {Promise<string|null>} 记忆文本；无梦境时返回 null
   */
  async wake(recent = 3) {
    const dreams = await this.list()
    if (dreams.length === 0) return null
    // 记忆保鲜度：不只取最近 N 条，而是按"重要度"选取——
    //   未完成任务优先 + 持续关注（合并次数多）加权 + 最近更新（时间分）
    const picked = dreams
      .map((d, i) => ({ d, score: this._importanceScore(d, i, dreams.length) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, recent)
      .map(x => x.d)

    const blocks = picked.map((d, i) => {
      const flag = d.has_unfinished ? ' ⏳' : ''
      const merged = d.merge_count > 1 ? ` (持续关注×${d.merge_count})` : ''
      const header = `■ 记忆 ${i + 1} · ${(d.created || '').slice(0, 10)}${d.project ? ` · ${d.project}` : ''}${flag}${merged}`
      const body = renderDreamContext(d)
      return `${header}\n${body}`
    })

    return `[来自过往会话的记忆（"梦境"）— 供你快速接续之前的未完成工作]\n\n${blocks.join('\n\n')}`
  }

  /**
   * 记忆保鲜度打分：决定醒来时优先注入哪些梦境。
   * @param {object} d — 梦境记录
   * @param {number} index — 在时间倒序列表中的位置（0 最新）
   * @param {number} total — 梦境总数
   * @returns {number} 重要度分数（越高越优先）
   */
  _importanceScore(d, index, total) {
    let score = 0
    // 1. 未完成任务：最该被想起，重奖
    if (d.has_unfinished) score += 6
    // 2. 持续关注：合并次数多说明跨多次会话在推进，重要
    if (d.merge_count > 1) score += Math.min(d.merge_count, 5)
    // 3. 最近更新：保证近期工作不会完全被挤出（时间倒序 index 0 最新）
    //    时间分随位置线性衰减，最新 index=0 给满 3 分
    const recency = Math.max(0, 3 - (index / Math.max(total, 1)) * 3)
    score += recency
    // 4. 规模信号：turn_count 大说明投入多
    if (d.turn_count >= 5) score += 1
    return score
  }

  /**
   * 按方向检索梦境 — 工作时先查该方向的历史工作情况。
   *
   * 原理：把梦境记录里的 directions（LLM 分类）或 main_goal/topics（启发式）
   * 与查询词做【加权关键词匹配】打分，返回相关度最高的梦境上下文。
   *
   * 检索质量设计（v2 调优）：
   *   - **分段加权**：方向名(name)命中 > 待办/决策 > 正文/主题。方向名是 LLM 给的
   *     精炼标签，命中它最说明"就是这个方向"。
   *   - **多词加权**：查询可能含多个关键词（如 "http 客户端 重试"），每个词单独计分，
   *     全词命中得分更高；同时整串命中给额外加成。
   *   - **避免误命中**：短查询（<3 字符）只允许在方向名/高权字段命中，防止正文里的
   *     无关短词污染结果。
   *
   * @param {string} query — 方向/主题关键词（如 "http 客户端"、"schema 校验"）
   * @param {object} [opts] — { limit } 最多返回几条（默认 3）
   * @returns {Promise<string|null>} 检索到的记忆文本；无匹配返回 null
   */
  async wakeByDirection(query, opts = {}) {
    const limit = opts.limit || 3
    if (!query || !query.trim()) return this.wake(limit)
    const dreams = await this.list()
    if (dreams.length === 0) return null

    const qRaw = query.trim()
    const q = qRaw.toLowerCase()
    // 拆分查询词：兼容中文连写 + 空格/英文分隔。中文整串保留，英文按空白/标点拆。
    const cnTerms = q.match(/[\u4e00-\u9fa5]{1,}/g) || []
    const enTerms = q.split(/[^a-z0-9]+/i).filter(t => t.length > 1)
    const terms = [...new Set([...cnTerms, ...enTerms])]

    const scored = dreams.map(d => {
      // 分段构建可检索文本，并给不同字段不同权重
      const fields = []
      let nameHit = 0
      if (Array.isArray(d.directions)) {
        for (const dir of d.directions) {
          fields.push([`${dir.name || ''}`, 4])                    // 方向名：权重最高
          fields.push([`${dir.summary || ''} ${dir.key_decisions || ''} ${dir.next_steps || ''}`, 2])
          if (dir.name && q.includes(dir.name.toLowerCase())) nameHit += 3
        }
      }
      fields.push([`${d.main_goal || ''}`, 3])
      fields.push([`${d.next_steps || ''} ${d.decisions?.join(' ') || ''}`, 2])
      fields.push([`${d.key_results || ''} ${d.topics?.join(' ') || ''} ${d.project || ''} ${d.source_title || ''}`, 1])

      let score = 0
      for (const [text, weight] of fields) {
        const lower = text.toLowerCase()
        if (!lower) continue
        // 整串命中（高权字段给加成）
        if (lower.includes(q)) score += weight * 2
        // 逐词命中
        for (const term of terms) {
          if (!term) continue
          if (lower.includes(term)) score += weight
        }
      }
      // 短查询保护：若查询是单个短英文词且没命中方向名/主线，压低分数防误命中
      if (terms.length === 1 && terms[0].length < 3 && nameHit === 0) {
        score = Math.floor(score / 2)
      }
      score += nameHit
      return { d, score }
    }).filter(s => s.score > 0).sort((a, b) => b.score - a.score)

    if (scored.length === 0) return null

    const blocks = scored.slice(0, limit).map(({ d }, i) => {
      const header = `■ 相关记忆 ${i + 1} · ${(d.created || '').slice(0, 10)}${d.project ? ` · ${d.project}` : ''}`
      const body = renderDreamContext(d)
      return `${header}\n${body}`
    })

    return `[按方向"${query}"检索到的过往会话记忆（"梦境"）— 供你接续该方向的工作]\n\n${blocks.join('\n\n')}`
  }

  /** 清空所有梦境 */
  async clear() {
    const files = (await readdir(this.dreamsDir)).filter(f => f.startsWith('dream-') && f.endsWith('.json'))
    for (const f of files) {
      await rm(join(this.dreamsDir, f), { force: true })
    }
    return files.length
  }
}
