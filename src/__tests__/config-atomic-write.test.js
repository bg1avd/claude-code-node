/**
 * 配置原子写单元测试
 *
 * 背景：Config 的保存方法曾直接 writeFile 覆盖目标文件，进程在写入中途
 * 崩溃/断电会留下截断的 JSON，导致配置损坏丢失。修复：atomicWriteFile
 * 先写同目录 .tmp-* 再 rename（同卷原子操作），migrate 写前另存 .bak。
 *
 * 覆盖：
 *   - saveToProject / saveKeyToUser 正常写入且无 .tmp-* 残留
 *   - saveKeyToUser 只改目标键，磁盘上其余键原样保留
 *   - migrateLegacyModelName：改名成功 + .bak 备份内容为旧值 + 无 tmp 残留
 *   - migrateLegacyModelName：非旧模型名/非官方 apiBase → 不动文件
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, readdir, mkdir } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { existsSync } from 'fs'
import { Config } from '../core/config.js'

async function makeTmpDir() {
  return mkdtemp(join(tmpdir(), 'ccn-atomic-'))
}

/** 列出目录里残留的 .tmp-* 文件 */
async function tmpResidues(dir) {
  const files = await readdir(dir)
  return files.filter(f => f.includes('.tmp-'))
}

test('saveToProject 原子写入成功且无 .tmp 残留', async () => {
  const dir = await makeTmpDir()
  const cfg = new Config()
  cfg.set('model', 'test-model-x')

  await cfg.saveToProject(dir)

  const written = JSON.parse(await readFile(join(dir, '.claude-code', 'config.json'), 'utf-8'))
  assert.equal(written.model, 'test-model-x')
  const projectDir = join(dir, '.claude-code')
  assert.deepEqual(await tmpResidues(projectDir), [], '不应残留 .tmp-* 文件')
})

test('saveKeyToUser 原子写入 + 只改目标键，磁盘其余键原样保留', async () => {
  const dir = await makeTmpDir()
  const userFile = join(dir, 'config.json')
  await writeFile(userFile, JSON.stringify({
    model: 'deepseek-flash',
    apiKey: 'sk-keep-me',
    custom: { nested: 'value' },
  }), 'utf-8')

  const cfg = new Config()
  cfg._userPath = userFile // 注入临时路径，避免碰真实 ~/.claude-code

  await cfg.saveKeyToUser('maxBudgetTokens', 123456)

  const disk = JSON.parse(await readFile(userFile, 'utf-8'))
  assert.equal(disk.maxBudgetTokens, 123456, '目标键应更新')
  assert.equal(disk.model, 'deepseek-flash', '其余键应原样保留')
  assert.equal(disk.apiKey, 'sk-keep-me', 'apiKey 不应丢失')
  assert.equal(disk.custom.nested, 'value', '嵌套对象不应丢失')
  assert.deepEqual(await tmpResidues(dir), [], '不应残留 .tmp-* 文件')
})

test('saveKeyToUser 支持点路径写嵌套键', async () => {
  const dir = await makeTmpDir()
  const userFile = join(dir, 'config.json')
  const cfg = new Config()
  cfg._userPath = userFile

  await cfg.saveKeyToUser('dream.summarizer', { apiBase: 'http://x/v1', model: 'q' })

  const disk = JSON.parse(await readFile(userFile, 'utf-8'))
  assert.equal(disk.dream.summarizer.model, 'q')
})

test('migrateLegacyModelName：改名 + .bak 备份保存旧值 + 无 tmp 残留', async () => {
  const dir = await makeTmpDir()
  const userFile = join(dir, 'config.json')
  await writeFile(userFile, JSON.stringify({
    model: 'deepseek-chat',
    apiBase: 'https://api.deepseek.com/v1',
    apiKey: 'sk-xyz',
  }), 'utf-8')

  const cfg = new Config()
  cfg._userPath = userFile
  cfg._projectPath = null
  // 模拟加载后的内存状态
  cfg.data = { ...cfg.data, model: 'deepseek-chat', apiBase: 'https://api.deepseek.com/v1', apiKey: 'sk-xyz' }

  const migrated = await cfg.migrateLegacyModelName()

  assert.equal(migrated, true)
  const disk = JSON.parse(await readFile(userFile, 'utf-8'))
  assert.equal(disk.model, 'deepseek-flash', 'model 应改名为 deepseek-flash')
  assert.equal(disk.apiKey, 'sk-xyz', 'apiKey 不应丢失')

  assert.equal(existsSync(userFile + '.bak'), true, '应存在 .bak 备份')
  const bak = JSON.parse(await readFile(userFile + '.bak', 'utf-8'))
  assert.equal(bak.model, 'deepseek-chat', '.bak 应保存迁移前的旧值')

  assert.deepEqual(await tmpResidues(dir), [], '不应残留 .tmp-* 文件')
})

test('migrateLegacyModelName：非旧模型名 → 不动文件', async () => {
  const dir = await makeTmpDir()
  const userFile = join(dir, 'config.json')
  await writeFile(userFile, JSON.stringify({ model: 'deepseek-flash', apiBase: 'https://api.deepseek.com/v1' }), 'utf-8')

  const cfg = new Config()
  cfg._userPath = userFile
  cfg._projectPath = null
  cfg.data = { ...cfg.data, model: 'deepseek-flash', apiBase: 'https://api.deepseek.com/v1' }

  const migrated = await cfg.migrateLegacyModelName()

  assert.equal(migrated, false)
  assert.equal(existsSync(userFile + '.bak'), false, '不应产生备份')
  const disk = JSON.parse(await readFile(userFile, 'utf-8'))
  assert.equal(disk.model, 'deepseek-flash')
})

test('migrateLegacyModelName：第三方 apiBase → 不动文件（安全边界）', async () => {
  const dir = await makeTmpDir()
  const userFile = join(dir, 'config.json')
  await writeFile(userFile, JSON.stringify({ model: 'deepseek-chat', apiBase: 'https://my-proxy.example.com/v1' }), 'utf-8')

  const cfg = new Config()
  cfg._userPath = userFile
  cfg._projectPath = null
  cfg.data = { ...cfg.data, model: 'deepseek-chat', apiBase: 'https://my-proxy.example.com/v1' }

  const migrated = await cfg.migrateLegacyModelName()

  assert.equal(migrated, false)
  const disk = JSON.parse(await readFile(userFile, 'utf-8'))
  assert.equal(disk.model, 'deepseek-chat', '第三方代理下的有意配置不受影响')
  assert.equal(existsSync(userFile + '.bak'), false)
})
