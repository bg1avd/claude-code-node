// ============================================================
//  headpiece.js — CC-Node 启动头标（独立模块）
// ------------------------------------------------------------
//  只负责「头标」的绘制与配色，与 CLI 框架解耦。
//  以后要替换/升级头标，只需修改本文件并保持接口不变即可。
//
//  头标内容: CC-NODE 艺术字
//    CC   : 两个 C, 10列宽 x 4行高 (扁平, 蓝渐变)
//    NODE : 四个字母, 5列宽 x 4行高 (绿渐变)
//    上下严格对齐 (20列 x 8行)
//
//  接口:
//    renderHeadpiece({ colWidth = 24 } = {})
//      -> { lines: string[], height: number, width: number }
//         lines   已上色、并已居中填充到 colWidth 宽度的行数组
//         height  头标实际行数（未填充前的原始行数）
//         width   头标原始可见宽度
// ============================================================

// ---- 头标原始数据（20列 x 8行）----
// CC 部分（蓝渐变, 4行）
const CC = [
  '╔════════╗╔════════╗',
  '██║       ██║       ',
  '██║       ██║       ',
  '╚════════╝╚════════╝',
]

// NODE 部分（绿渐变, 4行）
const NODE = [
  '╔╗╔═╗╔═══╗╔═══╗╔═══╗',
  '║║║ ║║   ║║   ║║   ║',
  '║╚╝ ║║   ║║   ║╠═══╣',
  '╚═══╝╚═══╝╚═══╝╚═══╝',
]

// ---- 配色（渐变）----
// CC 蓝色渐变（深 → 浅）
const BLUE = [81, 75, 69, 63]
// NODE 绿色渐变（深 → 浅）
const GREEN = [82, 118, 154, 190]

// 给每一行按对应色号上色
function colorize(lines, colors) {
  return lines.map((line, i) => `\x1b[38;5;${colors[i]}m${line}\x1b[0m`)
}

// 去掉 ANSI 转义码，返回真实可见长度
function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, '')
}

/**
 * 渲染头标。
 * @param {Object} [opts]
 * @param {number} [opts.colWidth=24] 目标列宽（用于居中填充，须 >= 头标宽度）
 * @returns {{ lines: string[], height: number, width: number }}
 */
export function renderHeadpiece({ colWidth = 24 } = {}) {
  // 1. 原始可见宽度
  const width = stripAnsi(CC[0]).length // 20

  // 2. 合并 CC + NODE，分别上色
  const rawLines = [...colorize(CC, BLUE), ...colorize(NODE, GREEN)]
  const height = rawLines.length // 8

  // 3. 在 colWidth 内居中填充（若 colWidth < width 则不做填充，原样返回）
  if (colWidth <= width) {
    return { lines: rawLines, height, width }
  }

  const totalPad = colWidth - width
  const leftPad = Math.floor(totalPad / 2)
  const rightPad = totalPad - leftPad

  const lines = rawLines.map((line) => {
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
