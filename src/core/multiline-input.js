// ============================================================
//  multiline-input.js — REPL 多行输入（读取完整输入再处理）
// ------------------------------------------------------------
//  解决「输入缓存未读完就按 \n 断句」的根因问题：
//    readline 的 line 事件遇到 \n 就提交当前行，导致多行文本
//    被拆成多段，且后续行在引擎忙时被丢弃。
//
//  本模块用「自研 keymap 解析器 + 可配置 keybindings」驱动一个带光标的
//  行编辑器 —— 应用只认「虚拟动作」，不认物理按键：
//    （见 keymap.js / keybindings.js）
//
//    默认动作（可在 config.json 的 keybindings 段重映射）：
//      submit          Ctrl+S                  发送（提交整段输入）
//      newline         Enter / Ctrl+J / Alt+Enter  折行（多行输入）
//      cursor-left/right                       光标左右
//      cursor-word-left/right                 按词移动（Ctrl+←/→、Alt+B/F）
//      line-start/end                         行首/行尾（Home/End、Ctrl+A/E）
//      delete-back/forward                    退格 / 删除（Delete、Ctrl+D）
//      delete-word-back                       向前删词（Ctrl+W、Alt+⌫）
//      kill-line-end/start                    删至行尾/行首（Ctrl+K / Ctrl+U）
//      history-prev/next                      历史（↑/↓）
//      clear-or-exit                          清空 / 退出（Ctrl+C）
//
//  ⚠️ v3.6.9 起：**Enter = 折行，不再发送**；发送用显式外部键 Ctrl+S。
//    本模块在输入区下方渲染一行**软键行**（如「^S 发送 │ ⏎ 折行 │ …」），
//    内容由当前生效绑定实时生成（bindings.hintFor）→ 改键即同步。
//    用 config.softkeys 控制：true=默认集 / 数组=指定动作 / false=关闭。
//
//  焦点模式（TUI 式切换）：
//    F2  → 焦点从「输入区」切到「虚拟按键区」（硬件光标隐藏，当前项反显高亮）
//    ←/→ 或 ↑/↓ → 在虚拟按键间移动高亮（Home/End 到首/末）
//    Enter → 激活高亮的按键（产生同一个虚拟动作），随后自动回到输入模式
//    Esc 或 F2 → 直接回到输入模式；直接打字也会自动切回并插入
//    这样「停下打字 → 移到按键 → 激活」构成一次显式的**行为模式切换**。
//
//  粘贴：开启 bracketed paste（\x1b[?2004h）；终端用 \x1b[200~ … \x1b[201~
//  包裹粘贴内容，故粘贴里的换行一律当「字面换行」插入，绝不误判为提交。
//    · 大批粘贴折叠：>10 行或 >1000 字符 → 记为原子的 [paste #n +N lines]，
//      提交时展开回原文（避免几百行糊满屏幕、且光标按整块移动/删除）。
//    · 对不支持括号粘贴的终端，用「同一数据块内换行两侧都有内容」的启发式兜底。
//
//  渲染：每次重绘包在「同步输出」（CSI 2026）里，终端原子提交、不闪屏。
//  解析：数据静默 10ms 后用 parser.flush() 冲掉残留（孤立 ESC → escape 键）。
//
//  非 TTY（管道/重定向）→ 回退到 readline line 事件
//
//  接口：
//    createMultilineInput({ prompt, onSubmit, onExit, stdin, stdout, keybindings })
//      -> { start(), showPrompt(), ask(questionText), dispose() }
// ============================================================

import * as readline from 'readline'
import { StringDecoder } from 'string_decoder'
import { createKeyParser, keyEventToSpec } from './keymap.js'
import { createKeybindings } from './keybindings.js'
import { SEQ } from './terminal-caps.js'

