// ============================================================
//  keybindings.js — 逻辑键 → 虚拟动作 的绑定层（零依赖）
// ------------------------------------------------------------
//  把 keymap.js 解析出的「逻辑键」映射到应用层的「虚拟动作」，
//  应用只认动作、不认物理键 —— 于是：
//    · 用户可在 config.json 里重映射（换键/解绑/增绑）
//    · 不同终端各自古怪的序列，统一落到同一个动作
//    · 未来可加屏幕软键：产生同一个动作即可
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
 * 说明（终端事实）：
 *  - Enter(CR) 在**所有修饰组合下终端都发同一个字节**，故 Shift+Enter /
 *    Ctrl+Enter 在协议层无法区分；这里虽列出，但能否触发取决于终端是否
 *    被配置成发送独立序列（可用 /keys 诊断，见 cli.js）。
 *  - 真正跨终端可靠的多行键是 **Alt+Enter**（ESC CR）与 **Ctrl+J**（LF）。
 *  - "f3"（CSI 13~）被部分终端用作 Ctrl/Alt+Enter，沿用旧行为保留。
 */
export const DEFAULT_KEYBINDINGS = {
  // 提交 / 换行
  submit: ['enter'],
  newline: ['ctrl+j', 'alt+enter', 'shift+enter', 'ctrl+enter', 'f3'],

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
  for (const [action, keys] of Object.entries(bindings)) {
    for (const k of keys) if (!specToAction.has(k)) specToAction.set(k, action)
  }

  return {
    bindings,
    /** spec → 动作名（无绑定返回 null） */
    actionFor: (spec) => (spec && specToAction.get(spec)) || null,
    /** 动作 → 键列表 */
    keysFor: (action) => bindings[action] || [],
    /** 全部绑定（调试用） */
    all: () => ({ ...bindings }),
  }
}
