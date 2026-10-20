/**
 * 权限模式 — 对外**只认三个值**：`all` / `ask` / `deny`
 *
 * 设计原则（用户可见的词 = 配置里能写的词，不允许让人猜）：
 *   - CLI 提示里写着  `a = 本会话全部允许`、`/allow all`
 *   - 那么配置里就必须能写 `"permissionMode": "all"`
 *   - 不再出现 `always-allow` 这种"另一个名字"（它只作为**旧配置兼容别名**保留，
 *     且会明确提示"已按 all 处理"，而不是静默接受）
 *
 * 合法值：
 *   all  — 自动允许所有工具调用（仍受安全策略约束：命令黑名单、路径/SSRF 检查）
 *   ask  — 每次工具调用需确认（默认）
 *   deny — 拒绝所有工具调用
 *
 * 非法值（含历史拼写 allow / auto / true）→ 回退 ask，并由调用方打印告警，
 * 绝不静默降级（v3.6.21 修复：此前 `all` 会被静默当成 ask，用户以为已开启）。
 */

/** 对外合法值（顺序即提示顺序） */
export const PERMISSION_MODES = ['all', 'ask', 'deny']

/** 供错误提示使用的说明 */
export const PERMISSION_MODES_HELP = 'all | ask | deny'

/**
 * 别名表 — 仅含**历史遗留**的写法。
 * `always-allow` 是 3.6.20 及以前文档/代码里的内部名，必须兼容，否则老配置升级后失效。
 * 其他拼写（allow / auto / true / none …）**故意不认**：认了就等于鼓励猜。
 */
const LEGACY_ALIASES = new Map([
  ['always-allow', 'all'],
])

/** 归一化结果缓存（配置在启动时只读一次，量小但避免重复解析） */
const _cache = new Map()

/**
 * 把配置里的值归一化成合法模式。
 *
 * @param {*} value 配置值 / CLI 值
 * @returns {{
 *   mode: 'all'|'ask'|'deny',  // 实际生效的模式
 *   provided: string|null,     // 用户提供的原始值（已 trim+小写）；未提供为 null
 *   valid: boolean,            // 是否为合法值（或其兼容别名）
 *   legacy: boolean,           // 是否走了兼容别名（调用方应提示"已按 X 处理"）
 *   reason?: string            // 非法原因（valid=false 时）
 * }}
 */
export function normalizePermissionMode(value) {
  if (value === undefined || value === null || value === '') {
    return { mode: 'ask', provided: null, valid: true, legacy: false }
  }

  const raw = String(value).trim().toLowerCase()
  if (_cache.has(raw)) return _cache.get(raw)

  let result
  if (PERMISSION_MODES.includes(raw)) {
    result = { mode: raw, provided: raw, valid: true, legacy: false }
  } else if (LEGACY_ALIASES.has(raw)) {
    result = {
      mode: LEGACY_ALIASES.get(raw),
      provided: raw,
      valid: true,
      legacy: true,
      reason: `"${raw}" 是旧写法，已按 "${LEGACY_ALIASES.get(raw)}" 处理`,
    }
  } else {
    result = {
      mode: 'ask',
      provided: raw,
      valid: false,
      legacy: false,
      reason: `不认识的权限模式 "${raw}"`,
    }
  }

  _cache.set(raw, result)
  return result
}

/**
 * 生成给用户看的一行告警（无需告警时返回 null）。
 * @param {{valid:boolean, legacy:boolean, provided:string|null, mode:string, reason?:string}} info
 * @returns {string|null}
 */
export function permissionModeWarning(info) {
  if (!info) return null
  if (!info.valid) {
    return `⚠️  permissionMode=${JSON.stringify(info.provided)} 无效（${info.reason}），已回退为 "ask"。合法值：${PERMISSION_MODES_HELP}`
  }
  if (info.legacy) {
    return `ℹ️  permissionMode=${JSON.stringify(info.provided)} —— ${info.reason}（建议改成 "${info.mode}"）`
  }
  return null
}
