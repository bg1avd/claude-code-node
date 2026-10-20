/**
 * 权限模式开关 + 配置键拼写校验（v3.6.21）
 *
 * 背景（用户原话）：「你弹出什么提示就应该写什么开关，写别的就是让人猜」。
 *   交互提示写的是 `a = 本会话全部允许` / `/allow all`，
 *   那么配置里就必须能写 `"permissionMode": "all"`，
 *   而不是逼用户去记 `always-allow` 这种另一个名字。
 *
 * 本测试锁死：
 *   ① 对外合法值**只有** all / ask / deny
 *   ② 旧值 always-allow 仍可用，但会被标记为 legacy（调用方需提示改成 all）
 *   ③ 非法值（allow / auto / true …）**绝不静默生效**：回退 ask 且给出可读告警
 *   ④ 权限检查器真正按 all 放行、按 ask 要求确认
 *   ⑤ 配置里写错键名（permission 少了 Mode）必须被指出来并给出建议
 *   ⑥ 新建配置模板自带说明（用户不用翻文档）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  PERMISSION_MODES,
  PERMISSION_MODES_HELP,
  normalizePermissionMode,
  permissionModeWarning,
} from '../core/permission-mode.js'
import { EnhancedPermissionChecker } from '../security/enhanced-permission.js'
import { PermissionChecker } from '../permission/permission.js'
import { Config } from '../core/config.js'

// ---------------------------------------------------------------- 合法值集合

test('合法值只有 all / ask / deny', () => {
  assert.deepEqual(PERMISSION_MODES, ['all', 'ask', 'deny'])
  assert.equal(PERMISSION_MODES_HELP, 'all | ask | deny')
})

test('三个合法值原样通过，且 valid=true / legacy=false', () => {
  for (const mode of ['all', 'ask', 'deny']) {
    const info = normalizePermissionMode(mode)
    assert.equal(info.mode, mode)
    assert.equal(info.valid, true)
    assert.equal(info.legacy, false)
    assert.equal(permissionModeWarning(info), null, `${mode} 不应产生告警`)
  }
})

test('大小写与空白被归一化（ALL /  Ask ）', () => {
  assert.equal(normalizePermissionMode('ALL').mode, 'all')
  assert.equal(normalizePermissionMode('  Ask  ').mode, 'ask')
  assert.equal(normalizePermissionMode('Deny').mode, 'deny')
})

test('未设置（undefined/null/空串）→ ask 且不告警', () => {
  for (const v of [undefined, null, '']) {
    const info = normalizePermissionMode(v)
    assert.equal(info.mode, 'ask')
    assert.equal(info.valid, true)
    assert.equal(info.provided, null)
    assert.equal(permissionModeWarning(info), null)
  }
})

// ---------------------------------------------------------------- 旧值兼容

test('旧值 always-allow 兼容映射为 all，并标记 legacy 以便提示', () => {
  const info = normalizePermissionMode('always-allow')
  assert.equal(info.mode, 'all')
  assert.equal(info.valid, true)
  assert.equal(info.legacy, true)
  const w = permissionModeWarning(info)
  assert.ok(w && w.includes('all'), '应提示改成 all')
  assert.ok(w.includes('always-allow'), '应指出原写法')
})

// ---------------------------------------------------------------- 非法值

test('非法值绝不静默：回退 ask + 明确告警（含合法值列表）', () => {
  for (const bad of ['allow', 'auto', 'true', 'alwaysallow', 'none', '取消']) {
    const info = normalizePermissionMode(bad)
    assert.equal(info.mode, 'ask', `${bad} 应回退 ask`)
    assert.equal(info.valid, false, `${bad} 应被判定非法`)
    const w = permissionModeWarning(info)
    assert.ok(w, `${bad} 必须产生告警`)
    assert.ok(w.includes('all | ask | deny'), '告警里要列出合法值')
    assert.ok(w.includes(bad), '告警里要包含用户写的值')
  }
})

// ---------------------------------------------------------------- 检查器行为

test('EnhancedPermissionChecker: all 直接放行 / ask 要求确认 / 非法值等同 ask', async () => {
  const input = { file_path: '/tmp/perm-test.txt', content: 'hi' }

  const all = new EnhancedPermissionChecker('all', { cwd: '/tmp' })
  const rAll = await all.check('Write', input)
  assert.equal(rAll.allowed, true, 'all 应放行')
  assert.notEqual(rAll.requiresConfirmation, true)

  const ask = new EnhancedPermissionChecker('ask', { cwd: '/tmp' })
  const rAsk = await ask.check('Write', input)
  assert.equal(rAsk.allowed, false)
  assert.equal(rAsk.requiresConfirmation, true, 'ask 应要求确认')

  const bad = new EnhancedPermissionChecker('allow', { cwd: '/tmp' })
  assert.equal(bad.mode, 'ask', '非法值必须被归一化为 ask')
  assert.equal(bad.rawMode, 'allow', '原始值要保留以便诊断')

  const legacy = new EnhancedPermissionChecker('always-allow', { cwd: '/tmp' })
  assert.equal(legacy.mode, 'all', '旧值应映射为 all')
})

test('PermissionChecker: all 放行，ask 不提前拦截（交给确认流程）', async () => {
  assert.equal(await new PermissionChecker('all').check('Bash', { command: 'ls' }), true)
  assert.equal(await new PermissionChecker('ask').check('Bash', { command: 'ls' }), true)
  assert.equal(await new PermissionChecker('deny').check('Bash', { command: 'ls' }), false)
})

// ---------------------------------------------------------------- 配置键拼写

test('写错键名 permission（少了 Mode）→ 启动告警并建议 permissionMode', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-permkey-'))
  const { mkdir, writeFile } = await import('fs/promises')
  await mkdir(join(dir, '.claude-code'), { recursive: true })
  await writeFile(
    join(dir, '.claude-code/config.json'),
    JSON.stringify({ permission: 'all', model: 'deepseek-flash' }),
    'utf-8'
  )

  const c = new Config()
  await c.load(dir)
  const warns = c.suspiciousKeys()

  const hit = warns.find(w => w.includes('"permission"'))
  assert.ok(hit, '必须报出 permission 键')
  assert.ok(hit.includes('permissionMode'), '必须建议正确的键名 permissionMode')
})

test('合法键不产生任何告警', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-permkey-ok-'))
  const { mkdir, writeFile } = await import('fs/promises')
  await mkdir(join(dir, '.claude-code'), { recursive: true })
  await writeFile(
    join(dir, '.claude-code/config.json'),
    JSON.stringify({
      permissionMode: 'all',
      model: 'deepseek-flash',
      thinking: { mode: 'on' },
      identity: 'x',
      preferences: {},
      description: {},
    }),
    'utf-8'
  )

  const c = new Config()
  await c.load(dir)
  // 只看本次写入的键是否被误报（用户级真实配置可能含有其它告警，不应影响本用例）
  const warns = c.suspiciousKeys()
  for (const k of ['permissionMode', 'model', 'thinking', 'identity', 'preferences', 'description']) {
    assert.ok(
      !warns.some(w => w.includes(`"${k}"`)),
      `合法键 ${k} 不应被告警：${warns.join(' / ')}`
    )
  }
})

test('明显拼错的键给出建议（modle → model）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-permkey-typo-'))
  const { mkdir, writeFile } = await import('fs/promises')
  await mkdir(join(dir, '.claude-code'), { recursive: true })
  await writeFile(join(dir, '.claude-code/config.json'), JSON.stringify({ modle: 'x' }), 'utf-8')

  const c = new Config()
  await c.load(dir)
  const warns = c.suspiciousKeys()
  assert.ok(warns.some(w => w.includes('model')), '应建议 model')
})

// ---------------------------------------------------------------- 配置模板自带说明

test('新建配置模板的 description 里写清了 permissionMode 的取值', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-permtpl-'))
  const c = new Config()
  const created = await c.ensureProjectTemplate(dir, { language: 'zh' })
  assert.equal(created, true)

  const raw = JSON.parse(await readFile(join(dir, '.claude-code/config.json'), 'utf-8'))
  assert.ok(raw.description, '模板必须带 description')
  const d = raw.description.permissionMode
  assert.ok(d, 'description 必须说明 permissionMode')
  assert.ok(d.includes('all') && d.includes('ask') && d.includes('deny'), '必须列出三个合法值')
  assert.ok(!d.includes('always-allow') || d.includes('其它值'), '不应把内部旧名当推荐值')
  // 其它关键开关也要有说明，避免用户去猜
  for (const k of ['thinking', 'maxTurns', 'maxBudgetTokens', 'keybindings']) {
    assert.ok(raw.description[k], `description 缺少 ${k} 的说明`)
  }
})

test('英文环境模板同样自说明', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-permtpl-en-'))
  const c = new Config()
  await c.ensureProjectTemplate(dir, { language: 'en' })
  const raw = JSON.parse(await readFile(join(dir, '.claude-code/config.json'), 'utf-8'))
  assert.ok(raw.description.permissionMode.includes('all'))
  assert.ok(raw.description.permissionMode.toLowerCase().includes('default'))
})
