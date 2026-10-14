/**
 * 思考深度（thinking / reasoning depth）适配层 —— 零依赖、纯函数。
 *
 * ## 为什么需要这一层
 *
 * 各家厂商都自称"OpenAI 兼容"，但那只是**请求/响应结构**兼容。
 * 具体到"怎么控制思考深度"，**每家各说各话**（均据各自官方文档核对）：
 *
 *   厂商            参数                                        取值
 *   ──────────────  ──────────────────────────────────────────  ────────────────────────
 *   OpenAI          reasoning_effort（Chat）/ reasoning.effort    none…max（7 档，随模型）
 *   DeepSeek        reasoning_effort + thinking:{type}           low/medium/high
 *   Kimi(Moonshot)  reasoning_effort                             low/high/max（默认 max）
 *   Qwen(百炼)      enable_thinking + thinking_budget            true/false + 数字
 *   Anthropic       output_config.effort                         low/medium/high/max
 *   GLM(Z.AI)       thinking:{type}                              仅开关，无深度档位
 *   OpenRouter      reasoning:{effort|max_tokens, enabled}       归一化层（7 档）
 *
 * 直接照 OpenAI 的样子发 `reasoning_effort` 给所有厂商会**吃 400**（例如给 Kimi 发
 * `medium`、给 DeepSeek 发 `minimal`）。所以必须按 provider 分别构造，并且把档位
 * **裁剪（clamp）到该 provider 真正接受的集合**。
 *
 * ## 三道保险
 *   1. 未识别的 provider → **什么都不发**（保守，宁可用服务端默认）
 *   2. 档位 → 按 provider 允许集合取**最接近**的一档（并列时偏"更深"）
 *   3. query-engine 侧：若带思考参数仍被 400 拒绝 → **剥掉参数重试一次**（见
 *      `_callLLM` 的 strippedThinkingOnce），保证"最多白试一次，绝不因此不可用"
 *
 * 参考文档见仓库本地笔记 THINKING_DEPTH_RESEARCH.md（不入库、不发布）。
 */

/**
 * 完整档位阶梯（由浅到深）。
 * 注意：这是"通用坐标"，各 provider 只接受其中一段子集，用 clampEffort() 裁剪。
 */
export const EFFORT_LADDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** 三种模式：auto = 按提供商默认；off = 明确关闭；on = 明确开启 */
export const THINKING_MODES = ['auto', 'off', 'on']

/** 档位 → 思考 token 预算（仅对按 token 计费的 provider 有意义，如 Qwen 的 thinking_budget） */
export const EFFORT_BUDGET = {
  minimal: 512,
  low: 1024,
  medium: 4096,
  high: 16384,
  xhigh: 32768,
  max: 65536,
}

/**
 * provider 定义表。
 *
 * 字段说明：
 *   label      人类可读名（用于 /thinking 输出）
 *   efforts    该 provider 接受的档位子集（空数组 = 不支持深度控制，只支持开关）
 *   canDisable 是否支持"关闭思考"
 *   autoMode   'off' → auto 模式下等同 off（用于保持历史行为）；缺省 → auto 不干预
 *   on(e,b)    开启时的参数片段；e 可能为 null（provider 不支持档位时）
 *   off()      关闭时的参数片段；null 表示不支持关闭
 */
