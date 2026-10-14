/**
 * /status 的唯一实现 —— 汇总"当前所有运行状态"。
 *
 * 为什么单独成模块：同一个 /status 有两个入口（REPL 与 Telegram），
 * 各自拼字符串必然会漂移（实测：Telegram 的 /status 只报版本/uptime/PID，
 * 连 model / apiBase 都没有）。这里做成**单一数据源**，两个入口共用。
 *
 * 设计要点（对应"状态要报全"的诉求）：
 *   · **凡是被命令/配置改过的参数都要报**，并标注来源（用户级/项目级/CLI），
 *     这样"我到底改过什么、现在是哪套参数"一眼可见
 *   · 分组呈现：进程 → 模型接口 → 思考深度 → 上下文 → 工具循环 → 会话 → 终端 → 通道 → 费用
 *   · 纯文本输出（Telegram 侧会走富消息渲染，无需 Markdown 表格对齐）
 */
import { formatTokens, windowSourceLabel } from './context-window.js'
import { buildThinkingParams, describeThinking } from './thinking-adapter.js'

/** 已知默认值（用于标注"已改"）。与 config.js DEFAULTS 中对外可调的键保持同步。 */
const KNOWN_DEFAULTS = {
  model: 'deepseek-flash',
  apiBase: 'https://api.deepseek.com/v1',
  maxTurns: 0,
  maxBudgetTokens: 1_000_000,
  permissionMode: 'ask',
  autoCompact: true,
  autoContinue: true,
  maxMessages: 0,
  maxOutputTokens: 0,
  language: '',
  softkeys: true,
}

/**
 * 标注某个值的"来源/是否被改过"。
 * @param {object} config      Config 实例（可选；提供则能报"来自哪个配置文件"）
 * @param {string} key         配置键（顶层键）
 * @param {*} value            当前生效值
 * @returns {string} 形如 "  [用户级配置]" / "  [已改]";空串表示默认
 */
function mark(config, key, value) {
  const src = config?.keySource ? config.keySource(key) : null
  const srcLabel = src === 'user' ? '用户级配置' : src === 'project' ? '项目级配置' : null
  const def = KNOWN_DEFAULTS[key]
  const changed = key in KNOWN_DEFAULTS && value !== undefined && JSON.stringify(value) !== JSON.stringify(def)
  if (srcLabel && changed) return `  [已改 · ${srcLabel}]`
  if (srcLabel) return `  [${srcLabel}]`
  if (changed) return '  [已改]'
  return ''
}

/** 脱敏 API Key：只留首4末4 */
function maskKey(k) {
  if (!k) return '(未设置)'
  const s = String(k)
  return s.length <= 10 ? '****' : `${s.slice(0, 4)}…${s.slice(-4)}`
}

/** 秒 → 1d 2h 3m 4s */
function humanUptime(sec) {
  const s = Math.max(0, Math.floor(sec || 0))
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60), ss = s % 60
  const parts = []
  if (d) parts.push(`${d}d`)
  if (h) parts.push(`${h}h`)
  if (m) parts.push(`${m}m`)
  parts.push(`${ss}s`)
  return parts.join(' ')
}

/**
 * 构造状态报告。
 *
 * @param {object} o
 * @param {object} o.engine        QueryEngine（必需）
 * @param {object} [o.session]     当前会话 {id,title,messages}
 * @param {object} [o.config]      Config 实例（用于标注来源）
 * @param {string} [o.version]     cc-node 版本
 * @param {number} [o.windowSource] detectContextWindow 返回的 source
 * @param {string} [o.cwd]
 * @param {object} [o.channels]    通道配置 {telegram:{...}}
 * @param {string} [o.defaultChannel]
 * @param {number} [o.pid]
 * @param {number} [o.uptimeSec]
 * @param {string[]} [o.extra]     额外要追加的行（调用方自定义，如 Telegram 侧补"cc-node 运行中"）
 * @returns {string} 多行纯文本
 */
