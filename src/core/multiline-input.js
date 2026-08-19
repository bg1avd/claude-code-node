// ============================================================
//  multiline-input.js — REPL 多行输入（读取完整输入再处理）
// ------------------------------------------------------------
//  解决「输入缓存未读完就按 \n 断句」的根因问题：
//    readline 的 line 事件遇到 \n 就提交当前行，导致多行文本
//    被拆成多段，且后续行在引擎忙时被丢弃。
//
//  本模块改用 keypress + raw mode 自己管理输入缓冲：
//    - Enter（\r / CR）                  → 提交整段输入（含内嵌换行）
//    - Ctrl+Enter / Alt+Enter / Ctrl+J  → 折行，累积到缓冲，不提交（多行输入）
//    - 可打印字符            → 回显并累积
//    - 退格                  → 删除并回显
//    - 上/下方向键            → 浏览输入历史
//    - Ctrl+C                → 清空 / 退出
//    - 非 TTY（管道/重定向）  → 回退到 readline line 事件
//
//  接口：
//    createMultilineInput({ prompt, onSubmit, onExit, stdin, stdout })
//      -> { start(), showPrompt(), ask(questionText), dispose() }
//         onSubmit(text)    完整输入（可能含 \n）提交回调
//         ask(qText)        单行问题收集（返回 Promise<string>）
// ============================================================

import * as readline from 'readline'

