import { test } from 'node:test'
import assert from 'node:assert'
import { createKeybindings, normalizeSpec, DEFAULT_KEYBINDINGS } from '../core/keybindings.js'

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
