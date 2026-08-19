import { test } from 'node:test'
import assert from 'node:assert'
import { PassThrough, Writable } from 'node:stream'
import { createMultilineInput } from '../core/multiline-input.js'

// 创建一个模拟 TTY 的输入流和一个收集 stdout 的输出流
function makeEnv() {
  const input = new PassThrough()
  input.isTTY = true
  input.setRawMode = () => {}
  const output = new Writable({ write(c, _e, cb) { this.buf += c.toString(); cb() } })
  output.buf = ''
  return { input, output }
}

// 让事件循环跑一下，等待异步提交
const tick = () => new Promise((r) => setTimeout(r, 30))

test('多行输入被完整提交（含内嵌换行，不被断句）', async () => {
  const { input, output } = makeEnv()
  const submitted = []
  const ctrl = createMultilineInput({
    stdin: input, stdout: output, prompt: '> ',
    onSubmit: (t) => submitted.push(t),
  })
  ctrl.start()

  input.write('第一行')
  input.write('\n') // 文本换行 → 折行，不提交
  input.write('第二行')
  input.write('\r') // Enter → 提交

  await tick()
  assert.deepStrictEqual(submitted, ['第一行\n第二行'])
})

test('CRLF 提交后残留 \\n 被忽略，不产生脏输入', async () => {
  const { input, output } = makeEnv()
  const submitted = []
  const ctrl = createMultilineInput({
    stdin: input, stdout: output, prompt: '> ',
    onSubmit: (t) => submitted.push(t),
  })
  ctrl.start()

  input.write('A段')
  input.write('\r\n') // CRLF
  input.write('B段')
  input.write('\r')

  await tick()
  assert.deepStrictEqual(submitted, ['A段', 'B段'])
})

test('连续多条输入互不干扰，各自完整', async () => {
  const { input, output } = makeEnv()
  const submitted = []
  const ctrl = createMultilineInput({
    stdin: input, stdout: output, prompt: '> ',
    onSubmit: (t) => submitted.push(t),
  })
  ctrl.start()

  input.write('文章一\n带换行')
  input.write('\r')
  input.write('文章二')
  input.write('\r')

  await tick()
  assert.deepStrictEqual(submitted, ['文章一\n带换行', '文章二'])
})

test('上方向键调出输入历史', async () => {
  const { input, output } = makeEnv()
  const submitted = []
  const ctrl = createMultilineInput({
    stdin: input, stdout: output, prompt: '> ',
    onSubmit: (t) => submitted.push(t),
  })
  ctrl.start()

  input.write('历史输入')
  input.write('\r')
  input.write('\x1b[A') // 上方向键
  input.write('\r')

  await tick()
  assert.deepStrictEqual(submitted, ['历史输入', '历史输入'])
})

test('ask() 单行问题返回用户回答', async () => {
  const { input, output } = makeEnv()
  const ctrl = createMultilineInput({
    stdin: input, stdout: output, prompt: '> ',
  })
  ctrl.start()

  const p = ctrl.ask('是否允许? (y/N)')
  input.write('y')
  input.write('\r')

  const ans = await p
  assert.strictEqual(ans, 'y')
})

test('ask() 在提问期间不污染主输入缓冲', async () => {
  const { input, output } = makeEnv()
  const submitted = []
  const ctrl = createMultilineInput({
    stdin: input, stdout: output, prompt: '> ',
    onSubmit: (t) => submitted.push(t),
  })
  ctrl.start()

  const p = ctrl.ask('选一个? ')
  input.write('x')
  input.write('\r')
  await p

  // 提问结束后，主输入缓冲应为空，输入新内容提交正常
  input.write('新输入')
  input.write('\r')
  await tick()
  assert.deepStrictEqual(submitted, ['新输入'])
})

