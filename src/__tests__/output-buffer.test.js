/**
 * 有界输出缓冲 测试（v3.6.17）
 *
 * 背景（真实崩溃）：
 *   Bash 工具用 `stdout += data.toString()` 无界累积。命令输出极大时字符串超过
 *   V8 上限，抛 `RangeError: Invalid string length` —— 而且它**在 'data' 回调里
 *   抛出 → 未捕获异常 → 整个 cc-node 进程当场崩溃**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBoundedOutput } from '../utils/output-buffer.js'

test('小输出：原样保留，不加任何截断标记', () => {
  const b = createBoundedOutput({ headBytes: 100, tailBytes: 100 })
  b.push('hello ')
  b.push('world')
  b.flush()
  assert.equal(b.toString(), 'hello world')
  assert.equal(b.truncated, false)
})

test('超长输出：不抛异常，保留头+尾，中间标记省略字符数', () => {
  const b = createBoundedOutput({ headBytes: 100, tailBytes: 100 })
  b.push('A'.repeat(5000))
  b.push('Z'.repeat(5000))
  b.flush()
  const s = b.toString()

  assert.ok(s.length < 1000, `结果必须有界，实际 ${s.length}`)
  assert.ok(s.startsWith('A'), '应保留开头')
  assert.ok(s.endsWith('Z'), '应保留结尾（报错信息通常在这里）')
  assert.match(s, /已省略中间 \d+ 个字符/, '必须有明确的省略标记')
  assert.equal(b.truncated, true)
})

test('超长输出：真实省略字符数与标记一致', () => {
  const b = createBoundedOutput({ headBytes: 10, tailBytes: 10 })
  b.push('x'.repeat(100))
  b.flush()
  const m = b.toString().match(/省略中间 (\d+) 个字符/)
  assert.ok(m, '应有省略标记')
  assert.equal(Number(m[1]), 100 - 20, '省略数 = 总字符数 - 保留数')
})

test('跨 chunk 的多字节 UTF-8 不会被截成乱码（StringDecoder）', () => {
  const b = createBoundedOutput({ headBytes: 1000, tailBytes: 1000 })
  const buf = Buffer.from('中文测试', 'utf8')
  // 故意在汉字中间切开
  b.push(buf.subarray(0, 4))
  b.push(buf.subarray(4))
  b.flush()
  assert.equal(b.toString(), '中文测试', '不得出现 U+FFFD 替换字符')
  assert.ok(!b.toString().includes('\uFFFD'))
})

test('单个超大 chunk 也不会击穿头部上限', () => {
  const b = createBoundedOutput({ headBytes: 50, tailBytes: 50 })
  b.push('q'.repeat(1_000_000))
  b.flush()
  assert.ok(b.toString().length < 500, `必须严格有界，实际 ${b.toString().length}`)
})

test('反复推送海量数据不会抛异常（模拟日志刷屏）', () => {
  const b = createBoundedOutput({ headBytes: 1024, tailBytes: 1024 })
  assert.doesNotThrow(() => {
    for (let i = 0; i < 20000; i++) b.push(Buffer.from('log line ' + i + '\n'))
    b.flush()
  })
  const s = b.toString()
  assert.ok(s.length < 10000, '内存必须保持有界')
  assert.match(s, /已省略中间/)
})

test('push(null/undefined) 安全', () => {
  const b = createBoundedOutput()
  assert.doesNotThrow(() => { b.push(null); b.push(undefined); b.flush() })
  assert.equal(b.toString(), '')
})
