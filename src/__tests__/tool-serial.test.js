/**
 * 工具执行顺序性 测试 —— 回归「并行执行工具调用」带来的隐式依赖错乱 / 同一文件并发读写
 *
 * 根因：_executeToolCalls 阶段2 曾用 Promise.all 并行执行一批工具调用，
 * 导致「先 Write 再 Bash 跑它」「先读后写同一文件」等隐式依赖被打乱，
 * 且同一文件被并发读写（丢编辑 / 文件残片）。现已改为**按顺序串行**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { QueryEngine } from '../core/query-engine.js'
import { ToolCall } from '../types/index.js'

/** 构造一个只够跑 _executeToolCalls 的最小假引擎 */
function makeEngine(tools, cwd) {
  return {
    permissionChecker: { check: async () => ({ allowed: true }) },
    config: { tools, cwd, onConfirmTool: null, readline: null },
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('_executeToolCalls：串行保序 —— 后一个工具能看到前一个的写入', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ccn-serial-'))
  const file = join(dir, 'x.txt')

  const tools = [
    {
      name: 'W',
      handler: async (input) => {
        await sleep(20) // 故意慢一点，并行执行时必然踩踏
        await writeFile(input.file_path, 'HELLO')
        return 'wrote'
      },
    },
    {
      name: 'R',
      handler: async (input) => {
        const c = await readFile(input.file_path, 'utf8')
        return 'read:' + c
      },
    },
  ]
  const calls = [
    new ToolCall('1', 'W', { file_path: file }),
    new ToolCall('2', 'R', { file_path: file }),
  ]

  const results = await QueryEngine.prototype._executeToolCalls.call(makeEngine(tools, dir), calls)
  assert.equal(results.length, 2)
  assert.equal(results[0].content, 'wrote')
  assert.equal(results[1].content, 'read:HELLO', '后一个工具应读到前一个的写入（说明串行且保序）')
})

test('_executeToolCalls：第二个工具不会先于第一个开始', async () => {
  const order = []
  const tools = [
    { name: 'A', handler: async () => { order.push('a-start'); await sleep(25); order.push('a-end'); return 'a' } },
    { name: 'B', handler: async () => { order.push('b'); return 'b' } },
  ]
  const calls = [new ToolCall('1', 'A', {}), new ToolCall('2', 'B', {})]
  await QueryEngine.prototype._executeToolCalls.call(makeEngine(tools, process.cwd()), calls)
  assert.ok(order.indexOf('b') > order.indexOf('a-end'), 'B 应在 A 结束后才开始: ' + order.join(' '))
})

test('_executeToolCalls：出错的那个不中断后续，且结果按原顺序返回', async () => {
  const tools = [
    { name: 'OK', handler: async () => 'ok1' },
    { name: 'BOOM', handler: async () => { throw new Error('boom') } },
    { name: 'OK2', handler: async () => 'ok2' },
  ]
  const calls = [
    new ToolCall('1', 'OK', {}),
    new ToolCall('2', 'BOOM', {}),
    new ToolCall('3', 'OK2', {}),
  ]
  const results = await QueryEngine.prototype._executeToolCalls.call(makeEngine(tools, process.cwd()), calls)
  assert.equal(results.length, 3)
  assert.equal(results[0].content, 'ok1')
  assert.equal(results[1].isError, true)
  assert.match(results[1].content, /boom/)
  assert.equal(results[2].content, 'ok2')
})
