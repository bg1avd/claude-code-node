/**
 * 上下文窗口感知 (Context Window) — 自动探测 + 手动指定
 *
 * 解决的问题：TokenBudget.maxTokens 之前是一个"静态配置"（默认 100 万，
 * CLI 兜底 20 万），并不知道所用模型真实上下文窗口。若预算 > 模型真实窗口，
 * 自动压缩永远不会触发，上下文一路涨到模型报错。
 *
 * 本模块提供三层"窗口来源"，优先级：
 *   1. manual  — 用户通过 /window 手动指定（持久化到 config）
 *   2. probe   — 从 API /models 探测到的窗口（本次进程生效，不落盘）
 *   3. table   — 内置常见模型上下文表（无法探测时的静态兜底）
 *   4. fallback— 安全默认值（如 64K）
 *
 * 探测结果默认不落盘，手动指定才落盘（方案 A）。
 */

// ---- 内置常见模型上下文表（token）----
// 缺失的厂商/模型会回落到 fallback；不精确属预期，可用 /window 手动纠正。
export const MODEL_CONTEXT_TABLE = {
  // DeepSeek
  'deepseek-chat': 128_000,
  'deepseek-reasoner': 128_000,
  'deepseek-coder': 128_000,
  'deepseek-v3': 128_000,
  'deepseek-v2': 128_000,
  'deepseek-v2.5': 128_000,
  'deepseek-v4': 128_000,
  // OpenAI
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'gpt-4-turbo': 128_000,
  'gpt-4': 32_768,
  'gpt-3.5-turbo': 16_384,
  'o1': 200_000,
  'o1-mini': 128_000,
  'o3-mini': 200_000,
  // Anthropic (经兼容网关时)
  'claude-3-5-sonnet': 200_000,
  'claude-3-5-haiku': 200_000,
  'claude-sonnet-4': 200_000,
  'claude-haiku-4': 200_000,
  // Qwen (通义千问)
  'qwen-max': 32_768,
  'qwen-plus': 131_072,
  'qwen-turbo': 1_000_000,
  'qwen2.5-72b-instruct': 131_072,
  'qwen2.5-32b-instruct': 131_072,
  'qwen2.5-7b-instruct': 131_072,
  'qwen2.5-14b-instruct': 131_072,
  'qwen2.5-coder-32b-instruct': 131_072,
  // GLM (智谱)
  'glm-4': 128_000,
  'glm-4-plus': 128_000,
  'glm-4-air': 128_000,
  'glm-4-flash': 128_000,
  'glm-4v': 8_192,
  'glm-4.5': 128_000,
  'glm-4.5-air': 128_000,
  // Moonshot (Kimi)
  'moonshot-v1-8k': 8_192,
  'moonshot-v1-32k': 32_768,
  'moonshot-v1-128k': 131_072,
  'moonshot-v1-auto': 131_072,
  'kimi-k2': 128_000,
  // 本地/开源 (Ollama / vLLM 常见)
  'llama3.1': 131_072,
  'llama3': 8_192,
  'llama2': 4_096,
  'mistral': 32_768,
  'mixtral': 32_768,
  'gemma2': 8_192,
  'codellama': 16_384,
  'qwen2.5': 131_072,
  'yi-34b': 4_096,
}

// 安全兜底默认值 — 探测不到、表里也没有时使用
export const FALLBACK_CONTEXT_WINDOW = 64_000

// ---- 窗口来源标签 ----
export const WINDOW_SOURCE = {
  MANUAL: 'manual',
  PROBE: 'probe',
  TABLE: 'table',
  FALLBACK: 'fallback',
}

const SOURCE_LABEL = {
  [WINDOW_SOURCE.MANUAL]: '手动指定',
  [WINDOW_SOURCE.PROBE]: 'API 探测',
  [WINDOW_SOURCE.TABLE]: '内置模型表',
  [WINDOW_SOURCE.FALLBACK]: '安全兜底',
}

/**
 * 从 /models 响应中尝试提取单个模型的上下文窗口
 *
 * 不同服务字段名不一，尽量覆盖常见命名：
 *   - OpenAI 兼容 vLLM: context_length / max_model_len / max_context_length
 *   - Ollama: (来自 /api/show 的 model_info.llama.context_length)
 *
 * @param {object} modelObj — /models 返回数组中的单个模型对象
 * @returns {number|null} 窗口 token 数；未知返回 null
 */
export function extractContextFromModelObj(modelObj) {
  if (!modelObj || typeof modelObj !== 'object') return null
  const keys = [
    'context_length',
    'context_window',
    'max_context_length',
    'max_model_len',
    'max_sequence_length',
    'model_max_length',
    'n_ctx',
    'contextWindow',
    'contextSize',
    'maxContext',
    'maxTokens',
    'context_tokens',
  ]
  for (const k of keys) {
    const v = modelObj[k]
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v
  }
  // 某些服务把窗口放在 meta / details 子对象
  for (const sub of ['meta', 'details', 'model_info', 'capabilities']) {
    const nested = modelObj[sub]
    if (nested && typeof nested === 'object') {
      const found = extractContextFromModelObj(nested)
      if (found) return found
    }
  }
  // Ollama model_info 专用字段：llama.context_length
  const modelInfo = modelObj.model_info
  if (modelInfo && typeof modelInfo === 'object') {
    const ctxKey = Object.keys(modelInfo).find(k => k.endsWith('.context_length'))
    if (ctxKey && typeof modelInfo[ctxKey] === 'number' && modelInfo[ctxKey] > 0) {
      return modelInfo[ctxKey]
    }
  }
  return null
}

