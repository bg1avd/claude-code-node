/**
 * ANSI 清洗单元测试 — 修复"终端颜色泄漏"bug
 *
 * 场景：Bash 工具输出携带 ANSI 颜色（npm warning 黄色等）→ 入库/被模型复述 →
 * 原样写终端且序列被截断（只有开启无复位）→ 终端颜色永久卡死。
 *
 * 修复：工具结果/用户输入入库前、流式与最终输出前剥离 ANSI（stripAnsiCodes）；
 * 提示符显示前强制复位（multiline-input，TTY 下输出 \x1b[0m）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stripAnsiCodes, ensureAnsiReset } from '../utils/ansi.js'

test('stripAnsiCodes：剥离 SGR 颜色序列（黄色警告场景）', () => {
  const npmWarning = '\x1b[33mnpm warn deprecated foo@1.0.0\x1b[0m'
  assert.equal(stripAnsiCodes(npmWarning), 'npm warn deprecated foo@1.0.0')
})

test('stripAnsiCodes：剥离被截断的半个序列（截断切断场景，泄漏主因）', () => {
  // 截断把 "\x1b[33m..." 切成 "\x1b[3" —— 开启序列残留但永远没有复位
  const truncated = '正常文本\n\x1b[33m警告信息开头...（此处被截断）\x1b[3'
  const cleaned = stripAnsiCodes(truncated)
  assert.equal(cleaned.includes('\x1b'), false, '不应残留任何 ESC 字符')
  assert.ok(cleaned.includes('警告信息开头'))
})

test('stripAnsiCodes：剥离光标控制与 OSC 序列', () => {
  assert.equal(stripAnsiCodes('a\x1b[2Kb\x1b[1Ac'), 'abc')            // CSI 光标
  assert.equal(stripAnsiCodes('x\x1b]0;title\x07y'), 'xy')            // OSC + BEL
  assert.equal(stripAnsiCodes('x\x1b]8;;http://e\x1b\\y'), 'xy')      // OSC + ST
})

test('stripAnsiCodes：无 ANSI 时原样返回（快速路径）', () => {
  const plain = '普通文本\n第二行'
  assert.equal(stripAnsiCodes(plain), plain)
  assert.equal(stripAnsiCodes(''), '')
  assert.equal(stripAnsiCodes(undefined), undefined)
  assert.equal(stripAnsiCodes(null), null)
})

test('stripAnsiCodes：grep --color=always 的真实输出样例', () => {
  // grep --color=always 输出格式：ESC[01;31m ESC[K 匹配文本 ESC[m ESC[K
  const grepOut = '\x1b[01;31m\x1b[Ktest\x1b[m\x1b[K file.txt'
  assert.equal(stripAnsiCodes(grepOut), 'test file.txt')
})

test('ensureAnsiReset：有 SGR 无复位 → 补 \\x1b[0m', () => {
  assert.equal(ensureAnsiReset('\x1b[33m黄色文本'), '\x1b[33m黄色文本\x1b[0m')
})

test('ensureAnsiReset：已复位 / 无 ANSI / 普通单词结尾不误补', () => {
  assert.equal(ensureAnsiReset('\x1b[33m黄\x1b[0m'), '\x1b[33m黄\x1b[0m')
  assert.equal(ensureAnsiReset('plain'), 'plain')
  assert.equal(ensureAnsiReset('system'), 'system', '以 m 结尾的普通单词不应误补')
  assert.equal(ensureAnsiReset('item'), 'item')
  assert.equal(ensureAnsiReset(null), null)
})

test('query-engine 工具结果入库剥离：模拟 Bash 返回带色输出', async () => {
  // 直接验证入库路径使用的函数行为一致（入库代码 query-engine.js 调 stripAnsiCodes）
  const bashResult = { toolCallId: 't1', content: '\x1b[33mwarning: deprecated\x1b[0m\nexit 0', isError: false }
  const clean = stripAnsiCodes(bashResult.content)
  assert.equal(clean, 'warning: deprecated\nexit 0')
  assert.ok(!clean.includes('\x1b'))
})
