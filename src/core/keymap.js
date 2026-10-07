// ============================================================
//  keymap.js — 终端按键序列解析（零依赖 · 自研）
// ------------------------------------------------------------
//  用「一张表 + 有状态解析器」把 stdin 的字符流解析成逻辑键事件，
//  取代 Node 内置 readline 的 emitKeypressEvents。理由：
//    · Node 的序列表与 **Node 版本绑定**（如 \x1b[200~ → paste-start 在
//      Node <18.19 / <20.8 不存在），自研后一份表管所有版本/终端。
//    · Node 不认识 Kitty CSI-u、xterm modifyOtherKeys、SGR 鼠标（实测）。
//
//  事件模型：
//    { type:'key',  name, ctrl, alt, shift, meta }   逻辑键
//    { type:'char', text }                           可打印字符（含多字节）
//    { type:'paste-start' } / { type:'paste-end' }   括号粘贴边界
//    { type:'mouse', raw }                           SGR 鼠标（预留）
//    { type:'unknown', raw }                         未识别 → 不污染输入
//
//  命名约定（面向 keybindings 的“键规格”字符串）：
//    Enter 键(CR)      → name:'enter'        （spec: "enter"）
//    Ctrl+J(LF)        → name:'j', ctrl      （spec: "ctrl+j"）
//    Ctrl+字母         → name:'a'..'z', ctrl （spec: "ctrl+a"）
//    Alt+字母          → name:'b', alt       （spec: "alt+b"）
//    方向/编辑键       → 'left'/'up'/'home'/'delete'…
//    可打印字符        → { type:'char' }
//
//  用法：
//    const p = createKeyParser()
//    input.on('data', c => { for (const ev of p.feed(decoder.write(c))) handle(ev) })
//    // 数据静默一小段时间后，冲刷残留（孤立 ESC / 半截序列）：
//    if (p.pending()) setTimeout(() => { for (const ev of p.flush()) handle(ev) }, 10)
//
//  注意：解析器**有状态**，必须跨 feed 复用（序列可跨数据块）。
//        ESC 单独出现时挂起，待后续字符补齐为 Alt+X（与 Node 行为一致）；
//        若一直没有后续字符，调用方应用 flush() 把孤立 ESC 当作 escape 键。
// ============================================================

const ESC = '\x1b'
const MAX_SEQ = 64          // 未终结的 CSI/OSC 缓冲上限，超过则按未知丢弃

// ---- 表 ----
const CSI_LETTER_NAMES = {
  A: 'up', B: 'down', C: 'right', D: 'left', E: 'clear',
  F: 'end', H: 'home', P: 'f1', Q: 'f2', R: 'f3', S: 'f4',
}
const CSI_TILDE_NAMES = {
  1: 'home', 2: 'insert', 3: 'delete', 4: 'end', 5: 'pageup', 6: 'pagedown',
  7: 'home', 8: 'end',
  11: 'f1', 12: 'f2', 13: 'f3', 14: 'f4', 15: 'f5',
  17: 'f6', 18: 'f7', 19: 'f8', 20: 'f9', 21: 'f10',
  23: 'f11', 24: 'f12', 29: 'menu',
}
const SS3_NAMES = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end', P: 'f1', Q: 'f2', R: 'f3', S: 'f4' }

// 修饰键位（Kitty 规范）：值 = 1 + bitfield
//   shift=1 alt=2 ctrl=4 super=8 hyper=16 meta=32
function decodeModifierValue(m) {
  const v = (parseInt(m, 10) || 1) - 1
  if (!v) return {}
  return {
    shift: !!(v & 1), alt: !!(v & 2), ctrl: !!(v & 4),
    super: !!(v & 8), hyper: !!(v & 16), meta: !!(v & 32),
  }
}

// 由 Unicode 码点（Kitty CSI-u / modifyOtherKeys 用）得到逻辑键
function keyFromCode(code, mods = {}) {
  if (!Number.isFinite(code)) return { type: 'unknown', raw: '' }
  if (code === 13) return { type: 'key', name: 'enter', ...mods }
  if (code === 10) return { type: 'key', name: 'j', ctrl: true, ...mods }
  if (code === 9) return { type: 'key', name: 'tab', ...mods }
  if (code === 27) return { type: 'key', name: 'escape', ...mods }
  if (code === 8 || code === 127) return { type: 'key', name: 'backspace', ...mods }
  if (code === 32) return { type: 'key', name: 'space', ...mods }
  if (code < 32) return { type: 'key', name: String.fromCharCode(96 + code), ctrl: true, ...mods }
  const ch = String.fromCodePoint(code)
  if (mods.ctrl || mods.alt || mods.meta || mods.super || mods.hyper) {
    const n = /^[A-Z]$/.test(ch) ? ch.toLowerCase() : ch
    return { type: 'key', name: n, ...mods }
  }
  // 可打印：按 shift 还原大小写（Kitty 未开“报告交替键”时的近似）
  const text = (mods.shift && /^[a-z]$/.test(ch)) ? ch.toUpperCase() : ch
  return { type: 'char', text }
}

