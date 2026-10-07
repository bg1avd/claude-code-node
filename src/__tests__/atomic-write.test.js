/**
 * 原子写 测试 —— `Write`/`Edit` 改为 tmp+rename 原子替换后的关键语义
 *
 * 目标：进程被强杀/断电时不再留下"截断的文件"；同时**不破坏**：
 *   - 文件权限（+x 不能丢）
 *   - 软链接语义（不能把符号链接换成普通文件）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, readdir, stat, symlink, lstat, chmod } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { atomicWriteFile } from '../utils/atomic-write.js'
import { fileEditTool } from '../tools/file-edit.js'
import { fileWriteTool } from '../tools/file-write.js'

async function tmp(p) {
  return mkdtemp(join(tmpdir(), p))
}

test('atomicWriteFile：写入正确 + 无 .tmp 残留', async () => {
  const dir = await tmp('ccn-aw-')
  const f = join(dir, 'a.txt')
  await atomicWriteFile(f, 'hello 世界')
  assert.equal(await readFile(f, 'utf8'), 'hello 世界')
  assert.deepEqual(await readdir(dir), ['a.txt'], '不应残留临时文件')
})

test('atomicWriteFile：覆盖已有文件且保留权限（+x 不丢）', async () => {
  const dir = await tmp('ccn-aw2-')
  const f = join(dir, 'run.sh')
  await writeFile(f, 'old', 'utf8')
  await chmod(f, 0o755)
  await atomicWriteFile(f, '#!/bin/sh\necho hi\n')
  assert.equal(await readFile(f, 'utf8'), '#!/bin/sh\necho hi\n')
  const m = (await stat(f)).mode & 0o777
  assert.equal(m, 0o755, '权限应保留 0755，实际 ' + m.toString(8))
})

test('atomicWriteFile：目标是符号链接 → 写真实目标，链接本身不被替换', async () => {
  const dir = await tmp('ccn-aw3-')
  const target = join(dir, 'real.txt')
  const link = join(dir, 'link.txt')
  await writeFile(target, 'orig', 'utf8')
  await symlink(target, link)
  await atomicWriteFile(link, 'via-link')
  assert.equal(await readFile(target, 'utf8'), 'via-link', '真实目标应被写入')
  assert.ok((await lstat(link)).isSymbolicLink(), '符号链接应保持不变')
})

test('集成：Edit 工具改文件后内容正确、无临时残留', async () => {
  const dir = await tmp('ccn-aw4-')
  const f = join(dir, 'e.txt')
  await writeFile(f, 'foo bar baz', 'utf8')
  const r = await fileEditTool.handler({ file_path: f, old_string: 'bar', new_string: 'BAR' }, { cwd: dir })
  assert.match(r, /Successfully edited/)
  assert.equal(await readFile(f, 'utf8'), 'foo BAR baz')
  assert.deepEqual(await readdir(dir), ['e.txt'])
})

test('集成：Write 工具写文件（自动创建父目录）', async () => {
  const dir = await tmp('ccn-aw5-')
  const f = join(dir, 'sub', 'deep', 'w.txt')
  const r = await fileWriteTool.handler({ file_path: f, content: 'x' }, { cwd: dir })
  assert.match(r, /Successfully wrote/)
  assert.equal(await readFile(f, 'utf8'), 'x')
})
