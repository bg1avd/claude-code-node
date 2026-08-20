// ============================================================
//  headpiece.js — CC-Node 启动头标（独立模块）
// ------------------------------------------------------------
//  只负责「头标」的绘制与配色，与 CLI 框架解耦。
//  以后要替换/升级头标，只需修改本文件并保持接口不变即可。
//
//  头标内容: CC-NODE 机械臂机器人艺术字（v2，取自 log/headpiece.js）
//    CC = 一对机械眼睛（带 ◉◉ 瞳孔，蓝渐变 5 行）
//    N  = 左臂，向左侧伸展 ──┼
//    O  = 圆形身体/躯干（白色）
//    D  = 右臂，向右侧伸展 ┼──
//    E  = 手持工具箱/锤子（黄色 ╔═══╗）
//    上下总宽 20 字符，总高 10 行，严格对齐
//
//  接口:
//    renderHeadpiece({ colWidth = 24 } = {})
//      -> { lines: string[], height: number, width: number }
//         lines   已上色、并已居中填充到 colWidth 宽度的行数组
//         height  头标实际行数（未填充前的原始行数）
//         width   头标原始可见宽度
// ============================================================

// ---- 头标原始数据（20列 x 10行）----
// CC 部分（机械眼睛，蓝渐变，5 行；每行统一右填充至 20 列保证对齐）
const CC = [
  '\x1b[38;5;81m    ╭────╮╭────╮\x1b[0m',
  '\x1b[38;5;75m    ╱ ◉◉ ╲╱ ◉◉ ╲\x1b[0m',
  '\x1b[38;5;69m   │ ◉◉  ││ ◉◉  │\x1b[0m',
  '\x1b[38;5;63m   │      ││      │\x1b[0m',
  '\x1b[38;5;57m    ╰────╯╰────╯\x1b[0m',
]

// NODE 部分（左臂绿 + 身体白 + 右臂绿 + 工具箱黄，5 行）
const NODE = [
  '\x1b[38;5;82m╱───┐\x1b[0m\x1b[38;5;15m┌───┐\x1b[0m\x1b[38;5;82m┌───╲\x1b[0m\x1b[38;5;220m╔═══╗\x1b[0m',
  '\x1b[38;5;118m│N  │\x1b[0m\x1b[38;5;15m│   │\x1b[0m\x1b[38;5;118m│D  │\x1b[0m\x1b[38;5;220m║   ║\x1b[0m',
  '\x1b[38;5;154m│   │\x1b[0m\x1b[38;5;15m│   │\x1b[0m\x1b[38;5;154m│   │\x1b[0m\x1b[38;5;220m╠═══╣\x1b[0m',
  '\x1b[38;5;190m──┼ │\x1b[0m\x1b[38;5;15m│   │\x1b[0m\x1b[38;5;190m│  ┼─\x1b[0m\x1b[38;5;220m║   ║\x1b[0m',
  '\x1b[38;5;226m╲───┘\x1b[0m\x1b[38;5;15m└───┘\x1b[0m\x1b[38;5;226m└───╱\x1b[0m\x1b[38;5;220m╚═══╝\x1b[0m',
]

// 合并全部行
const RAW_LINES = [...CC, ...NODE]

// ---- 配色工具 ----
function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, '')
}

/** 去掉尾部 ANSI reset 码，供拼接填充空格时保持颜色连续 */
function trimTrailingReset(s) {
  return s.replace(/\x1b\[0m\s*$/, '')
}

/**
 * 渲染头标。
 * @param {Object} [opts]
 * @param {number} [opts.colWidth=24] 目标列宽（用于居中填充，须 >= 头标宽度）
 * @returns {{ lines: string[], height: number, width: number }}
 */
export function renderHeadpiece({ colWidth = 24 } = {}) {
  // 1. 原始可见宽度（取最宽一行）
  const width = Math.max(...RAW_LINES.map(stripAnsi).map(s => s.length))
  const height = RAW_LINES.length // 10

  // 2. 逐行补齐到统一宽度 width（右填充空格，保证右边缘对齐；空格放 ANSI reset 之前）
  const padded = RAW_LINES.map((line) => {
    const plain = stripAnsi(line)
    const missing = width - plain.length
    if (missing <= 0) return line
    // 保留前导 ANSI 与尾部 reset：在 reset 前补空格
    const leadingAnsi = line.match(/^(\x1b\[[0-9;]*m)+/)?.[0] || ''
    const body = line.slice(leadingAnsi.length)
    const trailingAnsi = body.match(/(\x1b\[0m)+$/)?.[0] || ''
    const inner = body.slice(0, body.length - trailingAnsi.length)
    return leadingAnsi + inner + ' '.repeat(missing) + trailingAnsi
  })

  // 3. 在 colWidth 内居中填充（若 colWidth <= width 则不做填充，原样返回）
  if (colWidth <= width) {
    return { lines: padded, height, width }
  }

  const totalPad = colWidth - width
  const leftPad = Math.floor(totalPad / 2)
  const rightPad = totalPad - leftPad

  const lines = padded.map((line) => {
    const leadingAnsi = line.match(/^(\x1b\[[0-9;]*m)+/)?.[0] || ''
    const trailingAnsi = line.match(/(\x1b\[0m)+$/)?.[0] || '\x1b[0m'
    const plain = stripAnsi(line)
    return leadingAnsi + ' '.repeat(leftPad) + plain + ' '.repeat(rightPad) + trailingAnsi
  })

  return { lines, height, width }
}

// 允许命令行直接预览：node src/core/headpiece.js
const isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())
if (isDirectRun) {
  const { lines } = renderHeadpiece({ colWidth: 24 })
  console.log(`\n${lines.join('\n')}\n`)
}