const PROVIDERS = {
  openai: {
    label: 'OpenAI',
    efforts: EFFORT_LADDER,
    canDisable: true,
    on: (e) => ({ reasoning_effort: e || 'medium' }),
    off: () => ({ reasoning_effort: 'none' }),
  },

  deepseek: {
    label: 'DeepSeek',
    // DeepSeek 官方示例同时下发 reasoning_effort 与 thinking:{type}
    efforts: ['low', 'medium', 'high'],
    canDisable: true,
    on: (e) => ({ reasoning_effort: e || 'medium', thinking: { type: 'enabled' } }),
    off: () => ({ thinking: { type: 'disabled' } }),
    // 保持历史行为：旧版对 deepseek 一律关闭思考（V4 默认开、tool call 场景曾致 400）
    autoMode: 'off',
  },

  kimi: {
    label: 'Kimi (Moonshot)',
    efforts: ['low', 'high', 'max'],
    canDisable: false,
    on: (e) => ({ reasoning_effort: e || 'low' }),
    off: null,
  },

  qwen: {
    label: 'Qwen (DashScope/百炼)',
    // 档位映射为 thinking_budget（Qwen 用 enable_thinking + thinking_budget）
    efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    canDisable: true,
    on: (e, budget) => {
      const out = { enable_thinking: true }
      const b = budget > 0 ? budget : (e ? EFFORT_BUDGET[e] : 0)
      if (b > 0) out.thinking_budget = b
      return out
    },
    off: () => ({ enable_thinking: false }),
  },

  anthropic: {
    label: 'Anthropic (Claude)',
    efforts: ['low', 'medium', 'high', 'max'],
    canDisable: true,
    on: (e) => ({ output_config: { effort: e || 'medium' } }),
    off: () => ({ thinking: { type: 'disabled' } }),
  },

  glm: {
    label: 'GLM (Z.AI)',
    efforts: [], // 只支持开关，无深度档位
    canDisable: true,
    on: () => ({ thinking: { type: 'enabled' } }),
    off: () => ({ thinking: { type: 'disabled' } }),
  },

  openrouter: {
    label: 'OpenRouter（归一化网关）',
    efforts: EFFORT_LADDER,
    canDisable: true,
    on: (e) => ({ reasoning: { effort: e || 'medium' } }),
    off: () => ({ reasoning: { enabled: false } }),
  },

  unknown: {
    label: '未知提供商',
    efforts: [],
    canDisable: false,
    on: null,
    off: null,
  },
}

/**
 * 从 apiBase / model 名推断 provider。
 * 先看 apiBase 域名（更可靠），再看 model 名前缀兜底。
 * @param {{apiBase?:string, model?:string}} o
 * @returns {string} PROVIDERS 的键之一
 */
export function detectProvider({ apiBase = '', model = '' } = {}) {
  const base = String(apiBase).toLowerCase()
  const m = String(model).toLowerCase()

  // 网关优先：OpenRouter 上挂的可能是任何模型，必须按网关自身协议处理
  if (base.includes('openrouter.ai')) return 'openrouter'

  if (base.includes('deepseek') || /^deepseek/.test(m)) return 'deepseek'
  if (base.includes('moonshot') || base.includes('kimi') || /^(kimi|moonshot)/.test(m)) return 'kimi'
  if (base.includes('dashscope') || base.includes('aliyuncs') || /^qwen/.test(m)) return 'qwen'
  if (base.includes('anthropic') || /^claude/.test(m)) return 'anthropic'
  if (base.includes('bigmodel') || base.includes('z.ai') || /^glm/.test(m)) return 'glm'
  if (base.includes('api.openai.com') || /^(gpt-|o[1-9]|chatgpt)/.test(m)) return 'openai'

  return 'unknown'
}

/** 取 provider 定义（含 label 等），未识别则返回 unknown 定义 */
export function getProviderInfo(provider) {
  return PROVIDERS[provider] || PROVIDERS.unknown
}

/**
 * 把请求档位裁剪到 provider 允许的集合。
 * 取阶梯上**距离最近**的一档；距离并列时取**更深**的那一档（思考深度是质量旋钮，
 * 宁可多给一点空间，且 /thinking 会把"请求值 → 实际值"显示出来，不会误导）。
 *
 * @param {string} effort  期望档位（EFFORT_LADDER 之一）
 * @param {string[]} allowed 该 provider 允许的档位
 * @returns {string|null} 实际使用的档位；allowed 为空时返回 null
 */
export function clampEffort(effort, allowed) {
  if (!Array.isArray(allowed) || allowed.length === 0) return null
  if (allowed.includes(effort)) return effort
  const want = EFFORT_LADDER.indexOf(effort)
  if (want < 0) return allowed[0]
  let best = allowed[0]
  let bestD = Infinity
  for (const a of allowed) {
    const ai = EFFORT_LADDER.indexOf(a)
    const d = Math.abs(ai - want)
    if (d < bestD || (d === bestD && ai > EFFORT_LADDER.indexOf(best))) {
      best = a
      bestD = d
    }
  }
  return best
}

