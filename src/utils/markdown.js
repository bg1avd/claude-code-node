/**
 * Markdown → Telegram 格式工具（发送端"富格式标记"）
 *
 * 背景（2026-10）：
 *   - Bot API 10.1 起支持 Rich Messages：`sendRichMessage` 可直接吃 Markdown(GFM)，
 *     表格/标题/列表/引用/脚注/公式原生渲染，单条上限 32768 字符。
 *   - 旧的 `sendMessage` + `parse_mode:'HTML'` **不认识 Markdown**，必须先把
 *     Markdown 转成 Telegram 允许的 HTML 子集，否则用户看到的是 `**粗体**` 源码。
 *
 * 本模块提供三个纯函数（零依赖、易单测）：
 *   - escapeHtml(s)                HTML 转义（& < >）
 *   - markdownToTelegramHtml(md)   降级用：Markdown → Telegram HTML 子集
 *   - splitMarkdown(text, maxLen)  安全分片（代码围栏内不切）
 *
 * 说明：Telegram HTML 子集**没有表格/列表/标题标签**，所以降级路径下：
 *   - 标题 → <b>
 *   - 列表 → "• / 1." 纯文本
 *   - 表格 → <pre> 等宽对齐（伪表格）
 * 真正的表格渲染只走 Rich Messages（sendRichMessage）。
 */

/** 富消息单条上限（UTF-8 字符） */
export const RICH_MAX_LEN = 32768
/** 旧接口 sendMessage 单条上限 */
export const CLASSIC_MAX_LEN = 4096
/** 降级为 HTML 时的安全分片长度（给标签膨胀 + 分片头留余量） */
export const CLASSIC_CHUNK = 3500

/** HTML 转义（Telegram HTML 只把 & < > 视为特殊字符） */
export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

const FENCE_RE = /^\s*```/
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const HR_RE = /^\s*([-*_])\1{2,}\s*$/
const QUOTE_RE = /^\s*>\s?(.*)$/
const UL_RE = /^\s*[-*+]\s+(.*)$/
const OL_RE = /^\s*(\d+)[.)]\s+(.*)$/

/** 表格行：以 | 开头且（去掉首尾空后）含 | */
function isTableRow(line) {
  const t = line.trim()
  return t.startsWith('|') && t.length > 1
}

/** 表格分隔行：|:--|--:| 之类 */
function isTableSeparator(line) {
  if (!isTableRow(line)) return false
  const cells = splitTableRow(line)
  return cells.length > 0 && cells.every(c => /^:?-{2,}:?$/.test(c.replace(/\s/g, '')))
}

function splitTableRow(line) {
  let t = line.trim()
  if (t.startsWith('|')) t = t.slice(1)
  if (t.endsWith('|')) t = t.slice(0, -1)
  return t.split('|').map(c => c.trim())
}

function tableAligns(sepLine) {
  return splitTableRow(sepLine).map(c => {
    const s = c.replace(/\s/g, '')
    if (s.startsWith(':') && s.endsWith(':')) return 'center'
    if (s.endsWith(':')) return 'right'
    return 'left'
  })
}

/** 表格 → <pre> 等宽对齐的伪表格（降级用） */
function renderTablePre(rows, aligns) {
  const cols = Math.max(...rows.map(r => r.length))
  const norm = rows.map(r => {
    const a = r.slice(0, cols)
    while (a.length < cols) a.push('')
    return a
  })
  const widths = []
  for (let c = 0; c < cols; c++) {
    widths[c] = Math.max(...norm.map(r => [...stripInline(r[c])].length))
  }
  const lines = norm.map(r => r.map((cell, c) => {
    const txt = stripInline(cell)
    const pad = Math.max(0, widths[c] - [...txt].length)
    const a = aligns[c] || 'left'
    if (a === 'right') return ' '.repeat(pad) + txt
    if (a === 'center') {
      const l = Math.floor(pad / 2)
      return ' '.repeat(l) + txt + ' '.repeat(pad - l)
    }
    return txt + ' '.repeat(pad)
  }).join(' | '))
  return lines.join('\n')
}

/** 去掉行内 markdown 标记（表格降级成纯文本时用） */
function stripInline(s) {
  return String(s ?? '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
}

/** 行内 Markdown → Telegram HTML（输入须已 escapeHtml） */
function inline(s) {
  let t = escapeHtml(s)
  // 行内代码优先抽出，避免被后续规则误伤
  const codes = []
  t = t.replace(/`([^`\n]+)`/g, (_m, c) => {
    codes.push(c)
    return `\u0000I${codes.length - 1}\u0000`
  })
  // 图片 → 链接（放在普通链接之前，避免残留 !）
  t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt, url) =>
    `<a href="${url.replace(/"/g, '&quot;')}">${alt || '🖼'}</a>`)
  // 链接
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, txt, url) =>
    `<a href="${url.replace(/"/g, '&quot;')}">${txt}</a>`)
  // 删除线
  t = t.replace(/~~(.+?)~~/g, '<s>$1</s>')
  // 粗体
  t = t.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
  t = t.replace(/(^|[^\w_])__(.+?)__(?![\w_])/g, '$1<b>$2</b>')
  // 斜体（避免误伤 a*b*c / snake_case）
  t = t.replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\*)/g, '$1<i>$2</i>')
  t = t.replace(/(^|[^\w_])_(?!\s)([^_\n]+?)_(?![\w_])/g, '$1<i>$2</i>')
  // 还原行内代码
  t = t.replace(/\u0000I(\d+)\u0000/g, (_m, i) => `<code>${codes[+i]}</code>`)
  return t
}