// 单个字符（非 ESC 序列）→ 事件
function fromSingleChar(ch) {
  const code = ch.codePointAt(0)
  if (code === 8) return { type: 'key', name: 'backspace' }
  if (code === 9) return { type: 'key', name: 'tab' }
  if (code === 10) return { type: 'key', name: 'j', ctrl: true }
  if (code === 13) return { type: 'key', name: 'enter' }
  if (code === 127) return { type: 'key', name: 'backspace' }
  if (code === 0) return { type: 'key', name: 'space', ctrl: true }
  if (code >= 1 && code <= 26) return { type: 'key', name: String.fromCharCode(96 + code), ctrl: true }
  if (code >= 28 && code <= 31) return { type: 'key', name: ['\\', ']', '^', '_'][code - 28], ctrl: true }
  if (code < 32) return { type: 'unknown', raw: ch }
  return { type: 'char', text: ch }
}

// 给事件加 Alt（ESC 前缀）
function withAlt(ev) {
  if (ev.type === 'char') return { type: 'key', name: ev.text, alt: true }
  if (ev.type === 'key') return { ...ev, alt: true }
  if (ev.type === 'unknown') return { type: 'unknown', raw: ESC + (ev.raw || '') }
  return ev
}

// CSI 字母键：从参数体取修饰键（如 '1;5' → 5 → ctrl）
function modsFromCsiBody(body) {
  if (!body) return {}
  const parts = body.split(';').filter((p) => p !== '')
  if (parts.length >= 2) return decodeModifierValue(parts[parts.length - 1])
  return {}
}

function parseCsiTilde(body, raw) {
  if (body === '200') return { type: 'paste-start' }
  if (body === '201') return { type: 'paste-end' }
  const parts = body.split(';')
  // xterm modifyOtherKeys: CSI 27 ; mod ; codepoint ~
  if (parts[0] === '27' && parts.length >= 3) {
    return keyFromCode(parseInt(parts[2], 10), decodeModifierValue(parts[1]))
  }
  const name = CSI_TILDE_NAMES[parts[0]]
  if (!name) return { type: 'unknown', raw }
  const mods = parts[1] ? decodeModifierValue(parts[1]) : {}
  return { type: 'key', name, ...mods }
}

function parseCsiU(body, raw) {
  // Kitty: CSI codepoint[:shifted[:base]] ; modifiers[:event] u
  const parts = body.split(';')
  const code = parseInt(parts[0].split(':')[0], 10)
  if (!Number.isFinite(code)) return { type: 'unknown', raw }
  const mods = parts[1] ? decodeModifierValue(parts[1].split(':')[0]) : {}
  return keyFromCode(code, mods)
}

function parseCsi(body, final, raw) {
  if (final === 'u') return parseCsiU(body, raw)
  if (final === '~') return parseCsiTilde(body, raw)
  if (final === 'M' || final === 'm') {
    return body.startsWith('<') ? { type: 'mouse', raw } : { type: 'unknown', raw }
  }
  if (final === 'Z') return { type: 'key', name: 'tab', shift: true }
  const name = CSI_LETTER_NAMES[final]
  if (!name) return { type: 'unknown', raw }
  return { type: 'key', name, ...modsFromCsiBody(body) }
}

/**
 * 创建一个有状态按键解析器。
 * @returns {{ feed(str:string): object[], pending(): string, reset(): void }}
 */