test('单行输入回显稳定：不发出光标上移\\x1b[1A（防止乱跳）', async () => {
  const { input, output } = makeEnv()
  output.columns = 80
  const ctrl = createMultilineInput({
    stdin: input, stdout: output, prompt: '> ',
    onSubmit: () => {},
  })
  ctrl.start()

  input.write('hello')
  await tick()

  const raw = output.buf
  // 单行输入时绝不出现光标上移序列（会导致屏幕乱跳）
  assert.ok(!raw.includes('\x1b[1A'), `单行输入不应上移光标，实际输出: ${JSON.stringify(raw)}`)
  // 应通过 \r + 清屏 + 重绘实现回显
  assert.ok(raw.includes('\x1b[J'), '应有清屏序列')
  // 最终内容应完整显示
  assert.ok(raw.includes('> hello'), '输入内容应完整回显')
})

test('多行输入回显稳定：重绘只上移到首行一次，无多余跳转', async () => {
  const { input, output } = makeEnv()
  output.columns = 80
  const ctrl = createMultilineInput({
    stdin: input, stdout: output, prompt: '> ',
    onSubmit: () => {},
  })
  ctrl.start()

  input.write('第一行')
  input.write('\n')   // 折行
  input.write('第二行')
  await tick()

  const raw = output.buf
  // 折行后输入第二行时，应只发出一次 \x1b[1A（上移到首行）+ 清屏 + 重绘
  // 不应出现 \x1b[1B（下移）或 \x1b[nC 这类多余跳转组合
  assert.ok(!raw.includes('\x1b[1B'), '不应有光标下移跳转')
  // 内容应包含两行完整回显
  assert.ok(raw.includes('> 第一行'), '第一行应回显')
  assert.ok(raw.includes('第二行'), '第二行应回显')
})

test('Alt+Enter（Esc+Enter）折行、普通 Enter 提交 — 跨终端可靠多行输入', async () => {
  const { input, output } = makeEnv()
  const submitted = []
  const ctrl = createMultilineInput({
    stdin: input, stdout: output, prompt: '> ',
    onSubmit: (t) => submitted.push(t),
  })
  ctrl.start()

  // 第一行 + Alt+Enter（\x1b\r → meta+return）折行
  input.write('第一行')
  input.write('\x1b\r')
  // 第二行 + 普通 Enter 提交
  input.write('第二行')
  input.write('\r')

  await tick()
  assert.deepStrictEqual(submitted, ['第一行\n第二行'])
})

test('普通 Enter 仍是提交（单行输入不受影响）', async () => {
  const { input, output } = makeEnv()
  const submitted = []
  const ctrl = createMultilineInput({
    stdin: input, stdout: output, prompt: '> ',
    onSubmit: (t) => submitted.push(t),
  })
  ctrl.start()

  input.write('hello world')
  input.write('\r')

  await tick()
  assert.deepStrictEqual(submitted, ['hello world'])
})

test('独立 ESC 事件 + Enter（终端把 Alt+Enter 拆成两事件）也折行', async () => {
  const { input, output } = makeEnv()
  const submitted = []
  const ctrl = createMultilineInput({
    stdin: input, stdout: output, prompt: '> ',
    onSubmit: (t) => submitted.push(t),
  })
  ctrl.start()

  // 模拟终端把 Alt+Enter 拆成独立 ESC 事件和独立 \r 事件（分两次写入）
  input.write('第一行')
  input.write('\x1b')   // 独立 ESC 事件
  input.write('\r')     // 随后的 Enter → 应视为 Alt+Enter 折行
  input.write('第二行')
  input.write('\r')     // 普通 Enter 提交

  await tick()
  assert.deepStrictEqual(submitted, ['第一行\n第二行'])
})

test('CSI 序列 \\x1b[13~（部分终端的 Ctrl/Alt+Enter）折行', async () => {
  const { input, output } = makeEnv()
  const submitted = []
  const ctrl = createMultilineInput({
    stdin: input, stdout: output, prompt: '> ',
    onSubmit: (t) => submitted.push(t),
  })
  ctrl.start()

  input.write('第一行')
  input.write('\x1b[13~') // CSI 序列 → f3 → 折行
  input.write('第二行')
  input.write('\r')       // 普通 Enter 提交

  await tick()
  assert.deepStrictEqual(submitted, ['第一行\n第二行'])
})