export function buildStatus({
  engine,
  session = null,
  config = null,
  version = '',
  windowSource = null,
  cwd = '',
  channels = null,
  defaultChannel = null,
  pid = process.pid,
  uptimeSec = process.uptime(),
  extra = [],
} = {}) {
  const cfg = engine?.config || {}
  const L = []

  // ---------- 进程 ----------
  L.push('【进程】')
  L.push(`  版本      : v${version || '?'}${'  '}PID ${pid}`)
  L.push(`  已运行    : ${humanUptime(uptimeSec)}`)
  if (cwd) L.push(`  工作目录  : ${cwd}`)
  L.push(`  Node      : ${process.version}  ${process.platform}/${process.arch}`)

  // ---------- 模型与接口 ----------
  L.push('')
  L.push('【模型 / 接口】')
  L.push(`  模型      : ${cfg.model || '(未设置)'}${mark(config, 'model', cfg.model)}`)
  L.push(`  API Base  : ${cfg.apiBase || '(未设置)'}${mark(config, 'apiBase', cfg.apiBase)}`)
  L.push(`  API Key   : ${maskKey(cfg.apiKey)}`)
  L.push(`  流式      : ${cfg.noStream ? '关闭 (--no-stream)' : '开启'}`)
  L.push(`  权限模式  : ${cfg.permissionMode || 'ask'}${mark(config, 'permissionMode', cfg.permissionMode)}`)
  if (cfg.smallModel) L.push('  小模型模式: 开启 (每轮清空 LLM 端缓存)')

  // ---------- 思考深度 ----------
  if (engine) {
    const t = cfg.thinking || { mode: 'auto', effort: '', budgetTokens: 0 }
    const cfgMode = t.mode || 'auto'
    const info = buildThinkingParams({
      mode: t.mode, effort: t.effort, budgetTokens: t.budgetTokens,
      apiBase: cfg.apiBase, model: cfg.model,
    })
    L.push('')
    L.push('【思考深度】')
    const modeLabel = { auto: 'auto（按提供商默认）', off: 'off（关闭）', on: 'on（开启）' }
    // ⚠️ 不能只看 keySource：/thinking 是**运行时**改 config 并持久化的，
    //    而 keySource 只在启动加载配置时记录 → 运行中改过的值必须靠"与默认值比较"来标。
    const tChanged = (cfgMode !== 'auto') || !!t.effort || (t.budgetTokens > 0)
    const tSrc = config?.keySource?.('thinking')
    const tMark = tChanged ? `  [已改${tSrc ? ` · ${tSrc === 'user' ? '用户级配置' : '项目级配置'}` : ''}]` : ''
    // auto 被解析成具体模式（如 DeepSeek 默认 off）时，显示 "auto → off"，避免"我设了 auto 怎么变 off"的困惑
    const effLabel = modeLabel[info.mode] || info.mode
    const modeDisplay = (cfgMode === 'auto' && info.mode !== 'auto') ? `auto → ${effLabel}` : effLabel
    L.push(`  模式      : ${modeDisplay}${tMark}`)
    L.push(`  深度      : ${info.requestedEffort || '(未设置)'}${info.resolvedEffort && info.resolvedEffort !== info.requestedEffort ? ` → 实际 ${info.resolvedEffort}` : ''}`)
    L.push(`  提供商    : ${info.label}${info.supported ? '' : ' ⚠️ 未识别'}`)
    const keys = Object.keys(info.params || {})
    L.push(`  实发参数  : ${keys.length ? JSON.stringify(info.params) : '(不发参数)'}`)
    if (info.note) L.push(`  说明      : ${info.note}`)
  }

  // ---------- 上下文 ----------
  if (engine?.tokenBudget) {
    const tb = engine.tokenBudget
    const win = tb.maxTokens || 0
    const used = engine.state?.messages ? tb.estimateMessages(engine.state.messages) : 0
    const pct = win > 0 ? Math.min(100, Math.round((used / win) * 100)) : 0
    const reserved = Math.max(tb.reservedForOutput || 0, engine._computeMaxOutputTokens?.() || 0)
    L.push('')
    L.push('【上下文】')
    L.push(`  窗口      : ${formatTokens(win)}${windowSource != null ? ` (${windowSourceLabel(windowSource)})` : ''}${mark(config, 'maxBudgetTokens', config?.get?.('maxBudgetTokens'))}`)
    L.push(`  已用      : ${used.toLocaleString()} tokens (${pct}% of window)`)
    if (reserved > 0) L.push(`  输出预留  : ${reserved.toLocaleString()}`)
    L.push(`  压缩触发  : ${cfg.autoCompact === false ? '已关闭 (autoCompact=false)' : `${Math.round(win * (cfg.compressSafetyFactor ?? 0.85)).toLocaleString()} (${Math.round((cfg.compressSafetyFactor ?? 0.85) * 100)}%)`}`)
    L.push(`  自动压缩  : ${cfg.autoCompact === false ? '关闭' : '开启'}${mark(config, 'autoCompact', cfg.autoCompact)}`)
    if (cfg.maxMessages > 0) L.push(`  条数折叠  : 超过 ${cfg.maxMessages} 条时折叠${mark(config, 'maxMessages', cfg.maxMessages)}`)
    if (cfg.maxOutputTokens > 0) L.push(`  输出上限  : ${formatTokens(cfg.maxOutputTokens)} (手动指定)${mark(config, 'maxOutputTokens', cfg.maxOutputTokens)}`)
  }

  // ---------- 工具循环 ----------
  if (engine) {
    const mt = cfg.maxTurns
    const unlimited = !(typeof mt === 'number' && mt > 0)
    L.push('')
    L.push('【工具循环】')
    L.push(`  轮数上限  : ${unlimited ? '0（不限制）' : mt}${mark(config, 'maxTurns', mt)}`)
    if (!unlimited && engine._wrapUpAt) L.push(`  收尾引导  : 第 ${engine._wrapUpAt() + 1} 轮起`)
    L.push('  止损      : 无进展检测（连续 3 轮重复同调用 → 提醒；5 轮 → 停止）+ /stop')

    // ---------- 会话 ----------
    L.push('')
    L.push('【会话】')
    if (session?.id) {
      L.push(`  会话 ID   : ${session.id}`)
      if (session.title) L.push(`  标题      : ${session.title}`)
      L.push(`  消息数    : ${session.messages?.length || 0}`)
    }
    L.push(`  本轮/累计 : turnCount ${engine.state?.turnCount ?? 0}`)
    L.push(`  自动续接  : ${cfg.autoContinue === false ? '关闭' : '开启（启动时接着上次会话）'}${mark(config, 'autoContinue', cfg.autoContinue)}`)
    if (config?.get?.('sessionsDir')) L.push(`  会话目录  : ${config.get('sessionsDir')}`)
  }

  // ---------- 终端 / 键位 ----------
  const kb = cfg.keybindings
  const kbCount = kb && typeof kb === 'object' ? Object.keys(kb).length : 0
  L.push('')
  L.push('【终端 / 键位】')
  L.push(`  软键行    : ${cfg.softkeys === false ? '关闭' : Array.isArray(cfg.softkeys) ? `自定义 ${cfg.softkeys.length} 项` : '开启'}${mark(config, 'softkeys', cfg.softkeys)}`)
  L.push(`  键位覆盖  : ${kbCount > 0 ? `${kbCount} 项（config.keybindings）` : '无（全部默认：⏎ 折行 / ^S 发送）'}`)
  if (cfg.language) L.push(`  语言      : ${cfg.language}${mark(config, 'language', cfg.language)}`)

  // ---------- 通道 ----------
  if (channels) {
    const names = Object.keys(channels)
    L.push('')
    L.push('【通道】')
    L.push(`  已配置    : ${names.length ? names.join(', ') : '(无)'}`)
    if (defaultChannel) L.push(`  默认      : ${defaultChannel}`)
  }

  // ---------- 费用 ----------
  const ct = engine?.costTracker
  if (ct) {
    const cost = ct.getTotalCost?.()
    L.push('')
    L.push('【费用（本次会话累计）】')
    L.push(`  API 调用  : ${ct.totalApiCalls} 次`)
    L.push(`  Token     : 输入 ${ct.totalInputTokens.toLocaleString()} / 输出 ${ct.totalOutputTokens.toLocaleString()}` +
      (ct.totalReasoningTokens ? `（其中思考 ${ct.totalReasoningTokens.toLocaleString()}）` : ''))
    if (cost) L.push(`  估算费用  : $${(cost.total ?? 0).toFixed(4)}`)
  }

  if (extra.length) {
    L.push('')
    for (const line of extra) L.push(line)
  }

  return L.join('\n')
}

/**
 * 单行版（用于不适合多行的场合，如 Telegram 的 /version）。
 * @returns {string}
 */
export function buildStatusSummary({ engine, version } = {}) {
  const cfg = engine?.config || {}
  const t = cfg.thinking || {}
  const mt = cfg.maxTurns
  return `cc-node v${version} · 模型 ${cfg.model || '?'} · 思考 ${t.mode || 'auto'}${t.effort ? '/' + t.effort : ''} · 轮数上限 ${mt > 0 ? mt : '不限'}`
}
