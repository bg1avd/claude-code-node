import { test } from 'node:test'
import assert from 'node:assert'
import { createKeyParser, keyEventToSpec, describeKeyEvent } from '../core/keymap.js'

// 便捷：一次性喂入并返回事件
function parse(seq) {
  return createKeyParser().feed(seq)
}
// 去掉诊断用的 raw 字段，便于整事件比较
const strip = (evs) => evs.map(({ raw, ...r }) => r)
// 便捷：只取第一个 key 事件的 spec
function specOf(seq) {
  const evs = parse(seq)
  return evs.length ? keyEventToSpec(evs[0]) : null
}

test('控制字符 → 逻辑键', () => {
  assert.strictEqual(specOf('\x01'), 'ctrl+a')
  assert.strictEqual(specOf('\x1a'), 'ctrl+z')
  assert.strictEqual(specOf('\x0b'), 'ctrl+k')
  assert.strictEqual(specOf('\t'), 'tab')
  assert.strictEqual(specOf('\r'), 'enter')
  assert.strictEqual(specOf('\n'), 'ctrl+j')     // LF = Ctrl+J
  assert.strictEqual(specOf('\x7f'), 'backspace')
  assert.strictEqual(specOf('\x08'), 'backspace') // Ctrl+H 亦作退格
})

test('可打印字符 → char 事件（含多字节）', () => {
  assert.deepStrictEqual(strip(parse('a')), [{ type: 'char', text: 'a' }])
  assert.deepStrictEqual(strip(parse('中')), [{ type: 'char', text: '中' }])
  assert.deepStrictEqual(strip(parse('😀')), [{ type: 'char', text: '😀' }])
})

test('CSI 定点/编辑键', () => {
  assert.strictEqual(specOf('\x1b[A'), 'up')
  assert.strictEqual(specOf('\x1b[B'), 'down')
  assert.strictEqual(specOf('\x1b[C'), 'right')
  assert.strictEqual(specOf('\x1b[D'), 'left')
  assert.strictEqual(specOf('\x1b[H'), 'home')
  assert.strictEqual(specOf('\x1b[F'), 'end')
  assert.strictEqual(specOf('\x1b[3~'), 'delete')
  assert.strictEqual(specOf('\x1b[2~'), 'insert')
  assert.strictEqual(specOf('\x1b[5~'), 'pageup')
  assert.strictEqual(specOf('\x1b[6~'), 'pagedown')
  assert.strictEqual(specOf('\x1b[1~'), 'home')
  assert.strictEqual(specOf('\x1b[Z'), 'shift+tab')
  assert.strictEqual(specOf('\x1b[11~'), 'f1')
  assert.strictEqual(specOf('\x1b[24~'), 'f12')
})

test('SS3 定点键', () => {
  assert.strictEqual(specOf('\x1bOA'), 'up')
  assert.strictEqual(specOf('\x1bOD'), 'left')
  assert.strictEqual(specOf('\x1bOH'), 'home')
  assert.strictEqual(specOf('\x1bOP'), 'f1')
})

test('CSI 带修饰键', () => {
  assert.strictEqual(specOf('\x1b[1;5D'), 'ctrl+left')
  assert.strictEqual(specOf('\x1b[1;3D'), 'alt+left')
  assert.strictEqual(specOf('\x1b[1;2D'), 'shift+left')
  assert.strictEqual(specOf('\x1b[1;5C'), 'ctrl+right')
  assert.strictEqual(specOf('\x1b[3;5~'), 'ctrl+delete')
  assert.strictEqual(specOf('\x1b[1;5H'), 'ctrl+home')
  assert.strictEqual(specOf('\x1b[1;3F'), 'alt+end')
})

test('Kitty CSI-u（Node 原生不认识）', () => {
  assert.strictEqual(specOf('\x1b[13;2u'), 'shift+enter')
  assert.strictEqual(specOf('\x1b[13;5u'), 'ctrl+enter')
  assert.strictEqual(specOf('\x1b[13;3u'), 'alt+enter')
  assert.strictEqual(specOf('\x1b[97;5u'), 'ctrl+a')
  // 纯 Shift+字母 → 还原大写
  assert.deepStrictEqual(strip(parse('\x1b[97;2u')), [{ type: 'char', text: 'A' }])
  // 无修饰的可打印 → char
  assert.deepStrictEqual(strip(parse('\x1b[97u')), [{ type: 'char', text: 'a' }])
})

test('xterm modifyOtherKeys（Node 原生不认识）', () => {
  assert.strictEqual(specOf('\x1b[27;2;13~'), 'shift+enter')
  assert.strictEqual(specOf('\x1b[27;5;13~'), 'ctrl+enter')
  assert.strictEqual(specOf('\x1b[27;9;97~'), 'super+a') // 9 = 1+8 → bit3 = super
})

