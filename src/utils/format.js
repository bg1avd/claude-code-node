/**
 * 输出格式化工具
 * 对应原版: src/utils/format.ts + src/outputStyles/
 */

/**
 * ANSI 颜色码
 */
const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
}

/** 是否支持颜色 */
const supportsColor = process.stdout?.isTTY && !process.env.NO_COLOR

function color(code, text) {
  return supportsColor ? `${code}${text}${ANSI.reset}` : text
}

export const format = {
  bold: (t) => color(ANSI.bold, t),
  dim: (t) => color(ANSI.dim, t),
  red: (t) => color(ANSI.red, t),
  green: (t) => color(ANSI.green, t),
  yellow: (t) => color(ANSI.yellow, t),
  blue: (t) => color(ANSI.blue, t),
  cyan: (t) => color(ANSI.cyan, t),
  gray: (t) => color(ANSI.gray, t),
  magenta: (t) => color(ANSI.magenta, t),
}

/**
 * 格式化代码块
 */
export function codeBlock(code, lang = '') {
  return `\`\`\`${lang}\n${code}\n\`\`\``
}

/**
 * 格式化文件路径
 */
export function formatPath(path) {
  return format.cyan(path)
}

/**
 * 格式化工具调用
 */
export function formatToolCall(name, input) {
  const inputStr = typeof input === 'string' ? input : JSON.stringify(input, null, 2)
  const shortInput = inputStr.length > 200 ? inputStr.slice(0, 200) + '...' : inputStr
  return `${format.bold(format.magenta(name))}(${format.dim(shortInput)})`
}

/**
 * 格式化工具结果
 */
export function formatToolResult(name, result, isError = false) {
  const icon = isError ? format.red('✗') : format.green('✓')
  const shortResult = result.length > 300 ? result.slice(0, 300) + '...' : result
  return `${icon} ${format.bold(name)}: ${shortResult}`
}

/**
 * 格式化 token 用量
 */
export function formatTokenUsage(used, total) {
  const percent = Math.round((used / total) * 100)
  const bar = progressBar(percent, 20)
  const colorFn = percent > 90 ? format.red : percent > 70 ? format.yellow : format.green
  return `Tokens: ${colorFn(bar)} ${used.toLocaleString()}/${total.toLocaleString()} (${percent}%)`
}

/**
 * 进度条
 */
export function progressBar(percent, width = 30) {
  const filled = Math.round((percent / 100) * width)
  const empty = width - filled
  return '█'.repeat(filled) + '░'.repeat(empty)
}

/**
 * 格式化时间
 */
export function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  const min = Math.floor(ms / 60000)
  const sec = Math.round((ms % 60000) / 1000)
  return `${min}m ${sec}s`
}

/**
 * 格式化字节数
 */
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

/**
 * 表格格式化
 */
export function formatTable(headers, rows) {
  const colWidths = headers.map((h, i) => {
    const maxDataLen = Math.max(...rows.map(r => String(r[i]).length), 0)
    return Math.max(h.length, maxDataLen)
  })

  const headerLine = headers.map((h, i) => h.padEnd(colWidths[i])).join(' | ')
  const separator = colWidths.map(w => '─'.repeat(w)).join('─┼─')
  const dataLines = rows.map(row =>
    row.map((cell, i) => String(cell).padEnd(colWidths[i])).join(' | ')
  )

  return [headerLine, separator, ...dataLines].join('\n')
}
