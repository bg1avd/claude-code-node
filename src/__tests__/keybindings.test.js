import { test } from 'node:test'
import assert from 'node:assert'
import { createKeybindings, normalizeSpec, DEFAULT_KEYBINDINGS, ACTION_DESCRIPTIONS, formatKeyLabel } from '../core/keybindings.js'

test('normalizeSpec 归一化（小写 + 修饰键固定顺序）', () => {
  assert.strictEqual(normalizeSpec('Shift+Enter'), 'shift+enter')
  assert.strictEqual(normalizeSpec('ENTER'), 'enter')
  assert.strictEqual(normalizeSpec('Shift+Ctrl+A'), 'ctrl+shift+a')
  assert.strictEqual(normalizeSpec(' ctrl + left '), 'ctrl+left')
})

test('默认绑定：常用键 → 动作', () => {
  const kb = createKeybindings()
  assert.strictEqual(kb.actionFor('enter'), 'submit')
  assert.strictEqual(kb.actionFor('ctrl+j'), 'newline')
  assert.strictEqual(kb.actionFor('alt+enter'), 'newline')
  assert.strictEqual(kb.actionFor('ctrl+left'), 'cursor-word-left')
  assert.strictEqual(kb.actionFor('alt+b'), 'cursor-word-left')
  assert.strictEqual(kb.actionFor('home'), 'line-start')
  assert.strictEqual(kb.actionFor('ctrl+a'), 'line-start')
  assert.strictEqual(kb.actionFor('ctrl+w'), 'delete-word-back')
  assert.strictEqual(kb.actionFor('up'), 'history-prev')
  assert.strictEqual(kb.actionFor('ctrl+c'), 'clear-or-exit')
})

test('未绑定的键返回 null', () => {
  const kb = createKeybindings()
  assert.strictEqual(kb.actionFor('ctrl+p'), null)
  assert.strictEqual(kb.actionFor('f7'), null)
})

test('用户配置：数组 = 替换该动作的绑定', () => {
  const kb = createKeybindings({ newline: ['ctrl+enter'] })
  assert.deepStrictEqual(kb.keysFor('newline'), ['ctrl+enter'])
  assert.strictEqual(kb.actionFor('ctrl+enter'), 'newline')
  // 原默认键不再绑到 newline
  assert.strictEqual(kb.actionFor('alt+enter'), null)
  // 其他动作不受影响
  assert.strictEqual(kb.actionFor('enter'), 'submit')
})

test('用户配置：null / [] = 解绑', () => {
  const kb = createKeybindings({ 'clear-or-exit': null, 'history-prev': [] })
  assert.deepStrictEqual(kb.keysFor('clear-or-exit'), [])
  assert.deepStrictEqual(kb.keysFor('history-prev'), [])
  assert.strictEqual(kb.actionFor('ctrl+c'), null)
  assert.strictEqual(kb.actionFor('up'), null)
})

test('用户配置：新增自定义动作', () => {
  const kb = createKeybindings({ 'my-action': ['ctrl+g'] })
  assert.strictEqual(kb.actionFor('ctrl+g'), 'my-action')
  assert.deepStrictEqual(kb.keysFor('my-action'), ['ctrl+g'])
})

test('默认表覆盖关键动作', () => {
  for (const action of ['submit', 'newline', 'cursor-left', 'delete-back', 'history-prev']) {
    assert.ok(DEFAULT_KEYBINDINGS[action], `默认表应含 ${action}`)
  }
})

test('用户配置非对象时不崩', () => {
  const kb = createKeybindings(null)
  assert.strictEqual(kb.actionFor('enter'), 'submit')
})

// ============================================================
//  说明文本 / 键位标签 / 冲突检测（屏幕软键条与键位提示的地基）
// ============================================================

test('每个默认动作都有中文说明', () => {
  for (const action of Object.keys(DEFAULT_KEYBINDINGS)) {
    assert.ok(ACTION_DESCRIPTIONS[action], `${action} 应有说明`)
  }
})

test('formatKeyLabel：键规格 → 紧凑显示标签', () => {
  assert.strictEqual(formatKeyLabel('enter'), '⏎')
  assert.strictEqual(formatKeyLabel('ctrl+j'), '^J')
  assert.strictEqual(formatKeyLabel('alt+enter'), '⌥⏎')
  assert.strictEqual(formatKeyLabel('shift+enter'), '⇧⏎')
  assert.strictEqual(formatKeyLabel('ctrl+left'), '^←')
  assert.strictEqual(formatKeyLabel('up'), '↑')
  assert.strictEqual(formatKeyLabel('backspace'), '⌫')
  assert.strictEqual(formatKeyLabel(''), '')
})

test('hintFor：动作 → 键位提示文本，且随用户改键自动跟随', () => {
  const kb = createKeybindings()
  const hint = kb.hintFor('newline')
  assert.ok(hint.includes('折行'), `应含说明，实际: ${hint}`)
  assert.ok(hint.includes('^J'), `应含键标签，实际: ${hint}`)
  assert.strictEqual(kb.hintFor('no-such-action'), '')

  const kb2 = createKeybindings({ newline: ['ctrl+enter'] })
  assert.ok(kb2.hintFor('newline').includes('^⏎'), kb2.hintFor('newline'))
  assert.ok(!kb2.hintFor('newline').includes('^J'), '改键后旧的键标签应消失')
})

test('conflicts()：默认绑定无冲突', () => {
  const kb = createKeybindings()
  assert.deepStrictEqual(kb.conflicts(), [])
})

test('conflicts()：同一键绑到两个动作 → 检出', () => {
  const kb = createKeybindings({ 'cursor-left': ['ctrl+g'], 'cursor-right': ['ctrl+g'] })
  const c = kb.conflicts()
  assert.strictEqual(c.length, 1)
  assert.strictEqual(c[0].spec, 'ctrl+g')
  assert.deepStrictEqual([...c[0].actions].sort(), ['cursor-left', 'cursor-right'])
})

test('conflicts()：自定义动作撞默认键 → 检出', () => {
  const kb = createKeybindings({ 'my-action': ['ctrl+j'] })
  assert.ok(kb.conflicts().map((x) => x.spec).includes('ctrl+j'))
})
