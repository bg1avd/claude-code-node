// ============================================================
//  keybindings.js — 逻辑键 → 虚拟动作 的绑定层（零依赖）
// ------------------------------------------------------------
//  把 keymap.js 解析出的「逻辑键」映射到应用层的「虚拟动作」，
//  应用只认动作、不认物理键 —— 于是：
//    · 用户可在 config.json 里重映射（换键/解绑/增绑）
//    · 不同终端各自古怪的序列，统一落到同一个动作
//    · 屏幕软键 / 键位提示：由 hintFor()/formatKeyLabel() 从**当前绑定**
//      实时生成 → 用户改键，提示自动跟随，无需改 UI 代码
//
//  另外提供 conflicts()：检测「同一键被多个动作绑定」，方便诊断配置错误。
//
//  键规格字符串（spec）：小写，修饰键用 '+' 连接，顺序无所谓：
//    "enter" · "ctrl+c" · "alt+enter" · "shift+enter" · "ctrl+left" · "alt+b"
//
//  配置示例（config.json）：
//    {
//      "keybindings": {
//        "newline": ["shift+enter", "ctrl+j"],   // 数组 = 替换该动作的默认绑定
//        "cursor-word-left": null                 // null / [] = 解绑
//      }
//    }
// ============================================================

const MOD_ORDER = ['ctrl', 'alt', 'shift', 'meta', 'super', 'hyper']

/** 动作 → 人类可读说明（供键位提示行 / 帮助渲染）。 */
export const ACTION_DESCRIPTIONS = {
  submit: '发送',
  newline: '折行',
  'cursor-left': '左移',
  'cursor-right': '右移',
  'cursor-word-left': '左移一词',
  'cursor-word-right': '右移一词',
  'line-start': '行首',
  'line-end': '行尾',
  'delete-back': '退格',
  'delete-forward': '删除',
  'delete-word-back': '删一词',
  'kill-line-end': '删至行尾',
  'kill-line-start': '删至行首',
  'history-prev': '上一条',
  'history-next': '下一条',
  'clear-or-exit': '清空/退出',
}

// 键名 → 显示字形（提示行用）。未收录的按原样输出。
const KEY_GLYPHS = {
  enter: '⏎', tab: '⇥', escape: 'Esc', space: '␣', backspace: '⌫', delete: '⌦',
  up: '↑', down: '↓', left: '←', right: '→', home: '⇱', end: '⇲',
  pageup: '⇞', pagedown: '⇟', insert: 'Ins',
}
const MOD_GLYPHS = { ctrl: '^', alt: '⌥', shift: '⇧', meta: '◆', super: '⌘', hyper: '✦' }

/**
 * 把键规格渲染成紧凑的显示标签（提示行用）。
 *   'ctrl+j' → '^J'   'alt+enter' → '⌥⏎'   'shift+enter' → '⇧⏎'
 *   'ctrl+left' → '^←'   'up' → '↑'
 */
export function formatKeyLabel(spec) {
  const norm = normalizeSpec(spec)
  if (!norm) return ''
  const parts = norm.split('+')
  let modStr = ''
  let keyStr = ''
  for (const p of parts) {
    if (MOD_GLYPHS[p]) { modStr += MOD_GLYPHS[p]; continue }
    if (KEY_GLYPHS[p]) keyStr += KEY_GLYPHS[p]
    else if (p.length === 1) keyStr += (modStr.includes('^') ? p.toUpperCase() : p)
    else keyStr += p
  }
  return modStr + keyStr
}

/** 归一化键规格：'Shift+Enter' → 'shift+enter'；修饰键按固定顺序排列。 */
export function normalizeSpec(spec) {
  if (typeof spec !== 'string') return ''
  const parts = spec.toLowerCase().split('+').map((s) => s.trim()).filter(Boolean)
  const mods = new Set()
  const keys = []
  for (const p of parts) {
    if (MOD_ORDER.includes(p)) mods.add(p)
    else keys.push(p)
  }
  return [...MOD_ORDER.filter((m) => mods.has(m)), ...keys].join('+')
}

/**
 * 默认绑定：虚拟动作 → 键列表。
 *
 * ⚠️ v3.6.9 起语义变更：**Enter = 折行，不再用于发送**。
 *   发送改用**显式外部键 Ctrl+S**（softkey 行会显示它）。
 *   目的：终端无法区分 Shift+Enter，干脆反过来 —— 高频的「换行」用 Enter，
 *   低频且需要确认的「发送」用独立键，避免误发。
 *   想恢复「Enter 发送」：config.json 里
 *     { "keybindings": { "submit": ["enter"], "newline": ["ctrl+j","alt+enter"] } }
 *
 * 说明（终端事实）：
 *  - Enter(CR) 在**所有修饰组合下终端都发同一个字节**，故 Shift+Enter /
 *    Ctrl+Enter 在协议层无法区分；这里虽列出，但能否触发取决于终端是否
 *    被配置成发送独立序列（可用 /keys 诊断，见 cli.js）。
 *  - 真正跨终端可靠的多行键是 **Ctrl+J**（LF）与 **Alt+Enter**（ESC CR）。
 */