test('Alt 组合（ESC 前缀）', () => {
  assert.strictEqual(specOf('\x1bb'), 'alt+b')
  assert.strictEqual(specOf('\x1b\r'), 'alt+enter')
  assert.strictEqual(specOf('\x1b[D'), 'left')  // 注意：CSI 优先，不是 Alt+[
})

test('括号粘贴边界', () => {
  assert.deepStrictEqual(strip(parse('\x1b[200~')), [{ type: 'paste-start' }])
  assert.deepStrictEqual(strip(parse('\x1b[201~')), [{ type: 'paste-end' }])
})

test('序列跨数据块（有状态解析）', () => {
  const p = createKeyParser()
  assert.deepStrictEqual(p.feed('\x1b[1;5'), [])
  assert.strictEqual(p.pending(), '\x1b[1;5')
  const evs = p.feed('D')
  assert.strictEqual(keyEventToSpec(evs[0]), 'ctrl+left')
})

test('单独 ESC 挂起（与 Node 一致），后续字符补齐为 Alt+X', () => {
  const p = createKeyParser()
  assert.deepStrictEqual(p.feed('\x1b'), [])          // 挂起
  const evs = p.feed('x')                              // 补齐
  assert.strictEqual(keyEventToSpec(evs[0]), 'alt+x')
})

test('未知序列 → unknown，不污染输入', () => {
  const evs = parse('\x1b[99~')
  assert.strictEqual(evs.length, 1)
  assert.strictEqual(evs[0].type, 'unknown')
  // 终端能力查询回应（\x1b[?1u / \x1b[>4;2m）也应被吞掉
  assert.strictEqual(parse('\x1b[?1u')[0].type, 'unknown')
  assert.strictEqual(parse('\x1b[>4;2m')[0].type, 'unknown')
})

test('OSC 序列被整体吞掉', () => {
  const evs = parse('\x1b]11;rgb:0000/0000/0000\x07')
  assert.strictEqual(evs.length, 1)
  assert.strictEqual(evs[0].type, 'unknown')
})

test('一段混合输入被正确切分', () => {
  const evs = parse('ab\x1b[Dc\x1b[13;2u')
  assert.deepStrictEqual(evs.map((e) => e.type === 'char' ? e.text : keyEventToSpec(e)), ['a', 'b', 'left', 'c', 'shift+enter'])
})

test('describeKeyEvent 可读输出', () => {
  assert.strictEqual(describeKeyEvent(parse('a')[0]), 'char "a"')
  assert.strictEqual(describeKeyEvent(parse('\x1b[1;5D')[0]), 'key ctrl+left')
  assert.strictEqual(describeKeyEvent(parse('\x1b[200~')[0]), 'paste-start')
})

test('每个事件都带 raw 原始字节（供 /keys 诊断）', () => {
  assert.strictEqual(parse('a')[0].raw, 'a')
  assert.strictEqual(parse('\x1b[1;5D')[0].raw, '\x1b[1;5D')
  assert.strictEqual(parse('\x1bb')[0].raw, '\x1bb')
  assert.strictEqual(parse('\x1b[200~')[0].raw, '\x1b[200~')
})

// ============================================================
//  flush()：数据静默后冲刷残留（孤立 ESC / 半截序列）
// ============================================================

test('flush()：孤立 ESC → escape 键', () => {
  const p = createKeyParser()
  assert.deepStrictEqual(p.feed('\x1b'), [], '单独 ESC 先挂起')
  assert.strictEqual(p.pending(), '\x1b')
  const evs = p.flush()
  assert.strictEqual(evs.length, 1)
  assert.strictEqual(evs[0].type, 'key')
  assert.strictEqual(evs[0].name, 'escape')
  assert.strictEqual(p.pending(), '', '冲刷后缓冲应清空')
})

test('flush()：半截 CSI 序列 → unknown（安全丢弃，不污染输入）', () => {
  const p = createKeyParser()
  assert.deepStrictEqual(p.feed('\x1b[1;5'), [], '未终结的 CSI 挂起')
  const evs = p.flush()
  assert.strictEqual(evs.length, 1)
  assert.strictEqual(evs[0].type, 'unknown')
})

test('flush()：无残留时返回空数组', () => {
  const p = createKeyParser()
  p.feed('a')
  assert.deepStrictEqual(p.flush(), [])
})

test('flush()：冲刷后仍可正常解析后续完整序列', () => {
  const p = createKeyParser()
  p.feed('\x1b')
  p.flush()
  assert.deepStrictEqual(strip(p.feed('\x1b[D')), [{ type: 'key', name: 'left' }])
})

test('flush()：ESC 后继字符在冲刷前到达 → 仍合为 Alt+X（冲刷不抢跑）', () => {
  const p = createKeyParser()
  p.feed('\x1b')
  const evs = p.feed('b')          // 同一批数据，未 flush
  assert.deepStrictEqual(strip(evs), [{ type: 'key', name: 'b', alt: true }])
  assert.deepStrictEqual(p.flush(), [], '已消化，无残留')
})
