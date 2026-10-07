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
//      submit          Enter(.enter)           提交整段输入
//      newline         Ctrl+J / Alt+Enter / …  折行（多行输入）
//      cursor-left/right                       光标左右
//      cursor-word-left/right                 按词移动（Ctrl+←/→、Alt+B/F）
//      line-start/end                         行首/行尾（Home/End、Ctrl+A/E）
//      delete-back/forward                    退格 / 删除（Delete、Ctrl+D）
//      delete-word-back                       向前删词（Ctrl+W、Alt+⌫）
//      kill-line-end/start                    删至行尾/行首（Ctrl+K / Ctrl+U）
//      history-prev/next                      历史（↑/↓）
//      clear-or-exit                          清空 / 退出（Ctrl+C）
//
//  粘贴：开启 bracketed paste（\x1b[?2004h）；终端用 \x1b[200~ … \x1b[201~
//  包裹粘贴内容，故粘贴里的换行一律当「字面换行」插入，绝不误判为提交。
//  对不支持括号粘贴的终端，用「同一数据块内换行两侧都有内容」的启发式兜底。
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

export function createMultilineInput({
  prompt = '> ', onSubmit, onExit, stdin, stdout, keybindings: userBindings, onKeyEvent,
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
    lastChunk = text
    chunkHasBracket = text.includes('\x1b[200~') || text.includes('\x1b[201~')
    for (const ev of parser.feed(text)) handleEvent(ev)
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

  function displayText() {
    return PROMPT + text().replace(/\n/g, '\n' + ' '.repeat(PROMPT.length))
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
    const segs = displayText().split('\n')
    const w = visibleWidth(segs[segs.length - 1])
    return { row: Math.max(0, displayedRows - 1), col: w % c }
  }

  // 清空并重绘整个输入区，并把光标移回编辑位置
  function render() {
    if (pasteActive) return   // 粘贴期间不重绘，paste-end 统一重绘

    if (displayedRows > 1) output.write(`\x1b[${displayedRows - 1}A`)
    output.write('\r')
    output.write('\x1b[J')

    const rendered = displayText()
    output.write(rendered)
    displayedRows = renderedRows(rendered)

    const at = cursorRowCol()
    const end = endRowCol()
    if (at.row !== end.row || at.col !== end.col) {
      if (end.row > at.row) output.write(`\x1b[${end.row - at.row}A`)
      output.write('\r')
      if (at.col > 0) output.write(`\x1b[${at.col}C`)
    }
  }

  function showPrompt() {
    if (output.isTTY) output.write('\x1b[0m')
    output.write(PROMPT)
    displayedRows = 1
    buffer = []
    cursor = 0
  }

  function submit() {
    const inputText = text()
    buffer = []
    cursor = 0
    suppressNextLF = true
    displayedRows = 0
    output.write('\n')
    if (inputText.trim()) {
      inputHistory.push(inputText)
      historyIndex = inputHistory.length
    }
    if (onSubmit) onSubmit(inputText)
    else showPrompt()
  }

  function clearOrExit() {
    if (buffer.length > 0) {
      buffer = []
      cursor = 0
      displayedRows = 0
      output.write('\n')
      showPrompt()
    } else {
      output.write('\nGoodbye!\n')
      if (onExit) onExit()
    }
  }

  function setBuffer(str) {
    buffer = Array.from(str)
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
  function backspace() { if (cursor > 0) { buffer.splice(cursor - 1, 1); cursor-- } }
  function delForward() { if (cursor < buffer.length) buffer.splice(cursor, 1) }
  function lineStart() { let i = cursor; while (i > 0 && buffer[i - 1] !== '\n') i--; return i }
  function lineEnd() { let i = cursor; while (i < buffer.length && buffer[i] !== '\n') i++; return i }
  function prevWord() {
    let i = cursor
    while (i > 0 && /\s/.test(buffer[i - 1])) i--
    while (i > 0 && !/\s/.test(buffer[i - 1])) i--
    return i
  }
  function nextWord() {
    let i = cursor
    while (i < buffer.length && !/\s/.test(buffer[i])) i++
    while (i < buffer.length && /\s/.test(buffer[i])) i++
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
    if (spec === 'enter' || spec === 'ctrl+j') {
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

    // 括号粘贴边界
    if (ev.type === 'paste-start') { pasteActive = true; pasteCRPending = false; return }
    if (ev.type === 'paste-end') {
      pasteActive = false
      pasteCRPending = false
      render()
      return
    }
    if (ev.type === 'unknown' || ev.type === 'mouse') return

    const inPaste = pasteActive || isPasteBurst()

    // 粘贴期间：换行一律当字面插入（CRLF 合并），其余按键不触发动作
    if (inPaste) {
      if (ev.type === 'char') {
        pasteCRPending = false
        insert(ev.text)
        return
      }
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
    if (pasteModeEnabled) {
      try { output.write(SEQ.pasteOff) } catch {}
      pasteModeEnabled = false
    }
    try { input.setRawMode(false) } catch {}
    input.removeListener('data', onData)
  }

  return { start, showPrompt, ask, dispose, bindings }
}
