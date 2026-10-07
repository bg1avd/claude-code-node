/**
 * 文件级串行锁 测试 —— 回归「同一文件被并发读写 → 编辑丢失 / 文件损坏」
 *
 * 根因：引擎 _executeToolCalls 阶段2 用 Promise.all 并行执行一批工具调用；
 * 同一轮对同一文件发多个 Edit/Write 会并发踩踏（并发 writeFile 的 open('w')+write 交错，
 * 导致较短写入只覆盖前半段、较长写入的尾部残留 → "文件尾部多出残片" + 编辑丢失）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { withFileLock } from '../utils/file-lock.js'
import { fileEditTool } from '../tools/file-edit.js'
import { fileWriteTool } from '../tools/file-write.js'

async function tmp(p) {
  return mkdtemp(join(tmpdir(), p))
}

test('withFileLock：同 key 串行；不同 key 互不阻塞', async () => {
  const log = []
  const mk = (k, n, d) =>
    withFileLock(k, async () => {
      log.push(`s${n}`)
      await new Promise((r) => setTimeout(r, d))
      log.push(`e${n}`)
    })
  await Promise.all([mk('a', 1, 25), mk('a', 2, 5), mk('b', 3, 5)])
  const i1 = log.indexOf('s1')
  const e1 = log.indexOf('e1')
  const s2 = log.indexOf('s2')
  assert.ok(i1 !== -1 && e1 !== -1 && s2 !== -1, '日志缺失: ' + log.join(' '))
  assert.ok(i1 < e1 && e1 < s2, '同 key 未串行: ' + log.join(' '))
})

test('回归：并发 Edit 同一文件 —— 每处改动都必须生效（不丢编辑）', async () => {
  const dir = await tmp('ccn-lock-')
  const file = join(dir, 'f.txt')
  const N = 20
  await writeFile(file, Array.from({ length: N }, (_, i) => `line-${i} = 0`).join('\n') + '\n', 'utf8')

  // 模拟引擎阶段2：同一轮对同一文件并发发 N 个 Edit
  await Promise.all(
    Array.from({ length: N }, (_, i) =>
      fileEditTool.handler(
        { file_path: file, old_string: `line-${i} = 0`, new_string: `line-${i} = 1` },
        { cwd: dir },
      ),
    ),
  )

  const out = await readFile(file, 'utf8')
  const applied = (out.match(/= 1$/gm) || []).length
  assert.equal(applied, N, `期望 ${N} 处全部改成功，实际 ${applied}`)
})

test('回归：并发 Write + Edit 同一文件 —— 结果单一来源，无字节交错残片', async () => {
  const dir = await tmp('ccn-lock2-')
  const file = join(dir, 'g.txt')
  await writeFile(file, 'A'.repeat(100) + '\n', 'utf8')

  await Promise.all([
    fileWriteTool.handler({ file_path: file, content: 'X'.repeat(50) + '\n' }, { cwd: dir }),
    fileEditTool.handler({ file_path: file, old_string: 'A'.repeat(100), new_string: 'B'.repeat(100) }, { cwd: dir }),
  ])

  const out = await readFile(file, 'utf8')
  const ok = out === 'X'.repeat(50) + '\n' || out === 'B'.repeat(100) + '\n'
  assert.ok(ok, `并发写产生了交错残片: len=${out.length} head=${JSON.stringify(out.slice(0, 80))}`)
})