// 大批粘贴折叠阈值（参考 pi-tui）：超过任一阈值就把内容折叠成原子标记，
// 避免 500 行粘贴把输入区撑爆；提交时再把标记展开回原文。
const PASTE_MAX_LINES = 10
const PASTE_MAX_CHARS = 1000
const PASTE_MARKER_SRC = '\\[paste #(\\d+) (?:\\+\\d+ lines|\\d+ chars)\\]'
const PASTE_MARKER_RE = new RegExp(PASTE_MARKER_SRC, 'g')
// 解析器残留冲刷延迟（毫秒）：数据静默这么久后，把孤立 ESC / 半截序列冲掉
const FLUSH_MS = 10
// 软键行默认展示的动作（按顺序）；可用 config.softkeys 覆盖
const DEFAULT_SOFTKEY_ACTIONS = ['submit', 'newline', 'history-prev', 'clear-or-exit']
// 硬件光标显隐
const HIDE_CURSOR = '\x1b[?25l'
const SHOW_CURSOR = '\x1b[?25h'

export function createMultilineInput({
  prompt = '> ', onSubmit, onExit, stdin, stdout, keybindings: userBindings, onKeyEvent,
  softkeys = true,
} = {}) {
  const input = stdin || process.stdin
  const output = stdout || process.stdout
  const isTTY = input.isTTY

  let inputHistory = []     // 输入历史
  let historyIndex = -1     // 历史浏览索引（-1 = 编辑新输入）
  let suppressNextLF = false // 提交后忽略紧随的 LF（CRLF 残留）
  let questioning = false   // 是否正在收集单行问题（权限确认等）
  let questionResolve = null
  let questionBuf = ''

  // 大批粘贴折叠
  const pastes = new Map()      // id → 原始内容
  let pasteCounter = 0
  let pasteContent = ''         // bracketed paste 期间累积的内容
  let flushTimer = null         // 解析器残留冲刷定时器

  const PROMPT = prompt
  let displayedRows = 0     // 当前输入区在终端实际占用的屏幕行数

  // 输入缓冲按「码点」维护：便于整字符插入/删除/左右移动（避免拆散代理对）
  let buffer = []
  let cursor = 0            // 光标在 buffer 中的位置（0..buffer.length）

  // 粘贴状态
  let pasteActive = false       // 处于 bracketed paste 区间内
  let pasteCRPending = false    // 粘贴中刚遇到 CR，等待可能的 LF（合并 CRLF）
  let pasteModeEnabled = false  // 是否已开启 bracketed paste mode
  let lastChunk = ''            // 最近一次 stdin 原始数据块（无括号粘贴时的突发识别）
  let chunkHasBracket = false   // 当前数据块是否含括号粘贴标记

  const bindings = createKeybindings(userBindings)

  // 软键行要展示的动作：false/'off'/0 → 关闭；数组 → 自定义；其它 → 默认集
  const softkeyActions = (() => {
    if (softkeys === false || softkeys === 'off' || softkeys === 0) return []
    if (Array.isArray(softkeys)) return softkeys.map(String)
    return DEFAULT_SOFTKEY_ACTIONS.slice()
  })()

  // 焦点模式：'input' = 编辑文本；'softkeys' = 焦点移到虚拟按键区（TUI 选择器）
  // 用 softkeys-toggle（默认 F2）在两者间切换；Esc 也回到输入模式。
  let mode = 'input'
  let softkeyIndex = 0      // 软键模式下高亮的按键索引
  let cursorHidden = false  // 软键模式下隐藏硬件光标（高亮由反显表示）
  // 光标当前停留在「输入区」内的相对行（0 = 区域顶行）。
  // 重绘必须先回到区域顶行，位移量就是这个值 —— 不能用 displayedRows-1，
  // 那会假设光标停在区域底部；加了软键行后会导致多上移一行、擦掉区域上方内容。
  let cursorRowRel = 0

  // ============================================================
  // 非 TTY 模式：回退到 readline line 事件（管道/重定向）
  // ============================================================
  if (!isTTY) {
    const rl = readline.createInterface({ input, output, prompt })
    return {
      start() { rl.on('line', (line) => onSubmit(line)); rl.prompt() },
      showPrompt() { rl.prompt() },
      ask(q) {
        return new Promise((resolve) => { rl.question(q + ' ', resolve) })
      },
      dispose() { rl.close() },
    }
  }

  // ============================================================
  // TTY 模式：自研解析器 + 行编辑器
  // ============================================================
  const parser = createKeyParser()
  const decoder = new StringDecoder('utf8')
  try { input.setRawMode(true) } catch {}

  // 原始数据块监听（用于无括号粘贴的突发识别）
  const onData = (chunk) => {
    const text = typeof chunk === 'string' ? chunk : decoder.write(chunk)
    if (!text) return
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
    lastChunk = text
    chunkHasBracket = text.includes('\x1b[200~') || text.includes('\x1b[201~')
    for (const ev of parser.feed(text)) handleEvent(ev)
    // 若还剩未终结的序列（孤立 ESC / 半截 CSI），一小段静默后冲刷，
    // 避免「单独按 Esc」永久挂起、或半个序列卡住后续输入。
    if (parser.pending()) {
      flushTimer = setTimeout(() => {
        flushTimer = null
        for (const ev of parser.flush()) handleEvent(ev)
      }, FLUSH_MS)
    }
  }
  input.on('data', onData)

  // 终端列数（缺省 80）
  function cols() {
    return (output.columns && output.columns > 0) ? output.columns : 80
  }

  // 单字符在终端占用的列宽（CJK/全角 = 2，其余 = 1）
  function charWidth(ch) {
    const code = ch.codePointAt(0)
    if (
      (code >= 0x1100 && code <= 0x115F) ||
      (code >= 0x2E80 && code <= 0x303E) ||
      (code >= 0x3041 && code <= 0x33FF) ||
      (code >= 0x3400 && code <= 0x4DBF) ||
      (code >= 0x4E00 && code <= 0x9FFF) ||
      (code >= 0xA000 && code <= 0xA4CF) ||
      (code >= 0xAC00 && code <= 0xD7A3) ||
      (code >= 0xF900 && code <= 0xFAFF) ||
      (code >= 0xFE30 && code <= 0xFE4F) ||
      (code >= 0xFF00 && code <= 0xFF60) ||
      (code >= 0xFFE0 && code <= 0xFFE6)
    ) return 2
    return 1
  }

  function visibleWidth(text) {
    let w = 0
    for (const ch of text) w += charWidth(ch)
    return w
  }

  function renderedRows(text) {
    const c = cols()
    let rows = 0
    for (const segment of text.split('\n')) {
      rows += Math.max(1, Math.ceil(visibleWidth(segment) / c))
    }
    return rows
  }

  function text() { return buffer.join('') }

  // 判断单元格是否为空白（粘贴标记是复合单元，不算空白）
  function isWsCell(cell) {
    return cell.length === 1 && /\s/.test(cell)
  }

  // 把字符串切成「单元格」：粘贴标记（[paste #n …]）整体算一个单元（原子），
  // 其余按码点。于是光标移动/退格/删词都把整个标记当作一个字符处理。
  function splitCells(str) {
    const cells = []
    let last = 0
    PASTE_MARKER_RE.lastIndex = 0
    let m
    while ((m = PASTE_MARKER_RE.exec(str)) !== null) {
      for (const ch of str.slice(last, m.index)) cells.push(ch)
      cells.push(m[0])
      last = m.index + m[0].length
    }
    for (const ch of str.slice(last)) cells.push(ch)
    return cells
  }

  // 提交时把 [paste #n …] 标记展开回原始内容
  function expandPastes(str) {
    return str.replace(PASTE_MARKER_RE, (whole, id) => {
      const content = pastes.get(Number(id))
      return content === undefined ? whole : content
    })
  }

  // 提交一段粘贴内容：小则原样插入，大则折叠成原子标记（参考 pi-tui）
  function commitPaste(raw) {
    if (!raw) return
    const lines = raw.split('\n')
    if (lines.length > PASTE_MAX_LINES || raw.length > PASTE_MAX_CHARS) {
      const id = ++pasteCounter
      pastes.set(id, raw)
      const label = lines.length > PASTE_MAX_LINES ? `+${lines.length} lines` : `${raw.length} chars`
      insertCell(`[paste #${id} ${label}]`)
    } else {
      insert(raw)
    }
  }

  function displayText() {
    return PROMPT + text().replace(/\n/g, '\n' + ' '.repeat(PROMPT.length))
  }

  // ---- 软键行（输入区下方的虚拟按键）----
  // 键位提示由**当前生效绑定**实时生成 → 用户改键，提示自动跟随。
  function softkeyItems() {
    if (softkeyActions.length === 0) return []
    const items = []
    for (const a of softkeyActions) {
      const label = bindings.hintFor(a, { all: false })   // 只显示主键，保持紧凑
      if (label) items.push({ action: a, label })
    }
    return items
  }

  // 按终端宽度截断「纯文本」（用于测量）
  function truncatePlain(text, max) {
    if (max <= 0) return ''
    let w = 0
    let out = ''
    for (const ch of text) {
      const cw = charWidth(ch)
      if (w + cw > max) return out + '…'
      out += ch
      w += cw
    }
    return out
  }

  // 按终端宽度截断「带 ANSI 的字符串」：ANSI 零宽，超出宽度的部分截掉并加省略号。
  // 与 truncatePlain 使用同一可见内容，故两者截断点一致（宽度对齐）。
  function truncateStyled(styled, max) {
    if (max <= 0) return ''
    let w = 0
    let out = ''
    let i = 0
    while (i < styled.length) {
      if (styled[i] === '\x1b') {
        const m = /^\x1b\[[0-9;?]*[A-Za-z]/.exec(styled.slice(i))
        if (m) { out += m[0]; i += m[0].length; continue }
      }
      const ch = String.fromCodePoint(styled.codePointAt(i))
      const cw = charWidth(ch)
      if (w + cw > max) return out + '\x1b[0m…'
      out += ch
      w += cw
      i += ch.length
    }
    return out
  }

  // 软键行：返回 { plain, styled }。styled 只多 ANSI，可见字符与 plain 一一对应。
  // 输入模式：整行暗色（提示）；软键模式：高亮项反显、其余暗色（TUI 选择器）。
  function softkeyBar() {
    const items = softkeyItems()
    if (items.length === 0) return { plain: '', styled: '' }
    const focused = mode === 'softkeys'
    const sep = ' │ '
    const dim = (s) => (focused ? `\x1b[2m${s}\x1b[0m` : s)
    let plain = '  '
    let styled = '  '
    items.forEach((it, i) => {
      if (i > 0) {
        plain += sep
        styled += focused ? `\x1b[2m${sep}\x1b[0m` : sep
      }
      if (focused && i === softkeyIndex) {
        const t = `▸${it.label}◂`
        plain += t
        styled += `\x1b[7m\x1b[1m${t}\x1b[0m`      // 反显 + 加粗 = 当前高亮项
      } else {
        plain += it.label
        styled += dim(it.label)
      }
    })
    const hint = focused ? '   ←/→ 选择 · Enter 激活 · Esc 返回' : '   F2 软键'
    plain += hint
    styled += dim(hint)
    const wrapped = focused ? styled : `\x1b[2m${styled}\x1b[0m`
    // 用同一宽度截断 plain 与 styled，保证「测量宽度」与「实际绘制」一致
    const max = cols() - 1
    return { plain: truncatePlain(plain, max), styled: truncateStyled(wrapped, max) }
  }

  // 本次渲染的完整可见内容（含软键行），用于行数 / 末行定位
  function fullPlain() {
    const bar = softkeyBar().plain
    return bar ? displayText() + '\n' + bar : displayText()
  }

  // ---- 焦点模式：输入区 ↔ 虚拟按键区 ----
  function restoreCursor() {
    if (cursorHidden) { try { output.write(SHOW_CURSOR) } catch { /* ignore */ } ; cursorHidden = false }
  }

  function setMode(m) {
    if (m === 'softkeys' && softkeyItems().length === 0) return   // 无按键可切
    mode = m
    if (m === 'softkeys') {
      const n = softkeyItems().length
      if (softkeyIndex >= n) softkeyIndex = n - 1
      if (softkeyIndex < 0) softkeyIndex = 0
    }
    render()
  }

  function moveFocus(d) {
    const n = softkeyItems().length
    if (n === 0) return
    softkeyIndex = (softkeyIndex + d + n) % n
    render()
  }

  // 激活当前高亮的虚拟按键 → 产生对应的「虚拟动作」，随后自动回到输入模式
  function activateSoftkey() {
    const items = softkeyItems()
    if (items.length === 0) return
    const action = items[softkeyIndex].action
    mode = 'input'
    restoreCursor()          // submit 等动作不重绘，这里先把光标恢复
    runAction(action)
  }

  // 光标在输入区内的视觉 (行, 列)
  function cursorRowCol() {
    const c = cols()
    const segs = [[]]
    for (const ch of buffer) {
      if (ch === '\n') segs.push([])
      else segs[segs.length - 1].push(ch)
    }
    let segIdx = 0
    let off = 0
    for (let i = 0; i < cursor; i++) {
      if (buffer[i] === '\n') { segIdx++; off = 0 } else off++
    }
    let row = 0
    for (let i = 0; i < segIdx; i++) {
      const w = PROMPT.length + visibleWidth(segs[i].join(''))
      row += Math.max(1, Math.ceil(w / c))
    }
    const colInLine = PROMPT.length + visibleWidth(segs[segIdx].slice(0, off).join(''))
    row += Math.floor(colInLine / c)
    return { row, col: colInLine % c }
  }

  function endRowCol() {
    const c = cols()
    const segs = fullPlain().split('\n')
    const w = visibleWidth(segs[segs.length - 1])
    return { row: Math.max(0, displayedRows - 1), col: w % c }
  }

  // 清空并重绘整个输入区，并把光标移回编辑位置
  // 整帧包在「同步输出」（CSI 2026）里：终端原子提交，消除擦除—重画之间的撕裂/闪屏。
  function render() {
    if (pasteActive) return   // 粘贴期间不重绘，paste-end 统一重绘

    let out = SEQ.syncOn
    // 先回到「输入区」顶行：光标停在上一帧算出的 cursorRowRel 行，故上移这么多行。
    if (cursorRowRel > 0) out += `\x1b[${cursorRowRel}A`
    out += '\r\x1b[J\x1b[0m'

    // 软键模式隐藏硬件光标（高亮由反显表示）；输入模式恢复
    if (mode === 'softkeys') {
      if (!cursorHidden) { out += HIDE_CURSOR; cursorHidden = true }
    } else if (cursorHidden) {
      out += SHOW_CURSOR; cursorHidden = false
    }

    const rendered = displayText()
    out += rendered
    displayedRows = renderedRows(rendered)

    // 软键行（输入区下方一行）：输入模式=提示；软键模式=可高亮选择的虚拟按键
    // 用显式 \r\n（不依赖终端 ONLCR），否则某些环境下面板会写在错误的列上
    const bar = softkeyBar()
    if (bar.plain) {
      out += '\r\n' + bar.styled
      displayedRows += 1
    }

    if (mode === 'input') {
      const at = cursorRowCol()
      const end = endRowCol()
      if (at.row !== end.row || at.col !== end.col) {
        if (end.row > at.row) out += `\x1b[${end.row - at.row}A`
        out += '\r'
        if (at.col > 0) out += `\x1b[${at.col}C`
      }
      cursorRowRel = at.row
    } else {
      cursorRowRel = displayedRows - 1   // 软键模式：光标停在末行（软键行）
    }
    out += SEQ.syncOff
    output.write(out)
  }

  function showPrompt() {
    buffer = []
    cursor = 0
    displayedRows = 0
    cursorRowRel = 0          // 新提示符画在当前位置，无需回退
    render()                  // 统一走 render：自动带上软键行
  }

  function submit() {
    const shown = text()                    // 显示文本（含 [paste #n …] 标记）
    const inputText = expandPastes(shown)   // 实际提交内容（标记展开回原文）
    buffer = []
    cursor = 0
    suppressNextLF = true
    displayedRows = 0
    cursorRowRel = 0          // 提交后新内容从下一行开始，不再回退
    output.write('\n')
    if (shown.trim()) {
      inputHistory.push(shown)              // 历史存显示文本，↑ 调出时不撑爆屏幕
      historyIndex = inputHistory.length
    }
    if (onSubmit) onSubmit(inputText)
    else showPrompt()
  }

  function clearOrExit() {
    if (buffer.length > 0) {
      buffer = []
      cursor = 0
      render()   // 擦除旧区域（含软键行）并重画干净提示符
    } else {
      output.write('\nGoodbye!\n')
      if (onExit) onExit()
    }
  }

  function setBuffer(str) {
    buffer = splitCells(str)
    cursor = buffer.length
    render()
  }

  function loadHistory(dir) {
    if (inputHistory.length === 0) return
    if (dir === -1) {
      if (historyIndex <= 0) { historyIndex = 0; setBuffer(inputHistory[0]); return }
      historyIndex--
    } else {
      if (historyIndex >= inputHistory.length) return
      historyIndex++
    }
    setBuffer(historyIndex < inputHistory.length ? inputHistory[historyIndex] : '')
  }

  // ---- 编辑原语 ----
  function insert(str) {
    const cps = Array.from(str)
    if (cps.length === 0) return
    buffer.splice(cursor, 0, ...cps)
    cursor += cps.length
  }
  // 以「单个单元格」插入（粘贴标记保持原子性）
  function insertCell(cell) {
    if (!cell) return
    buffer.splice(cursor, 0, cell)
    cursor++
  }
  function backspace() { if (cursor > 0) { buffer.splice(cursor - 1, 1); cursor-- } }
  function delForward() { if (cursor < buffer.length) buffer.splice(cursor, 1) }
  function lineStart() { let i = cursor; while (i > 0 && buffer[i - 1] !== '\n') i--; return i }
  function lineEnd() { let i = cursor; while (i < buffer.length && buffer[i] !== '\n') i++; return i }
  function prevWord() {
    let i = cursor
    while (i > 0 && isWsCell(buffer[i - 1])) i--
    while (i > 0 && !isWsCell(buffer[i - 1])) i--
    return i
  }
  function nextWord() {
    let i = cursor
    while (i < buffer.length && !isWsCell(buffer[i])) i++
    while (i < buffer.length && isWsCell(buffer[i])) i++
    return i
  }

  // 无括号粘贴的兜底：数据块归一 CRLF 后存在「非换行 + 换行 + 之后仍有非换行」
  function isPasteBurst() {
    if (!lastChunk || chunkHasBracket) return false
    const norm = lastChunk.replace(/\r\n/g, '\n')
    return /[^\r\n][\r\n]+[\s\S]*[^\r\n]/.test(norm)
  }

  // ---- 虚拟动作分发 ----
  function runAction(action) {
    switch (action) {
      case 'submit': submit(); return
      case 'newline': insert('\n'); render(); return
      case 'cursor-left': if (cursor > 0) { cursor--; render() } return
      case 'cursor-right': if (cursor < buffer.length) { cursor++; render() } return
      case 'cursor-word-left': cursor = prevWord(); render(); return
      case 'cursor-word-right': cursor = nextWord(); render(); return
      case 'line-start': cursor = lineStart(); render(); return
      case 'line-end': cursor = lineEnd(); render(); return
      case 'delete-back': backspace(); render(); return
      case 'delete-forward': delForward(); render(); return
      case 'delete-word-back': { const p = prevWord(); buffer.splice(p, cursor - p); cursor = p; render(); return }
      case 'kill-line-end': buffer.splice(cursor, buffer.length - cursor); render(); return
      case 'kill-line-start': buffer.splice(0, cursor); cursor = 0; render(); return
      case 'history-prev': loadHistory(-1); return
      case 'history-next': loadHistory(1); return
      case 'clear-or-exit': clearOrExit(); return
      case 'softkeys-toggle': setMode('softkeys'); return
      default: return
    }
  }

  // ---- 单行问题收集 ----
  function handleQuestion(ev) {
    if (ev.type === 'char') {
      questionBuf += ev.text
      output.write(ev.text)
      return
    }
    if (ev.type !== 'key') return
    const spec = keyEventToSpec(ev)
    if (spec === 'ctrl+c') {
      output.write('\n')
      const r = questionResolve; questionResolve = null; questioning = false
      if (r) r('')
      return
    }
    if (spec === 'enter' || spec === 'ctrl+j' || bindings.actionFor(spec) === 'submit') {
      output.write('\n')
      const ans = questionBuf; questionBuf = ''
      const r = questionResolve; questionResolve = null; questioning = false
      if (r) r(ans)
      return
    }
    if (spec === 'backspace') {
      questionBuf = questionBuf.slice(0, -1)
      output.write('\b \b')
    }
  }

  function handleEvent(ev) {
    if (onKeyEvent) { try { onKeyEvent(ev) } catch { /* 诊断回调不得影响输入 */ } }
    if (questioning) { handleQuestion(ev); return }

    // 软键模式下粘贴 → 落回输入模式，继续走正常粘贴流程
    if (mode === 'softkeys' && ev.type === 'paste-start') mode = 'input'

    // 括号粘贴边界
    if (ev.type === 'paste-start') { pasteActive = true; pasteCRPending = false; pasteContent = ''; return }
    if (ev.type === 'paste-end') {
      pasteActive = false
      pasteCRPending = false
      const content = pasteContent
      pasteContent = ''
      commitPaste(content)   // 小粘贴原样插入；大粘贴折叠成 [paste #n …] 标记
      render()
      return
    }
    if (ev.type === 'unknown' || ev.type === 'mouse') return

    // ---- 软键模式：焦点在虚拟按键上（TUI 选择器）----
    if (mode === 'softkeys') {
      if (ev.type === 'char') {
        // 直接打字 → 自动切回输入模式并插入（不设死胡同）
        mode = 'input'
        insert(ev.text)
        render()
        return
      }
      if (ev.type !== 'key') return
      const spec = keyEventToSpec(ev)
      const action = bindings.actionFor(spec)
      if (action === 'softkeys-toggle' || spec === 'escape') { setMode('input'); return }
      if (spec === 'left' || spec === 'up' || spec === 'shift+tab') { moveFocus(-1); return }
      if (spec === 'right' || spec === 'down' || spec === 'tab') { moveFocus(1); return }
      if (spec === 'home') { softkeyIndex = 0; render(); return }
      if (spec === 'end') { softkeyIndex = softkeyItems().length - 1; render(); return }
      if (spec === 'enter' || spec === 'ctrl+j' || action === 'submit') { activateSoftkey(); return }
      return
    }

    // 括号粘贴区间内：只累积内容、不逐字重绘（paste-end 一次性提交/重绘）
    if (pasteActive) {
      if (ev.type === 'char') { pasteCRPending = false; pasteContent += ev.text; return }
      if (ev.type === 'key') {
        const spec = keyEventToSpec(ev)
        if (spec === 'enter') { pasteCRPending = true; pasteContent += '\n'; return }
        if (spec === 'ctrl+j') {
          if (pasteCRPending) { pasteCRPending = false; return }  // CRLF 的 LF
          pasteContent += '\n'; return
        }
      }
      return
    }

    // 无括号终端的突发粘贴兜底：保持逐字插入（不折叠、不提交）
    if (isPasteBurst()) {
      if (ev.type === 'char') { pasteCRPending = false; insert(ev.text); return }
      if (ev.type === 'key') {
        const spec = keyEventToSpec(ev)
        if (spec === 'enter') { pasteCRPending = true; insert('\n'); return }
        if (spec === 'ctrl+j') {
          if (pasteCRPending) { pasteCRPending = false; return }  // CRLF 的 LF
          insert('\n'); return
        }
      }
      return
    }

    // 提交后忽略紧随的 LF（CRLF 残留）
    if (ev.type === 'key' && keyEventToSpec(ev) === 'ctrl+j') {
      if (suppressNextLF) { suppressNextLF = false; return }
    } else {
      suppressNextLF = false
    }

    if (ev.type === 'char') { insert(ev.text); render(); return }

    if (ev.type === 'key') {
      const action = bindings.actionFor(keyEventToSpec(ev))
      if (action) runAction(action)
    }
  }

  function ask(q) {
    return new Promise((resolve) => {
      output.write('\n' + q + ' ')
      cursorRowRel = 0        // 光标已移到新的一行
      questioning = true
      questionResolve = resolve
      questionBuf = ''
    })
  }

  function start() {
    // 开启 bracketed paste：粘贴内容被 \x1b[200~ … \x1b[201~ 包裹（自研解析器
    // 自己识别这两个标记，故不再依赖 Node 版本）
    if (output.isTTY) { output.write(SEQ.pasteOn); pasteModeEnabled = true }
    showPrompt()
  }

  function dispose() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
    restoreCursor()   // 若停在软键模式，恢复光标
    if (pasteModeEnabled) {
      try { output.write(SEQ.pasteOff) } catch {}
      pasteModeEnabled = false
    }
    try { input.setRawMode(false) } catch {}
    input.removeListener('data', onData)
  }

  return { start, showPrompt, ask, dispose, bindings }
}
