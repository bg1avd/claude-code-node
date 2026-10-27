/**
 * 会话级权限放行 —— 回归测试
 *
 * 三个真实缺陷（用户报障「/allow all 之后 /status 还是 ask」时挖出来的）：
 *
 *  1. **`/allow Bash` 从来没生效过**
 *     cli 把参数整体 `toLowerCase()`，规则存成 "bash"，而工具注册名是 "Bash"，
 *     严格比较永远不匹配。只有 `/allow all`（走 sessionAllowAll）和 `/allow *` 侥幸有效。
 *
 *  2. **`/allow reset` 撤销不掉 `/allow <tool>`**
 *     两套 PermissionChecker 的 resetSessionAllow 都只清 sessionAllowAll，
 *     不清规则/集合。提示写着"已恢复 ask"，实际该工具依然免确认。
 *
 *  3. **`/status` 不体现会话级放行**
 *     它只读 config.permissionMode（启动时那个值），于是用户敲完 `/allow all`
 *     再看 /status 仍显示 ask，误以为没生效。
 *
 * 这三条分别是「功能错」「功能错」「显示错」，第 1、2 条会让权限形同虚设，
 * 因此都要有测试兜住。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EnhancedPermissionChecker } from '../security/enhanced-permission.js'
import { PermissionChecker } from '../permission/permission.js'
import { buildStatus } from '../core/status.js'

/** engine.permissionChecker 在真实运行中就是 EnhancedPermissionChecker */
const mk = (mode = 'ask') => new EnhancedPermissionChecker(mode)

/** 构造一个能让 buildStatus 工作的最小 engine */
function statusWith(checker) {
  return buildStatus({
    engine: {
      config: { permissionMode: 'ask', model: 'test-model' },
      permissionChecker: checker,
      state: {},
      costTracker: null,
    },
    session: { id: 'sess-test' },
    config: { get: () => undefined, has: () => false },
    version: 'test',
  })
}

const permLine = (out) => out.split('\n').find(l => l.includes('权限模式')) || ''

// ------------------------------------------------------------
// 1. 工具名大小写
// ------------------------------------------------------------

test('allow(Bash) 对工具名 Bash 生效', async () => {
  const p = mk()
  p.allow('Bash')
  const r = await p.check('Bash', { command: 'echo hi' })
  assert.equal(r.allowed, true)
})

test('allow(bash) 也能匹配工具名 Bash（忽略大小写）', async () => {
  const p = mk()
  // 这正是旧 cli 里 toLowerCase() 之后落库的值 —— 修复后必须仍然有效
  p.allow('bash')
  const r = await p.check('Bash', { command: 'echo hi' })
  assert.equal(r.allowed, true, '大小写不一致不应导致放行失效')
})

test('放行 Bash 不会连带放行其他工具', async () => {
  const p = mk()
  p.allow('Bash')
  const r = await p.check('Write', { file_path: '/tmp/whatever.txt' })
  assert.equal(r.requiresConfirmation, true, 'Write 仍应要求确认')
})

// ------------------------------------------------------------
// 2. /allow reset 的撤销范围
// ------------------------------------------------------------

test('resetSessionAllow 撤销 /allow <tool> 加的规则', async () => {
  const p = mk()
  p.allow('Bash')
  assert.equal((await p.check('Bash', { command: 'echo hi' })).allowed, true)

  p.resetSessionAllow()
  const r = await p.check('Bash', { command: 'echo hi' })
  assert.equal(r.requiresConfirmation, true, 'reset 后必须恢复逐个确认')
})

test('resetSessionAllow 撤销 /allow all', async () => {
  const p = mk()
  p.allowAllForSession()
  assert.equal((await p.check('Bash', { command: 'echo hi' })).allowed, true)

  p.resetSessionAllow()
  const r = await p.check('Bash', { command: 'echo hi' })
  assert.equal(r.requiresConfirmation, true)
})

test('resetSessionAllow 不误删持久规则（只删 sessionScoped）', async () => {
  const p = mk()
  // 模拟一条来自 permissions.json 的持久规则（无 sessionScoped 标记）
  p.addRule({ tool: 'Read', pattern: '*', decision: 'allow', reason: '项目配置' })
  p.allow('Bash')
  p.resetSessionAllow()

  assert.equal((await p.check('Bash', { command: 'echo hi' })).requiresConfirmation, true,
    '会话级规则应被撤销')
  assert.equal((await p.check('Read', { file_path: '/tmp/a.txt' })).allowed, true,
    '持久规则必须保留')
})

// ------------------------------------------------------------
// 3. /status 的显示
// ------------------------------------------------------------

test('/status 显示 /allow <tool> 的放行', () => {
  const p = mk()
  p.allow('Bash')
  const line = permLine(statusWith(p))
  assert.match(line, /ask/)
  assert.match(line, /本次会话已放行「Bash」/)
})

test('/status 显示 /allow all 的放行', () => {
  const p = mk()
  p.allowAllForSession()
  assert.match(permLine(statusWith(p)), /本次会话已放行「全部工具」/)
})

test('/status 在 reset 后不再显示放行', () => {
  const p = mk()
  p.allowAllForSession()
  p.allow('Bash')
  p.resetSessionAllow()
  const line = permLine(statusWith(p))
  assert.doesNotMatch(line, /已放行/)
})

test('/status 在 mode=all 时不重复标注（全局已放行）', () => {
  const p = mk('all')
  const out = buildStatus({
    engine: { config: { permissionMode: 'all', model: 'm' }, permissionChecker: p, state: {} },
    session: { id: 's' },
    config: { get: () => undefined, has: () => false },
    version: 't',
  })
  const line = out.split('\n').find(l => l.includes('权限模式')) || ''
  assert.match(line, /all/)
  assert.doesNotMatch(line, /本次会话已放行/, 'mode=all 时不应再叠加会话级说明')
})

// ------------------------------------------------------------
// 4. 简化版 PermissionChecker（未被 engine 使用，但保持行为一致）
// ------------------------------------------------------------

test('简化版 PermissionChecker 也忽略工具名大小写', async () => {
  const p = new PermissionChecker('ask')
  p.allow('bash')
  assert.equal(await p.check('Bash'), true)
})

test('简化版 PermissionChecker 的 reset 也清空放行集合', async () => {
  const p = new PermissionChecker('ask')
  p.allow('Bash')
  p.resetSessionAllow()
  assert.equal(p.alwaysAllow.size, 0)
})