export function createMultilineInput({ prompt = '> ', onSubmit, onExit, stdin, stdout } = {}) {
  const input = stdin || process.stdin
  const output = stdout || process.stdout
  const isTTY = input.isTTY

  let inputBuffer = ''      // 当前多行输入缓冲
  let inputHistory = []     // 输入历史
  let historyIndex = -1     // 历史浏览索引（-1 = 编辑新输入）
  let skipNextLF = false    // CRLF 提交后忽略残留 \n
  let questioning = false   // 是否正在收集单行问题（权限确认等）
  let questionResolve = null
  let questionBuf = ''
  let escPending = false    // 刚收到独立 ESC 事件（某些终端把 Alt+Enter 拆成 ESC 和 Enter 两个事件）
  let escTimer = null       // ESC 后跟 Enter 的超时还原定时器

  const PROMPT = prompt
  let displayedRows = 0     // 当前输入区在终端实际占用的屏幕行数（含提示符行，考虑换行与CJK宽字符）

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
      const w = visibleWidth(segment)
      rows += Math.max(1, Math.ceil(w / c))
    }
    return rows
  }

  // 生成要显示的文本（提示符 + 输入缓冲；换行后按提示符宽度缩进）
  function displayText() {
    return PROMPT + inputBuffer.replace(/\n/g, '\n' + ' '.repeat(PROMPT.length))
  }

  // 清空并重绘整个输入区（保证回显稳定、光标不乱跳）
  //   - 先把光标移回输入区首行行首
  //   - 清到屏尾，重绘全部内容
  //   - 重绘后光标自然停在输入末尾
  function render() {
    // 上移到输入区首行（若是多行）；单行时不动
    if (displayedRows > 1) output.write(`\x1b[${displayedRows - 1}A`)
    output.write('\r')       // 回到首行行首
    output.write('\x1b[J')   // 清到屏尾

    const rendered = displayText()
    output.write(rendered)
    displayedRows = renderedRows(rendered)
  }

  function showPrompt() {
    output.write(PROMPT)
    displayedRows = 1
  }

  function submit() {
    const inputText = inputBuffer
    inputBuffer = ''
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

  function loadHistory(dir) {
    if (inputHistory.length === 0) return
    if (dir === -1) {
      if (historyIndex <= 0) { historyIndex = 0; inputBuffer = inputHistory[0]; render(); return }
      historyIndex--
    } else {
      if (historyIndex >= inputHistory.length) return
      historyIndex++
    }
    inputBuffer = historyIndex < inputHistory.length ? inputHistory[historyIndex] : ''
    render()
  }

  function onKeypress(str, key) {
    if (!key) return

    // 正在收集单行问题（权限确认 / AskUserQuestion）
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
      if (str && key.name !== 'enter') {
        questionBuf += str
        output.write(str)
      }
      return
    }

    // Ctrl+C
    if (key.ctrl && key.name === 'c') {
      if (inputBuffer) {
        inputBuffer = ''
        displayedRows = 0
        output.write('\n')
        showPrompt()
      } else {
        output.write('\nGoodbye!\n')
        if (onExit) onExit()
      }
      return
    }

    // ESC 键 — 单独出现（未与后续字符合并）时，标记 escPending，
    // 下一个 Enter 视为 Alt+Enter → 折行（兼容部分终端把 Alt+Enter 拆成两个事件）
    if (key.name === 'escape') {
      escPending = true
      // 清掉 pending 状态：若后续 300ms 无 Enter 则还原，避免误把普通 Enter 当折行
      if (escTimer) clearTimeout(escTimer)
      escTimer = setTimeout(() => { escPending = false }, 400)
      return
    }

    // Enter / 换行
    //
    // 提交 vs 折行判定：
    //   - 普通 Enter（\r，无 ctrl/meta）          → 提交整段输入
    //   - Ctrl+Enter（部分终端发送 ctrl+return）  → 折行（多行输入）
    //   - Alt+Enter / Esc+Enter（meta+return）    → 折行（跨终端可靠）
    //   - Ctrl+J / 字面 \n（key.name === enter）  → 折行
    //   - 某些终端的 Ctrl/Alt+Enter 发送 CSI 序列 \x1b[13~（key.name === 'f3'）→ 折行
    //
    // 注意：多数终端按下 Ctrl+Enter 发送的仍是 \r，与普通 Enter 无法区分，
    // 因此跨终端可靠的多行换行键是 Alt+Enter（Esc+Enter）和 Ctrl+J（\n）。两者都支持。
    if (key.name === 'return' || key.name === 'enter' || key.name === 'f3') {
      // 紧跟 ESC 的 Enter → 视为 Alt+Enter，折行
      if (escPending) {
        escPending = false
        if (escTimer) { clearTimeout(escTimer); escTimer = null }
        inputBuffer += '\n'
        render()
        return
      }
      // CSI 序列 \x1b[13~（某些终端的 Ctrl/Alt+Enter）→ 折行
      if (key.name === 'f3') {
        inputBuffer += '\n'
        render()
        return
      }
      if (key.name === 'enter') {
        // 字面换行 \n / Ctrl+J → 折行累积
        if (skipNextLF) { skipNextLF = false; return } // CRLF 残留 \n
        inputBuffer += '\n'
        render()
      } else {
        // key.name === 'return'（\r）
        if (key.ctrl || key.meta) {
          // Ctrl+Enter 或 Alt+Enter/Esc+Enter → 折行（多行输入）
          if (skipNextLF) { skipNextLF = false; return }
          inputBuffer += '\n'
          render()
        } else {
          submit() // 普通 Enter → 提交
        }
      }
      return
    }

    // 非 Enter 键输入会清除 escPending（ESC 后跟普通字符不是 Alt+Enter）
    if (escPending && str) {
      escPending = false
      if (escTimer) { clearTimeout(escTimer); escTimer = null }
    }

    // 退格
    if (key.name === 'backspace') {
      if (inputBuffer.length > 0) {
        inputBuffer = inputBuffer.slice(0, -1)
        render()
      }
      return
    }

    // 方向键上/下：历史
    if (key.name === 'up') { loadHistory(-1); return }
    if (key.name === 'down') { loadHistory(1); return }

    // 普通可打印字符（含中文，str 为完整字符）
    if (str && !key.ctrl && !key.meta) {
      inputBuffer += str
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

  function dispose() {
    try { input.setRawMode(false) } catch {}
    input.removeListener('keypress', onKeypress)
  }

  return { start: showPrompt, showPrompt, ask, dispose }
}
