/**
 * 有界输出缓冲 —— 防止子进程/网络流的海量输出把字符串撑爆。
 *
 * 为什么需要（v3.6.17 修复的真实崩溃）：
 *   Bash 工具用 `stdout += data.toString()` 无界累积。当命令输出极大
 *   （cat 大文件、日志疯狂刷屏、程序死循环打印……）时，字符串会超过 V8 的
 *   上限（约 512MB），直接抛：
 *
 *     RangeError: Invalid string length
 *       at Socket.<anonymous> (src/tools/bash.js:96)
 *
 *   更糟的是它**在 'data' 事件回调里抛出 → 属于未捕获异常 → 整个 cc-node
 *   进程当场崩溃**（不是工具失败，是进程死）。
 *
 * 策略：保留「**头部 + 尾部**」，丢掉中间。
 *   - 头部：通常有命令回显、开头几条记录
 *   - 尾部：**报错信息几乎总在最后** ← 最重要的部分
 *   - 中间：重复的进度/日志行，信息密度最低
 * 截断后会在中间插入显式标记，告诉模型和用户"这里省略了 N 个字符"。
 *
 * 另外顺手用 StringDecoder 处理**跨 chunk 的多字节 UTF-8**（中文被切断
 * 会产生乱码 —— 原实现 `data.toString()` 每块独立解码就有这个毛病）。
 */
import { StringDecoder } from 'string_decoder'

/** 默认单流保留上限：头 1MB + 尾 1MB */
export const DEFAULT_HEAD_BYTES = 1024 * 1024
export const DEFAULT_TAIL_BYTES = 1024 * 1024

export function createBoundedOutput(options = {}) {
  const headLimit = options.headBytes ?? DEFAULT_HEAD_BYTES
  const tailLimit = options.tailBytes ?? DEFAULT_TAIL_BYTES

  let head = ''
  let tail = ''
  let totalLength = 0      // 累计收到的「字符」数（用于精确计算省略了多少）
  const decoder = new StringDecoder('utf8')

  function pushTail(s) {
    tail += s
    // 只保留最后 tailLimit 个字符；留 2 倍余量避免每次 data 都做大 slice（摊还 O(1)）
    if (tail.length > tailLimit * 2) {
      tail = tail.slice(-tailLimit)
    }
  }

  return {
    /** 追加一块输出（Buffer 或 string 均可） */
    push(chunk) {
      if (chunk == null) return
      const s = typeof chunk === 'string' ? chunk : decoder.write(chunk)
      if (!s) return
      totalLength += s.length

      if (head.length < headLimit) {
        const capacity = headLimit - head.length
        if (s.length <= capacity) {
          head += s
        } else {
          head += s.slice(0, capacity)
          pushTail(s.slice(capacity))
        }
      } else {
        pushTail(s)
      }
    },
    /** 取出当前内容（含截断标记）；可重复调用 */
    toString() {
      if (tail.length > tailLimit) tail = tail.slice(-tailLimit)
      const kept = head.length + tail.length
      if (totalLength <= kept) return head + tail
      const omitted = totalLength - kept
      return (
        head +
        `\n…[输出过长，已省略中间 ${omitted} 个字符（保留开头与结尾）]…\n` +
        tail
      )
    },
    /** 冲刷解码器尾部残留（流结束时调用一次） */
    flush() {
      const rest = decoder.end()
      if (rest) {
        totalLength += rest.length
        if (head.length < headLimit) head += rest
        else pushTail(rest)
      }
    },
    get truncated() {
      return totalLength > head.length + tail.length
    },
    get totalLength() {
      return totalLength
    },
  }
}