/**
 * 构造要合并进请求体的思考参数。
 *
 * @param {object} o
 * @param {string} [o.mode='auto']      auto | off | on
 * @param {string} [o.effort='']        none|minimal|low|medium|high|xhigh|max
 * @param {number} [o.budgetTokens=0]   >0 时优先用 token 预算（Qwen 等）
 * @param {string} [o.apiBase='']
 * @param {string} [o.model='']
 * @returns {{
 *   provider:string, label:string, mode:string, requestedEffort:string,
 *   resolvedEffort:string|null, params:object, note:string|null,
 *   canDisable:boolean, supported:boolean, minOutputTokens:number
 * }}
 */
export function buildThinkingParams({
  mode = 'auto',
  effort = '',
  budgetTokens = 0,
  apiBase = '',
  model = '',
} = {}) {
  const provider = detectProvider({ apiBase, model })
  const def = getProviderInfo(provider)

  const out = {
    provider,
    label: def.label,
    mode: THINKING_MODES.includes(mode) ? mode : 'auto',
    requestedEffort: effort || '',
    resolvedEffort: null,
    params: {},
    note: null,
    canDisable: !!def.canDisable,
    supported: provider !== 'unknown',
    minOutputTokens: 0,
  }

  if (provider === 'unknown') {
    out.note = '未识别的提供商 → 不发送任何思考参数（避免 400，使用服务端默认）'
    return out
  }

  // ---- auto：按提供商默认 ----
  if (out.mode === 'auto') {
    if (def.autoMode === 'off') {
      out.mode = 'off'
      out.note = `auto → ${def.label} 默认关闭思考（兼容历史行为；/thinking on 可开启）`
    } else {
      out.note = `auto → 不干预，使用 ${def.label} 的服务端默认`
      return out
    }
  }

  // ---- off：明确关闭 ----
  if (out.mode === 'off') {
    if (typeof def.off === 'function') {
      out.params = def.off()
      if (!out.note) out.note = `已关闭思考（${def.label}）`
    } else {
      out.note = `${def.label} 不支持关闭思考，已保持服务端默认`
    }
    return out
  }

  // ---- on：明确开启 ----
  const want = EFFORT_LADDER.includes(out.requestedEffort) ? out.requestedEffort : 'medium'
  const resolved = clampEffort(want, def.efforts)
  out.resolvedEffort = resolved

  if (!resolved) {
    // provider 只支持开关（如 GLM）—— 仍然开启，但没有档位
    out.params = typeof def.on === 'function' ? (def.on(null, 0) || {}) : {}
    if (!out.params || Object.keys(out.params).length === 0) {
      out.params = {}
      out.note = `${def.label} 不支持思考控制，未发送参数`
    } else {
      out.note = `${def.label} 只支持开关、不支持深度档位`
    }
    return out
  }

  out.params = def.on(resolved, budgetTokens) || {}
  const clampedNote = resolved !== want ? `（请求 ${want} → 实际 ${resolved}：该模型只接受 ${def.efforts.join('/')}）` : ''
  if (!out.note) out.note = `已开启思考：${resolved}${clampedNote}`

  // Qwen 的 thinking_budget 会计入 max_tokens —— 告诉调用方需要多大的输出余量
  if (out.params.thinking_budget > 0) out.minOutputTokens = out.params.thinking_budget
  return out
}

/**
 * 生成 /thinking 的人类可读说明行（数组）。
 * @param {object} o  buildThinkingParams 的返回 + 当前配置
 */
export function describeThinking(o = {}) {
  const lines = []
  const modeLabel = { auto: 'auto（按提供商默认）', off: 'off（关闭）', on: 'on（开启）' }
  lines.push(`Provider : ${o.label || o.provider} ${o.provider === 'unknown' ? '⚠️ 未识别' : ''}`)
  lines.push(`Mode     : ${modeLabel[o.mode] || o.mode}`)
  lines.push(`Effort   : ${o.requestedEffort || '(未设置，开启时默认 medium)'}${o.resolvedEffort && o.resolvedEffort !== o.requestedEffort ? ` → 实际 ${o.resolvedEffort}` : ''}`)
  const keys = Object.keys(o.params || {})
  lines.push(`Request  : ${keys.length ? JSON.stringify(o.params) : '(不发参数)'}`)
  if (o.note) lines.push(`说明     : ${o.note}`)
  lines.push(`支持关闭 : ${o.canDisable ? '是' : '否'}`)
  return lines
}
