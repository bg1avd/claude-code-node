// ============================================================
//  multiline-input.js — REPL 多行输入（读取完整输入再处理）
// ------------------------------------------------------------
//  解决「输入缓存未读完就按 \n 断句」的根因问题：
//    readline 的 line 事件遇到 \n 就提交当前行，导致多行文本
//    被拆成多段，且后续行在引擎忙时被丢弃。
//
//  本模块改用 keypress + raw mode 自己管理输入缓冲，并内置一个
//  带光标的行编辑器：
//
//    编辑（光标可停在任意位置）
//      - 可打印字符            → 在光标处插入
//      - ← / →                 → 光标左右移动
//      - Home / End            → 行首 / 行尾
//      - Ctrl+A / Ctrl+E       → 行首 / 行尾
//      - Delete                → 删除光标处字符
//      - Backspace             → 删除光标前字符
//      - Ctrl+K / Ctrl+U       → 删至行尾 / 删至行首
//      - Ctrl+W / Alt+Bksp     → 向前删一个词
//      - Ctrl+← / Ctrl+→       → 按词移动（Alt+←/→ 亦可）
//      - ↑ / ↓                 → 浏览输入历史
//      - Ctrl+C                → 清空 / 退出
//
//    提交 / 换行
//      - Enter（\r）           → 提交整段输入（含内嵌换行）
//      - Ctrl+J                → 折行（字面 \n）
//      - Alt+Enter / Esc+Enter → 折行
//      - Ctrl+Enter            → 折行（部分终端可区分）
//
//    粘贴（关键）
//      - 启动时开启 bracketed paste mode（\x1b[?2004h），退出时关闭；
//        终端会用 \x1b[200~ … \x1b[201~ 包裹粘贴内容，故粘贴里的
//        换行一律当「字面换行」插入，绝不误判为提交 → 不再变多重输入。
//      - 对不支持括号粘贴的终端，用「同一数据块内换行后仍有内容」的
//        启发式识别粘贴突发，行为相同。
//
//    非 TTY（管道/重定向）→ 回退到 readline line 事件
//
//  接口：
//    createMultilineInput({ prompt, onSubmit, onExit, stdin, stdout })
//      -> { start(), showPrompt(), ask(questionText), dispose() }
//         onSubmit(text)    完整输入（可能含 \n）提交回调
//         ask(qText)        单行问题收集（返回 Promise<string>）
// ============================================================

import * as readline from 'readline'

// bracketed paste mode 开关序列（xterm CSI ? 2004 h / l）
const PASTE_ON = '\x1b[?2004h'
const PASTE_OFF = '\x1b[?2004l'

// Node 内置 readline 从哪些版本起能把 \x1b[200~ / \x1b[201~ 解析成
// paste-start / paste-end 事件（实测：18.19+、20.8+、21+）。
// 只有支持时才主动开启 bracketed paste —— 否则终端会包裹粘贴内容但
// Node 无法告知边界，粘贴内的换行仍会误触发提交。
// 不支持的版本一律不开启，改由「突发识别」兜底处理多行粘贴。
function nodeSupportsBracketedPaste() {
  const m = String(process.versions.node || '0.0.0').split('.').map((n) => parseInt(n, 10) || 0)
  const [maj, min] = m
  if (maj > 20) return true
  if (maj === 20) return min >= 8
  if (maj === 18) return min >= 19
  return false
}

