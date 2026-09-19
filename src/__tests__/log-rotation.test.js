/**
 * 日志轮转单元测试
 *
 * 背景：cc-notify 的 log() 曾无限追加，~/.cc-node/cc-notify.log 涨到 5GB+/1 亿行。
 * 修复：rotateLogIfNeeded 超限时把当前日志改名 .1（旧 .1 直接覆盖）。
 *
 * 覆盖：
 *   - 超过阈值 → 轮转发生，原文件变 .1
 *   - 未超阈值 → 不轮转
 *   - 文件不存在 → 不轮转、不抛错
 *   - 已有旧 .1 → 轮转时被直接覆盖（磁盘占用封顶）
 *   - 轮转后可以继续写入新日志
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, readdir, stat, appendFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { existsSync } from 'fs'
import { rotateLogIfNeeded } from '../channel/notify-daemon.js'

async function makeTmpDir() {
  return mkdtemp(join(tmpdir(), 'ccn-logrotate-'))
}

test('超过阈值 → 轮转发生，原文件改名为 .1', async () => {
  const dir = await makeTmpDir()
  const logPath = join(dir, 'cc-notify.log')
  await writeFile(logPath, 'x'.repeat(100), 'utf-8')

  const rotated = rotateLogIfNeeded(logPath, 50) // 阈值 50 字节 < 100

  assert.equal(rotated, true)
  assert.equal(existsSync(logPath), false, '原日志应已被改名')
  assert.equal(existsSync(logPath + '.1'), true, '应存在 .1 归档')
  assert.equal(await readFile(logPath + '.1', 'utf-8'), 'x'.repeat(100))
})

test('未超阈值 → 不轮转', async () => {
  const dir = await makeTmpDir()
  const logPath = join(dir, 'cc-notify.log')
  await writeFile(logPath, 'x'.repeat(10), 'utf-8')

  const rotated = rotateLogIfNeeded(logPath, 50)

  assert.equal(rotated, false)
  assert.equal(existsSync(logPath), true, '原日志应保留')
  assert.equal(existsSync(logPath + '.1'), false, '不应产生 .1')
})

test('文件不存在 → 不轮转、不抛错', async () => {
  const dir = await makeTmpDir()
  const logPath = join(dir, 'not-exist.log')

  const rotated = rotateLogIfNeeded(logPath, 50)

  assert.equal(rotated, false)
})

test('已有旧 .1 → 轮转时被直接覆盖（磁盘占用封顶 2×阈值）', async () => {
  const dir = await makeTmpDir()
  const logPath = join(dir, 'cc-notify.log')
  await writeFile(logPath, 'NEW'.repeat(50), 'utf-8')      // 150 字节 > 100
  await writeFile(logPath + '.1', 'OLD-ARCHIVE', 'utf-8')  // 预置旧归档

  const rotated = rotateLogIfNeeded(logPath, 100)

  assert.equal(rotated, true)
  const archived = await readFile(logPath + '.1', 'utf-8')
  assert.equal(archived, 'NEW'.repeat(50), '旧 .1 应被新一轮转内容覆盖')
  assert.equal(archived.includes('OLD-ARCHIVE'), false)
})

test('轮转后可继续写入新日志（append 自动新建文件）', async () => {
  const dir = await makeTmpDir()
  const logPath = join(dir, 'cc-notify.log')
  await writeFile(logPath, 'x'.repeat(200), 'utf-8')

  rotateLogIfNeeded(logPath, 100)
  await appendFile(logPath, '[12:00:00] first line after rotate\n', 'utf-8')

  const content = await readFile(logPath, 'utf-8')
  assert.equal(content, '[12:00:00] first line after rotate\n')
  assert.equal((await stat(logPath + '.1')).size, 200)
})

test('阈值参数化生效（自定义小阈值触发）', async () => {
  const dir = await makeTmpDir()
  const logPath = join(dir, 'app.log')
  await writeFile(logPath, '12345', 'utf-8') // 5 字节

  assert.equal(rotateLogIfNeeded(logPath, 4), true, '5 > 4 应轮转')

  const logPath2 = join(dir, 'app2.log')
  await writeFile(logPath2, '12345', 'utf-8')
  assert.equal(rotateLogIfNeeded(logPath2, 5), false, '5 <= 5 不轮转')
})