/** 解析为块序列（代码块 / 表格 / 引用 / 列表 / 普通行） */
function parseBlocks(src) {
  const lines = src.split('\n')
  const blocks = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    // 围栏代码块
    if (FENCE_RE.test(line)) {
      const buf = []
      i++
      while (i < lines.length && !FENCE_RE.test(lines[i])) { buf.push(lines[i]); i++ }
      if (i < lines.length) i++ // 跳过收尾围栏
      blocks.push({ type: 'code', content: buf.join('\n') })
      continue
    }

    // 表格
    if (isTableRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const rows = [splitTableRow(line)]
      const aligns = tableAligns(lines[i + 1])
      i += 2
      while (i < lines.length && isTableRow(lines[i])) { rows.push(splitTableRow(lines[i])); i++ }
      blocks.push({ type: 'table', rows, aligns })
      continue
    }

    // 引用块（合并连续行）
    if (QUOTE_RE.test(line)) {
      const buf = []
      while (i < lines.length && QUOTE_RE.test(lines[i])) { buf.push(lines[i].match(QUOTE_RE)[1]); i++ }
      blocks.push({ type: 'quote', lines: buf })
      continue
    }

    // 列表（合并连续行）
    if (UL_RE.test(line) || OL_RE.test(line)) {
      const items = []
      while (i < lines.length) {
        const ul = lines[i].match(UL_RE)
        const ol = lines[i].match(OL_RE)
        if (ul) { items.push({ label: '•', text: ul[1] }); i++; continue }
        if (ol) { items.push({ label: `${ol[1]}.`, text: ol[2] }); i++; continue }
        break
      }
      blocks.push({ type: 'list', items })
      continue
    }

    blocks.push({ type: 'text', text: line })
    i++
  }
  return blocks
}

/**
 * Markdown → Telegram HTML 子集（降级路径用）
 * 覆盖面：标题、粗/斜/删除线、行内代码、围栏代码、链接、图片、引用、列表、分隔线、表格(→pre)
 */
export function markdownToTelegramHtml(md) {
  if (md == null) return ''
  const src = String(md).replace(/\r\n?/g, '\n')
  const out = []
  for (const b of parseBlocks(src)) {
    switch (b.type) {
      case 'code':
        out.push(`<pre><code>${escapeHtml(b.content)}</code></pre>`)
        break
      case 'table':
        out.push(`<pre>${escapeHtml(renderTablePre(b.rows, b.aligns))}</pre>`)
        break
      case 'quote':
        out.push(`<blockquote>${b.lines.map(inline).join('\n')}</blockquote>`)
        break
      case 'list':
        out.push(b.items.map(it => `${it.label} ${inline(it.text)}`).join('\n'))
        break
      default: {
        const h = b.text.match(HEADING_RE)
        if (h) { out.push(`<b>${inline(h[2])}</b>`); break }
        if (HR_RE.test(b.text)) { out.push('────────────'); break }
        out.push(inline(b.text))
      }
    }
  }
  return out.join('\n')
}

/**
 * 安全分片：按行切，**把围栏代码块当作整体单元**（能容纳时绝不切断）。
 * 单行或超大代码块无法容纳时才硬切。
 * @param {string} text
 * @param {number} maxLen 每片最大字符数（按 Unicode 码点计）
 * @returns {string[]}
 */
export function splitMarkdown(text, maxLen = RICH_MAX_LEN) {
  const s = String(text ?? '')
  if ([...s].length <= maxLen) return [s]

  const lines = s.split('\n')
  const parts = []
  let cur = []
  let curLen = 0
  const push = (line) => { cur.push(line); curLen += [...line].length + 1 }
  const flush = () => { if (cur.length) { parts.push(cur.join('\n')); cur = []; curLen = 0 } }

  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    // 围栏代码块：整体取出，必要时先换片，保证不被拦腰切断
    if (FENCE_RE.test(line)) {
      const block = [line]
      let j = i + 1
      while (j < lines.length && !FENCE_RE.test(lines[j])) { block.push(lines[j]); j++ }
      if (j < lines.length) { block.push(lines[j]); j++ } // 收尾围栏
      const blockLen = block.reduce((n, l) => n + [...l].length + 1, 0)
      if (cur.length && curLen + blockLen > maxLen) flush()
      for (const l of block) push(l)
      i = j
      continue
    }

    const lineLen = [...line].length + 1
    if (cur.length && curLen + lineLen > maxLen) flush()
    push(line)
    i++
  }
  flush()

  // 二次硬切：仅当某片仍超长（超大代码块 / 超长单行）
  const out = []
  for (const p of parts) {
    const arr = [...p]
    if (arr.length <= maxLen) { out.push(p); continue }
    let rest = arr
    while (rest.length > maxLen) { out.push(rest.slice(0, maxLen).join('')); rest = rest.slice(maxLen) }
    if (rest.length) out.push(rest.join(''))
  }
  return out
}