export function createMultilineInput({ prompt = '> ', onSubmit, onExit, stdin, stdout } = {}) {
  const input = stdin || process.stdin
  const output = stdout || process.stdout
  const isTTY = input.isTTY

  let inputHistory = []     // 输入历史
  let historyIndex = -1     // 历史浏览索引（-1 = 编辑新输入）
  let skipNextLF = false    // CRLF 提交后忽略残留 \n
  let questioning = false   // 是否正在收集单行问题（权限确认等）
  let questionResolve = null
  let questionBuf = ''
  let escPending = false    // 刚收到独立 ESC 事件（某些终端把 Alt+Enter 拆成 ESC 和 Enter 两个事件）
  let escTimer = null       // ESC 后跟 Enter 的超时还原定时器

  const PROMPT = prompt
  let displayedRows = 0     // 当前输入区在终端实际占用的屏幕行数（含提示符，考虑换行与 CJK 宽字符）

  // 输入缓冲按「码点」维护：便于整字符插入/删除/左右移动（避免拆散代理对）
  let buffer = []
  let cursor = 0            // 光标在 buffer 中的位置（0..buffer.length）

  // 粘贴状态
  let pasteActive = false       // 处于 bracketed paste 区间内
  let pasteCRPending = false    // 粘贴中刚遇到 \r，等待可能的 \n（合并 CRLF）
  let pasteModeEnabled = false  // 是否已开启 bracketed paste mode
  let lastChunk = ''            // 最近一次 stdin 原始数据块（无括号粘贴时的突发识别）
  let chunkHasBracket = false   // 当前数据块是否含括号粘贴标记（含则不启用突发兜底）

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
  // TTY 模式：keypress + raw mode 多行输入
  // ============================================================

  // 原始数据块监听 —— 必须在 emitKeypressEvents 之前注册，
  // 保证对同一块数据，本回调先于 keypress 事件执行（EventEmitter 按注册序触发）。
  const onData = (chunk) => {
    lastChunk = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    // 数据块内出现括号粘贴标记时，说明终端已按括号粘贴模式发送，
    // 边界由 paste-start/paste-end 事件精确给出，无需再启用突发兜底。
    chunkHasBracket = lastChunk.includes('\x1b[200~') || lastChunk.includes('\x1b[201~')
  }
  input.on('data', onData)

  readline.emitKeypressEvents(input)
  try { input.setRawMode(true) } catch {}

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

  // 文本可见列宽（按 CJK 宽字符计数）
  function visibleWidth(text) {
    let w = 0
    for (const ch of text) w += charWidth(ch)
    return w
  }

  // 渲染文本占用的终端屏幕行数（考虑自动换行；每逻辑行至少 1 行）
  function renderedRows(text) {
    const c = cols()
    let rows = 0
    for (const segment of text.split('\n')) {
      rows += Math.max(1, Math.ceil(visibleWidth(segment) / c))
    }
    return rows
  }

  // 当前缓冲文本
  function text() {
    return buffer.join('')
  }

  // 生成要显示的文本（提示符 + 输入缓冲；换行后按提示符宽度缩进）
  function displayText() {
    return PROMPT + text().replace(/\n/g, '\n' + ' '.repeat(PROMPT.length))
  }

  // 光标在输入区内的视觉 (行, 列) —— 行相对输入区首行，列相对行首
  function cursorRowCol() {
    const c = cols()
    // 按 \n 切分缓冲为多个码点段
    const segs = [[]]
    for (const ch of buffer) {
      if (ch === '\n') segs.push([])
      else segs[segs.length - 1].push(ch)
    }
    // 定位光标所在段与段内偏移
    let segIdx = 0
    let off = 0
    for (let i = 0; i < cursor; i++) {
      if (buffer[i] === '\n') { segIdx++; off = 0 } else off++
    }
    // 之前各段占用的行数（续行含提示符等宽缩进）
    let row = 0
    for (let i = 0; i < segIdx; i++) {
      const w = PROMPT.length + visibleWidth(segs[i].join(''))
      row += Math.max(1, Math.ceil(w / c))
    }
    const colInLine = PROMPT.length + visibleWidth(segs[segIdx].slice(0, off).join(''))
    row += Math.floor(colInLine / c)
    return { row, col: colInLine % c }
  }

  // 全部重绘后「文本末尾」的视觉 (行, 列)
  function endRowCol() {
    const c = cols()
    const segs = displayText().split('\n')
    const w = visibleWidth(segs[segs.length - 1])
    return { row: Math.max(0, displayedRows - 1), col: w % c }
  }

  // 清空并重绘整个输入区，并把光标移回编辑位置
  //   - 移回输入区首行行首 → 清到屏尾 → 重绘 → 把光标放回 cursor 处
  function render() {
    // 粘贴期间不重绘（内容可能很多），等 paste-end 统一重绘，避免逐字符重画
    if (pasteActive) return

    if (displayedRows > 1) output.write(`\x1b[${displayedRows - 1}A`)
    output.write('\r')       // 回到首行行首
    output.write('\x1b[J')   // 清到屏尾

    const rendered = displayText()
    output.write(rendered)
    displayedRows = renderedRows(rendered)

    // 若光标不在文本末尾（被 ← 等移动过），再把它挪回目标位置
    const at = cursorRowCol()
    const end = endRowCol()
    if (at.row !== end.row || at.col !== end.col) {
      if (end.row > at.row) output.write(`\x1b[${end.row - at.row}A`)
      output.write('\r')
      if (at.col > 0) output.write(`\x1b[${at.col}C`)
    }
  }

  function showPrompt() {
    // 复位任何残留的 ANSI 样式（如工具输出泄漏的颜色），保证提示符始终是默认样式
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
    skipNextLF = true
    displayedRows = 0
    output.write('\n')
    if (inputText.trim()) {
      inputHistory.push(inputText)
      historyIndex = inputHistory.length
    }
    if (onSubmit) onSubmit(inputText)
    else showPrompt()
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
  function backspace() {
    if (cursor > 0) { buffer.splice(cursor - 1, 1); cursor-- }
  }
  function delForward() {
    if (cursor < buffer.length) buffer.splice(cursor, 1)
  }
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

  // 无括号粘贴的兜底：判断当前原始数据块是否像「一次多行粘贴」（仅在终端
  // 未使用括号粘贴、即数据块内不含 \x1b[200~/\x1b[201~ 时才启用）
  //
  // 判据：归一 CRLF 后存在「非换行字符 + 换行 + 之后仍有非换行字符」，
  //       即换行两侧都有真实内容 —— 这才是一次多行粘贴的形状。
  // 之所以这么严：单按 Enter 的块是 '\r'（或 '\r\n'），形如 '\r/cmd\r'
  // 的块（Enter 后紧跟快速输入）也不满足「换行前有内容」，均不会命中，
  // 从而绝不吞掉用户真正的回车。
  function isPasteBurst() {
    if (!lastChunk || chunkHasBracket) return false
    const norm = lastChunk.replace(/\r\n/g, '\n')
    return /[^\r\n][\r\n]+[\s\S]*[^\r\n]/.test(norm)
  }

  function onKeypress(str, key) {
    if (!key) return

    // ---- 单行问题收集（权限确认 / AskUserQuestion）----
    if (questioning) {
      if (key.ctrl && key.name === 'c') {
        output.write('\n')
        const r = questionResolve; questionResolve = null; questioning = false
        if (r) r('')
        return
      }
      if (key.name === 'return' || key.name === 'enter') {
        output.write('\n')
        const ans = questionBuf; questionBuf = ''
        const r = questionResolve; questionResolve = null; questioning = false
        if (r) r(ans)
        return
      }
      if (key.name === 'backspace') {
        questionBuf = questionBuf.slice(0, -1)
        output.write('\b \b')
        return
      }
      if (str && key.name !== 'paste-start' && key.name !== 'paste-end') {
        questionBuf += str
        output.write(str)
      }
      return
    }

    // ---- bracketed paste 边界（Node readline 会把它们解析成 paste-start/end）----
    if (key.name === 'paste-start') { pasteActive = true; pasteCRPending = false; return }
    if (key.name === 'paste-end') {
      pasteActive = false
      pasteCRPending = false
      render()
      return
    }

    // ---- Ctrl+C：清空 / 退出 ----
    if (key.ctrl && key.name === 'c') {
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
      return
    }

    // ---- 独立 ESC ----
    if (key.name === 'escape') {
      escPending = true
      if (escTimer) clearTimeout(escTimer)
      escTimer = setTimeout(() => { escPending = false }, 400)
      return
    }

    // ---- Enter / 换行 ----
    //
    // 提交 vs 折行判定：
    //   - 普通 Enter（\r，无 ctrl/meta）          → 提交整段输入
    //   - Ctrl+Enter（部分终端发送 ctrl+return）  → 折行（多行输入）
    //   - Alt+Enter / Esc+Enter（meta+return）    → 折行（跨终端可靠）
    //   - Ctrl+J / 字面 \n（key.name === enter）  → 折行
    //   - 某些终端的 Ctrl/Alt+Enter 发送 CSI 序列 \x1b[13~（key.name === 'f3'）→ 折行
    //
    // 粘贴（括号粘贴或突发识别）期间的换行一律当字面换行，绝不提交。
    if (key.name === 'return' || key.name === 'enter' || key.name === 'f3') {
      if (pasteActive || isPasteBurst()) {
        if (key.name === 'enter') {
          // CRLF：前一个 \r 已经插过一次 \n，这里的 \n 丢弃
          if (pasteCRPending) { pasteCRPending = false; return }
          insert('\n'); render(); return
        }
        if (key.name === 'return') {
          pasteCRPending = true   // 可能后面跟 \n（CRLF）
          insert('\n'); render(); return
        }
        // f3
        insert('\n'); render(); return
      }

      // 紧跟独立 ESC 的 Enter → 视为 Alt+Enter，折行
      if (escPending) {
        escPending = false
        if (escTimer) { clearTimeout(escTimer); escTimer = null }
        insert('\n'); render(); return
      }
      // CSI 序列 \x1b[13~（某些终端的 Ctrl/Alt+Enter）→ 折行
      if (key.name === 'f3') {
        insert('\n'); render(); return
      }
      if (key.name === 'enter') {
        // 字面换行 \n / Ctrl+J → 折行累积
        if (skipNextLF) { skipNextLF = false; return } // CRLF 残留 \n
        insert('\n'); render()
      } else {
        // key.name === 'return'（\r）
        if (key.ctrl || key.meta) {
          // Ctrl+Enter 或 Alt+Enter/Esc+Enter → 折行（多行输入）
          if (skipNextLF) { skipNextLF = false; return }
          insert('\n'); render()
        } else {
          submit() // 普通 Enter → 提交
        }
      }
      return
    }

    // 非 Enter 键：清除 CRLF 残留标记
    skipNextLF = false

    // ESC 后跟普通字符 → 不是 Alt+Enter
    if (escPending && str) {
      escPending = false
      if (escTimer) { clearTimeout(escTimer); escTimer = null }
    }

    // ---- Ctrl 快捷键 ----
    if (key.ctrl) {
      switch (key.name) {
        case 'a': cursor = lineStart(); render(); return
        case 'e': cursor = lineEnd(); render(); return
        case 'k': buffer.splice(cursor, buffer.length - cursor); render(); return
        case 'u': buffer.splice(0, cursor); cursor = 0; render(); return
        case 'w': { const p = prevWord(); buffer.splice(p, cursor - p); cursor = p; render(); return }
        case 'd': if (buffer.length === 0) return; delForward(); render(); return
        case 'b': if (cursor > 0) { cursor--; render() } return
        case 'f': if (cursor < buffer.length) { cursor++; render() } return
        case 'left': cursor = prevWord(); render(); return
        case 'right': cursor = nextWord(); render(); return
        default: return
      }
    }

    // ---- Alt/Meta 组合 ----
    if (key.meta) {
      if (key.name === 'backspace') { const p = prevWord(); buffer.splice(p, cursor - p); cursor = p; render(); return }
      if (key.name === 'left' || key.name === 'b') { cursor = prevWord(); render(); return }
      if (key.name === 'right' || key.name === 'f') { cursor = nextWord(); render(); return }
      return
    }

    // ---- 导航 ----
    if (key.name === 'left') { if (cursor > 0) { cursor--; render() } return }
    if (key.name === 'right') { if (cursor < buffer.length) { cursor++; render() } return }
    if (key.name === 'home') { cursor = lineStart(); render(); return }
    if (key.name === 'end') { cursor = lineEnd(); render(); return }
    if (key.name === 'delete') { delForward(); render(); return }
    if (key.name === 'backspace') { backspace(); render(); return }

    // ---- 上/下方向键：历史 ----
    if (key.name === 'up') { loadHistory(-1); return }
    if (key.name === 'down') { loadHistory(1); return }

    // ---- 普通可打印字符（含中文，str 为完整字符）----
    if (str && !key.ctrl && !key.meta) {
      insert(str)
      render()
    }
  }

  input.on('keypress', onKeypress)

  function ask(q) {
    return new Promise((resolve) => {
      output.write('\n' + q + ' ')
      questioning = true
      questionResolve = resolve
      questionBuf = ''
    })
  }

  function start() {
    // 开启 bracketed paste mode，让粘贴内容被 \x1b[200~ … \x1b[201~ 包裹
    // （仅当 Node 内置 readline 能解析这两个标记时才开，否则改走突发兜底）
    if (output.isTTY && nodeSupportsBracketedPaste()) {
      output.write(PASTE_ON)
      pasteModeEnabled = true
    }
    showPrompt()
  }

  function dispose() {
    if (pasteModeEnabled) {
      try { output.write(PASTE_OFF) } catch {}
      pasteModeEnabled = false
    }
    try { input.setRawMode(false) } catch {}
    input.removeListener('keypress', onKeypress)
    input.removeListener('data', onData)
  }

  return { start, showPrompt, ask, dispose }
}
