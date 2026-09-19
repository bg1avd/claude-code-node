/**
 * ANSI 转义序列清洗
 *
 * 背景（泄漏 bug）：Bash 等工具的输出可能携带 ANSI 颜色序列（npm warning 黄色、
 * grep --color、git 等），这些序列会随消息历史进入模型上下文，再被流式/最终
 * 输出原样写回终端。若序列被截断逻辑（trimToolResults/compact）拦腰切断，
 * 只有「开启颜色」没有「复位」，终端颜色状态卡死 —— 此后所有输出都停留在
 * 那个颜色上（例如黄色），直到手动 reset。
 *
 * 修复策略（双层）：
 *   1. stripAnsiCodes() — 入库前/回显前直接剥离 ANSI 序列：
 *      对模型毫无意义（纯浪费 token），对终端则是污染源。
 *   2. cli.js 的提示符显示前写入一次 reset（最后一道防线，见 multiline-input）。
 */

// CSI 序列：ESC [ 参数字母（SGR 颜色 m、光标移动 ABCDJK 等）
// OSC 序列：ESC ] ... BEL 或 ESC \（终端标题、超链接等）
const ANSI_CSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]/g
const ANSI_OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
// 单独出现的 ESC 后跟其他字符（残留的半个序列，如被截断的 "\x1b[3"）
const ANSI_STRAY_ESC_RE = /\x1b(?![\[][0-9;?]*[a-zA-Z])(?!\][^\x07\x1b]*(?:\x07|\x1b\\))/g

/**
 * 剥离文本中的全部 ANSI 转义序列（SGR 颜色/光标控制/OSC/残留 ESC）
 * @param {string} text
 * @returns {string}
 */
export function stripAnsiCodes(text) {
  if (typeof text !== 'string') return text
  if (!text.includes('\x1b')) return text // 快速路径：绝大多数输出无 ANSI
  return text
    .replace(ANSI_CSI_RE, '')
    .replace(ANSI_OSC_RE, '')
    .replace(ANSI_STRAY_ESC_RE, '')
}

/**
 * 确保文本结尾复位所有 SGR 属性（保留内部样式，仅在未复位时补 \x1b[0m）。
 * 用于「想保留模型有意的样式」但必须防止颜色泄漏到后续输出的场景。
 * @param {string} text
 * @returns {string}
 */
export function ensureAnsiReset(text) {
  if (typeof text !== 'string' || !text.includes('\x1b')) return text
  // 文本含 SGR 序列但结尾不是复位 → 补一个复位，防止样式泄漏到后续输出
  if (/\x1b\[[0-9;?]*m/.test(text) && !/\x1b\[0m\s*$/.test(text)) {
    return text + '\x1b[0m'
  }
  return text
}