export function createKeyParser() {
  let buf = ''

  function feed(str) {
    if (str) buf += str
    const out = []
    // 附加原始字节（供 /keys 诊断）；unknown 事件本身已带 raw
    const emit = (ev, raw) => { out.push(ev.raw === undefined ? { ...ev, raw } : ev) }

    while (buf.length) {
      const cp = buf.codePointAt(0)

      if (cp === 0x1b) {                       // ---- ESC 前缀 ----
        if (buf.length === 1) break            // 单独 ESC：挂起等后续

        const n1 = buf[1]
        if (n1 === '[') {                       // CSI
          let i = 2
          while (i < buf.length) {
            const c = buf.charCodeAt(i)
            if (c >= 0x40 && c <= 0x7e) break
            i++
          }
          if (i >= buf.length) {                // 未终结
            if (buf.length > MAX_SEQ) { out.push({ type: 'unknown', raw: buf }); buf = '' }
            break
          }
          const raw = buf.slice(0, i + 1)
          emit(parseCsi(buf.slice(2, i), buf[i], raw), raw)
          buf = buf.slice(i + 1)
          continue
        }
        if (n1 === 'O') {                       // SS3
          if (buf.length < 3) {
            if (buf.length > MAX_SEQ) { out.push({ type: 'unknown', raw: buf }); buf = '' }
            break
          }
          const raw = buf.slice(0, 3)
          const name = SS3_NAMES[buf[2]]
          emit(name ? { type: 'key', name } : { type: 'unknown', raw }, raw)
          buf = buf.slice(3)
          continue
        }
        if (n1 === ']') {                       // OSC：直到 BEL 或 ST
          let end = -1
          for (let k = 2; k < buf.length; k++) {
            if (buf[k] === '\x07') { end = k + 1; break }
            if (buf[k] === '\x1b' && buf[k + 1] === '\\') { end = k + 2; break }
          }
          if (end < 0) {
            if (buf.length > MAX_SEQ) { out.push({ type: 'unknown', raw: buf }); buf = '' }
            break
          }
          out.push({ type: 'unknown', raw: buf.slice(0, end) })
          buf = buf.slice(end)
          continue
        }
        if (n1 === 'P' || n1 === '_' || n1 === '^' || n1 === 'X') { // DCS/APC/PM/SOS：直到 ST
          const idx = buf.indexOf('\x1b\\', 2)
          if (idx < 0) {
            if (buf.length > MAX_SEQ) { out.push({ type: 'unknown', raw: buf }); buf = '' }
            break
          }
          out.push({ type: 'unknown', raw: buf.slice(0, idx + 2) })
          buf = buf.slice(idx + 2)
          continue
        }
        // 其余：Alt + 字符
        const ch = /[\uD800-\uDBFF]/.test(n1) && buf.length >= 3 ? buf.slice(1, 3) : n1
        const raw = ESC + ch
        emit(withAlt(fromSingleChar(ch)), raw)
        buf = buf.slice(1 + ch.length)
        continue
      }

      // ---- 普通字符 ----
      const ch = buf.length >= 2 && cp >= 0x10000 ? buf.slice(0, 2) : String.fromCodePoint(cp)
      emit(fromSingleChar(ch), ch)
      buf = buf.slice(ch.length)
    }
    return out
  }

  /**
   * 冲刷未终结的缓冲（供调用方在「一段时间没新数据」后调用）：
   *   - 单个 ESC → escape 键（用户真的按了 Esc）
   *   - 其余残片 → unknown（安全丢弃，不污染输入）
   * 这样「单独按 Esc」不会永久挂起等下一个字符。
   */
  function flush() {
    if (!buf) return []
    const raw = buf
    buf = ''
    if (raw === ESC) return [{ type: 'key', name: 'escape', raw }]
    return [{ type: 'unknown', raw }]
  }

  return {
    feed,
    flush,
    pending: () => buf,
    reset: () => { buf = '' },
  }
}

/** 把逻辑键事件转成 keybindings 的“键规格”字符串（如 "ctrl+left"）。 */
export function keyEventToSpec(ev) {
  if (!ev || ev.type !== 'key') return null
  const parts = []
  if (ev.ctrl) parts.push('ctrl')
  if (ev.alt) parts.push('alt')
  if (ev.shift) parts.push('shift')
  if (ev.meta) parts.push('meta')
  if (ev.super) parts.push('super')
  if (ev.hyper) parts.push('hyper')
  parts.push(String(ev.name || '').toLowerCase())
  return parts.join('+')
}

/** 人类可读描述（供 /keys 诊断用） */
export function describeKeyEvent(ev) {
  if (!ev) return '(none)'
  if (ev.type === 'char') return `char ${JSON.stringify(ev.text)}`
  if (ev.type === 'paste-start') return 'paste-start'
  if (ev.type === 'paste-end') return 'paste-end'
  if (ev.type === 'mouse') return `mouse ${JSON.stringify(ev.raw)}`
  if (ev.type === 'unknown') return `unknown ${JSON.stringify(ev.raw)}`
  const spec = keyEventToSpec(ev)
  return `key ${spec}`
}