export const DEFAULT_KEYBINDINGS = {
  // 提交 / 换行
  submit: ['ctrl+s'],
  newline: ['enter', 'ctrl+j', 'alt+enter', 'shift+enter', 'ctrl+enter', 'f3'],

  // 光标移动
  'cursor-left': ['left'],
  'cursor-right': ['right'],
  'cursor-word-left': ['ctrl+left', 'alt+left', 'alt+b'],
  'cursor-word-right': ['ctrl+right', 'alt+right', 'alt+f'],
  'line-start': ['home', 'ctrl+a'],
  'line-end': ['end', 'ctrl+e'],

  // 删除 / 剪切
  'delete-back': ['backspace'],
  'delete-forward': ['delete', 'ctrl+d'],
  'delete-word-back': ['ctrl+w', 'alt+backspace'],
  'kill-line-end': ['ctrl+k'],
  'kill-line-start': ['ctrl+u'],

  // 历史
  'history-prev': ['up'],
  'history-next': ['down'],

  // 清空 / 退出
  'clear-or-exit': ['ctrl+c'],
}

/**
 * 创建绑定解析器。
 * @param {object} userConfig config.json 的 keybindings 段（可空）
 */
export function createKeybindings(userConfig = {}) {
  const cfg = (userConfig && typeof userConfig === 'object') ? userConfig : {}
  const bindings = {}

  const toList = (v) => {
    if (v == null) return []
    return (Array.isArray(v) ? v : [v]).map(normalizeSpec).filter(Boolean)
  }

  // 默认表 + 用户覆盖
  for (const action of Object.keys(DEFAULT_KEYBINDINGS)) {
    bindings[action] = Object.prototype.hasOwnProperty.call(cfg, action)
      ? toList(cfg[action])
      : DEFAULT_KEYBINDINGS[action].map(normalizeSpec)
  }
  // 用户新增的动作
  for (const action of Object.keys(cfg)) {
    if (bindings[action] !== undefined) continue
    bindings[action] = toList(cfg[action])
  }

  // 反向索引：spec → action（先注册者优先，避免用户新增动作覆盖默认动作）
  const specToAction = new Map()
  const specToActions = new Map()   // spec → [actions]（用于冲突检测）
  for (const [action, keys] of Object.entries(bindings)) {
    for (const k of keys) {
      if (!specToAction.has(k)) specToAction.set(k, action)
      const list = specToActions.get(k)
      if (list) list.push(action)
      else specToActions.set(k, [action])
    }
  }

  /** 冲突检测：同一个键被多个动作绑定（返回 [{spec, actions}]）。 */
  function conflicts() {
    const out = []
    for (const [spec, actions] of specToActions) {
      if (actions.length > 1) out.push({ spec, actions: [...actions] })
    }
    return out
  }

  /**
   * 某动作的键位提示。
   *   hintFor('newline')                      → '⏎/^J/⌥⏎ 折行'（全部键）
   *   hintFor('newline', { all: false })      → '⏎ 折行'（只显示主键，适合软键行）
   *   hintFor('newline', false)               → '⏎/^J/⌥⏎'（不带说明，兼容旧签名）
   * 无绑定返回 ''。
   */
  function hintFor(action, opts = {}) {
    const keys = bindings[action] || []
    if (keys.length === 0) return ''
    const withDesc = (typeof opts === 'boolean') ? opts : (opts.description !== false)
    const all = (typeof opts === 'object' && opts && opts.all === false) ? false : true
    const list = all ? keys : keys.slice(0, 1)
    const labels = list.map(formatKeyLabel).join('/')
    const desc = ACTION_DESCRIPTIONS[action]
    return (withDesc && desc) ? `${labels} ${desc}` : labels
  }

  return {
    bindings,
    /** spec → 动作名（无绑定返回 null） */
    actionFor: (spec) => (spec && specToAction.get(spec)) || null,
    /** 动作 → 键列表 */
    keysFor: (action) => bindings[action] || [],
    /** 动作 → 键位提示文本（提示行 / 帮助用；opts.all=false 只取主键） */
    hintFor,
    /** 冲突检测 */
    conflicts,
    /** 全部绑定（调试用） */
    all: () => ({ ...bindings }),
  }
}
