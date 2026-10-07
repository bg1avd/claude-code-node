/**
 * 身份（Identity）+ 项目配置模板 单元测试
 *
 * 背景：cc-node 的身份要支持「机器级基线 + 目录级角色」两级**叠加**（而非高层覆盖低层），
 * 所以新增 Config.getRaw(level,key) 分层读取；并在「首次从无配置目录启动」时生成带
 * description 自说明的模板。
 *
 * 覆盖：
 *   - getRaw：user / project 两层各自返回值（不被合并吃掉）；get() 仍为覆盖值
 *   - ensureProjectTemplate：生成模板 / 语言跟随（zh→中文, 否则英文）/ 已存在不覆盖 / 空目录不做事
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir, readFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { Config } from '../core/config.js'

async function tmp(p) {
  return mkdtemp(join(tmpdir(), p))
}

test('getRaw：分层返回 user / project 各自的 identity（不合并）', async () => {
  const dir = await tmp('ccn-id-')
  const userFile = join(dir, 'user.json')
  const projFile = join(dir, 'proj.json')
  await writeFile(userFile, JSON.stringify({ identity: '机器基线' }), 'utf8')
  await writeFile(projFile, JSON.stringify({ identity: '目录角色' }), 'utf8')

  const cfg = new Config()
  await cfg._load(userFile, 'user')
  await cfg._load(projFile, 'project')

  assert.equal(cfg.getRaw('user', 'identity'), '机器基线')
  assert.equal(cfg.getRaw('project', 'identity'), '目录角色')
  // 合并后的 get() 只给覆盖值（project 覆盖 user）——证明 getRaw 是必要的
  assert.equal(cfg.get('identity'), '目录角色')
  assert.equal(cfg.getRaw('nope', 'identity'), undefined)
})

test('ensureProjectTemplate：首次生成带 description 的模板（中文语言）', async () => {
  const dir = await tmp('ccn-tpl-')
  const cfg = new Config()
  const created = await cfg.ensureProjectTemplate(dir, { language: 'zh' })
  assert.equal(created, true)

  const raw = JSON.parse(await readFile(join(dir, '.claude-code', 'config.json'), 'utf8'))
  assert.equal(raw.identity, '')
  assert.ok(raw.description && raw.description.identity.includes('可选'))
  assert.ok(raw.description.systemPrompt.includes('可选'))
})

test('ensureProjectTemplate：非中文语言 → 英文说明', async () => {
  const dir = await tmp('ccn-tpl-en-')
  const cfg = new Config()
  await cfg.ensureProjectTemplate(dir, { language: '' })
  const raw = JSON.parse(await readFile(join(dir, '.claude-code', 'config.json'), 'utf8'))
  assert.ok(/Optional/i.test(raw.description.identity))
})

test('ensureProjectTemplate：已存在则不覆盖（返回 false，原内容保留）', async () => {
  const dir = await tmp('ccn-tpl2-')
  await mkdir(join(dir, '.claude-code'), { recursive: true })
  await writeFile(join(dir, '.claude-code', 'config.json'), JSON.stringify({ identity: '我的角色' }), 'utf8')
  const cfg = new Config()
  const created = await cfg.ensureProjectTemplate(dir, { language: 'zh' })
  assert.equal(created, false)
  const raw = JSON.parse(await readFile(join(dir, '.claude-code', 'config.json'), 'utf8'))
  assert.equal(raw.identity, '我的角色')
})

test('ensureProjectTemplate：空 projectDir → 直接返回 false', async () => {
  const cfg = new Config()
  assert.equal(await cfg.ensureProjectTemplate('', { language: 'zh' }), false)
})
