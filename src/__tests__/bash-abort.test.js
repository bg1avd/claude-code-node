/**
 * Bash 工具「可中断」测试
 *
 * 用户 /stop 时，正在跑的长命令必须立即终止（否则要等命令自然结束或超时）。
 * 实现：Bash handler 监听 ctx.signal，abort 时 SIGTERM→SIGKILL 子进程，
 *       并返回 [已中断…] 而不是超时/正常输出。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bashTool } from '../tools/bash.js'

test('Bash：正常执行返回输出', async () => {
  const out = await bashTool.handler({ command: 'echo hello' }, { cwd: process.cwd() })
  assert.match(out, /hello/)
})

test('Bash：执行中 abort → 立即终止进程并返回中断标记', async () => {
  const ctrl = new AbortController()
  const started = Date.now()
  // 睡眠 30 秒；若不响应中断，测试会一直挂着
  const p = bashTool.handler({ command: 'sleep 30', timeout: 60 }, { cwd: process.cwd(), signal: ctrl.signal })
  setTimeout(() => ctrl.abort(), 100)
  const out = await p
  const elapsed = Date.now() - started
  assert.match(out, /已中断/, '应返回中断标记')
  assert.ok(elapsed < 5000, `应在中断后迅速返回（实际 ${elapsed}ms）`)
})

test('Bash：传入已 abort 的 signal → 不执行直接返回中断', async () => {
  const ctrl = new AbortController()
  ctrl.abort()
  const out = await bashTool.handler({ command: 'echo never' }, { cwd: process.cwd(), signal: ctrl.signal })
  assert.match(out, /已中断/)
  assert.doesNotMatch(out, /never/)
})

test('Bash：无 signal（旧调用方）仍照常工作', async () => {
  const out = await bashTool.handler({ command: 'echo ok-nosignal' }, { cwd: process.cwd() })
  assert.match(out, /ok-nosignal/)
})