/**
 * 探测当前模型的上下文窗口
 *
 * 顺序：
 *   1. 若已手动指定（manualWindow > 0）→ 直接返回手动值
 *   2. 尝试从 GET {apiBase}/models 的响应中找匹配模型并提取窗口
 *   3. 查内置表
 *   4. 兜底 fallback
 *
 * @param {object} opts
 * @param {string} opts.model — 模型名
 * @param {string} opts.apiBase — API Base URL
 * @param {string} [opts.apiKey]
 * @param {number} [opts.manualWindow] — 用户手动指定的窗口（0 表示未指定）
 * @param {number} [opts.fetchTimeoutMs] — 探测超时（默认 3000ms）
 * @returns {Promise<{window:number, source:string}>}
 */
export async function detectContextWindow({ model, apiBase, apiKey, manualWindow = 0, fetchTimeoutMs = 3000 }) {
  // 1. 手动指定最高优先级
  if (manualWindow > 0) {
    return { window: manualWindow, source: WINDOW_SOURCE.MANUAL }
  }

  // 2. 探测 API
  if (apiBase) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), fetchTimeoutMs)
      const url = apiBase.replace(/\/+$/, '') + '/models'
      const res = await fetch(url, {
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        signal: controller.signal,
      })
      clearTimeout(timer)
      if (res.ok) {
        const data = await res.json()
        const models = data.data || []
        // 优先精确匹配当前 model
        let target = models.find(m => (m.id || '') === model)
        // 其次尝试包含匹配（如 model 是 'qwen2.5' 而列表是 'qwen2.5:14b'）
        if (!target) {
          target = models.find(m => (m.id || '').startsWith(model) || model.startsWith(m.id || ''))
        }
        if (target) {
          const win = extractContextFromModelObj(target)
          if (win) return { window: win, source: WINDOW_SOURCE.PROBE }
        }
      }
    } catch {
      // 探测失败（超时/网络/无权限）→ 继续走表/兜底
    }
  }

  // 3. 内置表
  const normalized = (model || '').toLowerCase()
  if (normalized && MODEL_CONTEXT_TABLE[normalized]) {
    return { window: MODEL_CONTEXT_TABLE[normalized], source: WINDOW_SOURCE.TABLE }
  }
  // 表内做前缀匹配（如 'deepseek-chat:latest'、'qwen2.5-coder:7b'）
  for (const key of Object.keys(MODEL_CONTEXT_TABLE)) {
    if (normalized.startsWith(key) || key.startsWith(normalized)) {
      return { window: MODEL_CONTEXT_TABLE[key], source: WINDOW_SOURCE.TABLE }
    }
  }

  // 4. 兜底
  return { window: FALLBACK_CONTEXT_WINDOW, source: WINDOW_SOURCE.FALLBACK }
}

/**
 * 解析 /window 命令的参数为窗口 token 数
 *
 * 支持：
 *   "131072"  → 131072
 *   "64k"     → 65536
 *   "128k"    → 131072
 *   "200k"    → 204800
 *   "1m"      → 1_000_000
 *
 * @param {string} str
 * @returns {number|null} token 数；非法返回 null
 */
export function parseWindowArg(str) {
  if (typeof str !== 'string') return null
  const s = str.trim().toLowerCase().replace(/,/g, '')
  if (!s) return null
  const m = s.match(/^(\d+)\s*(k|m|kb|mb)?$/)
  if (!m) return null
  const num = parseInt(m[1], 10)
  const unit = m[2]
  if (!Number.isFinite(num) || num <= 0) return null
  if (unit === 'k' || unit === 'kb') return num * 1000
  if (unit === 'm' || unit === 'mb') return num * 1_000_000
  return num
}

/**
 * 将 token 数格式化为人类可读（十进制，与 token 常见记法一致：128K = 128,000）
 * @param {number} tokens
 * @returns {string} 如 "128.0K"、"1.00M"
 */
export function formatTokens(tokens) {
  if (!Number.isFinite(tokens) || tokens <= 0) return '?'
  if (tokens >= 1_000_000) return (tokens / 1_000_000).toFixed(2) + 'M'
  if (tokens >= 1000) return (tokens / 1000).toFixed(1) + 'K'
  return String(tokens)
}

/**
 * 获取窗口来源的中文标签
 * @param {string} source
 * @returns {string}
 */
export function windowSourceLabel(source) {
  return SOURCE_LABEL[source] || source || '未知'
}
