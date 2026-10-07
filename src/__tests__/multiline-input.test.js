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

// ============================================================
//  粘贴：bracketed paste（\x1b[200~ … \x1b[201~）
// ============================================================

test('括号粘贴多行内容不被断句，只在最后 Enter 提交一次', async () => {
  const { input, output } = makeEnv()
  const submitted = []
  const ctrl = createMultilineInput({
    stdin: input, stdout: output, prompt: '> ',
    onSubmit: (t) => submitted.push(t),
  })
  ctrl.start()

  input.write('\x1b[200~line1\r\nline2\r\nline3\x1b[201~')
  input.write('\r')

  await tick()
  assert.deepStrictEqual(submitted, ['line1\nline2\nline3'])
})

test('括号粘贴后未按 Enter 不提交', async () => {
  const { input, output } = makeEnv()
  const submitted = []
  const ctrl = createMultilineInput({
    stdin: input, stdout: output, prompt: '> ',
    onSubmit: (t) => submitted.push(t),
  })
  ctrl.start()

  input.write('\x1b[200~a\nb\nc\x1b[201~')
  await tick()
  assert.deepStrictEqual(submitted, [])

  // 再按 Enter 才整段提交
  input.write('\r')
  await tick()
  assert.deepStrictEqual(submitted, ['a\nb\nc'])
})

test('括号粘贴内的 CR 单独出现也当字面换行', async () => {
  const { input, output } = makeEnv()
  const submitted = []
  const ctrl = createMultilineInput({
    stdin: input, stdout: output, prompt: '> ',
    onSubmit: (t) => submitted.push(t),
  })
  ctrl.start()

  input.write('\x1b[200~甲\r乙\x1b[201~') // 老式 Mac 用 \r 作换行
  input.write('\r')

  await tick()
  assert.deepStrictEqual(submitted, ['甲\n乙'])
})

// ============================================================
//  粘贴：无括号终端的突发识别（兜底）
// ============================================================

test('无括号终端：突发粘贴（含 CRLF）不被误当多次提交', async () => {
  const { input, output } = makeEnv()
  const submitted = []
  const ctrl = createMultilineInput({
    stdin: input, stdout: output, prompt: '> ',
    onSubmit: (t) => submitted.push(t),
  })
  ctrl.start()

  input.write('line1\r\nline2') // 同一数据块（模拟一次粘贴）
  await tick()
  assert.deepStrictEqual(submitted, [], '粘贴中的 CRLF 不应触发提交')

  input.write('\r') // 用户真正按 Enter
  await tick()
  assert.deepStrictEqual(submitted, ['line1\nline2'])
})

test('单按 Enter 的裸 \\r 数据块仍正常提交（不误判为粘贴）', async () => {
  const { input, output } = makeEnv()
  const submitted = []
  const ctrl = createMultilineInput({
    stdin: input, stdout: output, prompt: '> ',
    onSubmit: (t) => submitted.push(t),
  })
  ctrl.start()

  input.write('abc')
  input.write('\r') // 单独一块
  await tick()
  assert.deepStrictEqual(submitted, ['abc'])
})

// ============================================================
//  光标行编辑
// ============================================================

test('← 左移后在中间插入：helo → hello', async () => {
  const { input, output } = makeEnv()
  const submitted = []
  const ctrl = createMultilineInput({
    stdin: input, stdout: output, prompt: '> ',
    onSubmit: (t) => submitted.push(t),
  })
  ctrl.start()

  input.write('helo')
  input.write('\x1b[D') // ←（光标移到 o 前）
  input.write('l')
  input.write('\r')

  await tick()
  assert.deepStrictEqual(submitted, ['hello'])
})

test('Home 跳到行首插入：world → hello world', async () => {
  const { input, output } = makeEnv()
  const submitted = []
  const ctrl = createMultilineInput({
    stdin: input, stdout: output, prompt: '> ',
    onSubmit: (t) => submitted.push(t),
  })
  ctrl.start()

  input.write('world')
  input.write('\x1b[H') // Home
  input.write('hello ')
  input.write('\r')

  await tick()
  assert.deepStrictEqual(submitted, ['hello world'])
})

test('Ctrl+A / Ctrl+E 跳到行首 / 行尾', async () => {
  const { input, output } = makeEnv()
  const submitted = []
  const ctrl = createMultilineInput({
    stdin: input, stdout: output, prompt: '> ',
    onSubmit: (t) => submitted.push(t),
  })
  ctrl.start()

  input.write('abc')
  input.write('\x01') // Ctrl+A → 行首
  input.write('X')
  input.write('\x1b[F') // End（光标到行尾）
  input.write('Y')
  input.write('\x05') // Ctrl+E（已在行尾）
  input.write('Z')
  input.write('\r')

  await tick()
  assert.deepStrictEqual(submitted, ['XabcYZ'])
})

test('Delete 删除光标处字符', async () => {
  const { input, output } = makeEnv()
  const submitted = []
  const ctrl = createMultilineInput({
    stdin: input, stdout: output, prompt: '> ',
    onSubmit: (t) => submitted.push(t),
  })
  ctrl.start()

  input.write('abcd')
  input.write('\x1b[D') // ←（光标到 d 前）
  input.write('\x1b[3~') // Delete → 删除 d
  input.write('\r')

  await tick()
  assert.deepStrictEqual(submitted, ['abc'])
})

test('Backspace 删除光标前字符（中间位置）', async () => {
  const { input, output } = makeEnv()
  const submitted = []
  const ctrl = createMultilineInput({
    stdin: input, stdout: output, prompt: '> ',
    onSubmit: (t) => submitted.push(t),
  })
  ctrl.start()

  input.write('abcd')
  input.write('\x1b[D')  // ←（光标到 d 前）
  input.write('\x7f')    // Backspace → 删除 c
  input.write('\r')

  await tick()
  assert.deepStrictEqual(submitted, ['abd'])
})

test('Ctrl+W 向前删除一个词', async () => {
  const { input, output } = makeEnv()
  const submitted = []
  const ctrl = createMultilineInput({
    stdin: input, stdout: output, prompt: '> ',
    onSubmit: (t) => submitted.push(t),
  })
  ctrl.start()

  input.write('foo bar')
  input.write('\x17') // Ctrl+W → 删掉 bar
  input.write('\r')

  await tick()
  assert.deepStrictEqual(submitted, ['foo '])
})

test('Ctrl+U 删到行首 / Ctrl+K 删到行尾', async () => {
  const { input, output } = makeEnv()
  const submitted = []
  const ctrl = createMultilineInput({
    stdin: input, stdout: output, prompt: '> ',
    onSubmit: (t) => submitted.push(t),
  })
  ctrl.start()

  input.write('hello')
  input.write('\x01')  // Ctrl+A → 行首
  input.write('\x0b')  // Ctrl+K → 删到行尾
  input.write('X')
  input.write('\r')
  await tick()
  assert.deepStrictEqual(submitted, ['X'])
})

test('Ctrl+U 删到行首', async () => {
  const { input, output } = makeEnv()
  const submitted = []
  const ctrl = createMultilineInput({
    stdin: input, stdout: output, prompt: '> ',
    onSubmit: (t) => submitted.push(t),
  })
  ctrl.start()

  input.write('hello')
  input.write('\x15')  // Ctrl+U → 删到行首（全清）
  input.write('X')
  input.write('\r')
  await tick()
  assert.deepStrictEqual(submitted, ['X'])
})

// ============================================================
//  bracketed paste mode 的开关
// ============================================================

test('TTY 输出：start() 开启 bracketed paste，dispose() 关闭', () => {
  const input = new PassThrough()
  input.isTTY = true
  input.setRawMode = () => {}
  const output = new Writable({ write(c, _e, cb) { this.buf += c.toString(); cb() } })
  output.buf = ''
  output.isTTY = true
  output.columns = 80

  const ctrl = createMultilineInput({ stdin: input, stdout: output, prompt: '> ', onSubmit: () => {} })
  ctrl.start()
  assert.ok(output.buf.includes('\x1b[?2004h'), 'start() 应开启 bracketed paste')

  ctrl.dispose()
  assert.ok(output.buf.includes('\x1b[?2004l'), 'dispose() 应关闭 bracketed paste')
})

test('光标移动后重绘会把光标移回编辑位置（输出含回移序列）', async () => {
  const { input, output } = makeEnv()
  output.columns = 80
  const ctrl = createMultilineInput({ stdin: input, stdout: output, prompt: '> ', onSubmit: () => {} })
  ctrl.start()

  input.write('abcdef')
  const before = output.buf.length
  input.write('\x1b[D') // ←
  input.write('\x1b[D') // ←
  await tick()

  const delta = output.buf.slice(before)
  // 光标回移到中间时会发出 \r 后紧跟水平右移序列
  assert.ok(/\r\x1b\[\d+C/.test(delta), `重绘应把光标移回中部，实际: ${JSON.stringify(delta)}`)
})

test('同一数据块内「括号粘贴 + 紧随的真 Enter」→ 只提交一次（不被突发兜底误判）', async () => {
  const { input, output } = makeEnv()
  const submitted = []
  const ctrl = createMultilineInput({
    stdin: input, stdout: output, prompt: '> ',
    onSubmit: (t) => submitted.push(t),
  })
  ctrl.start()

  // 粘贴与用户随后的 Enter 被终端合并进同一数据块
  input.write('\x1b[200~line1\nline2\x1b[201~\r')
  await tick()
  assert.deepStrictEqual(submitted, ['line1\nline2'])

  // 再输入 /exit 类命令仍能正常提交
  input.write('next')
  input.write('\r')
  await tick()
  assert.deepStrictEqual(submitted, ['line1\nline2', 'next'])
})

test('含括号标记的数据块：突发兜底不生效，普通 Enter 仍提交', async () => {
  const { input, output } = makeEnv()
  const submitted = []
  const ctrl = createMultilineInput({
    stdin: input, stdout: output, prompt: '> ',
    onSubmit: (t) => submitted.push(t),
  })
  ctrl.start()

  input.write('hello')            // 普通单行
  input.write('\x1b[200~p\x1b[201~\r') // 含标记的块（此处无换行）
  await tick()
  assert.deepStrictEqual(submitted, ['hellop'])
})

test('数据块 \\r/cmd\\r 不被突发兜底误判（换行前无内容）', async () => {
  const { input, output } = makeEnv()
  const submitted = []
  const ctrl = createMultilineInput({
    stdin: input, stdout: output, prompt: '> ',
    onSubmit: (t) => submitted.push(t),
  })
  ctrl.start()

  // 回车 + 命令 + 回车：两个回车各自都应「提交」，而非被当成粘贴插入换行
  input.write('\r')
  input.write('/help\r')
  await tick()
  assert.deepStrictEqual(submitted, ['', '/help'])
})

// ============================================================
//  大批粘贴折叠（[paste #n …]）+ 同步输出 + 残留冲刷
// ============================================================

test('大批粘贴（>10 行）折叠成 [paste #n …] 标记，提交时展开为完整原文', async () => {
  const { input, output } = makeEnv()
  output.columns = 80
  const submitted = []
  const ctrl = createMultilineInput({
    stdin: input, stdout: output, prompt: '> ',
    onSubmit: (t) => submitted.push(t),
  })
  ctrl.start()

  const big = Array.from({ length: 50 }, (_, i) => `line${i}`).join('\n')
  input.write('\x1b[200~' + big + '\x1b[201~')
  await tick()

  // 输入区回显的是折叠标记，而不是 50 行原文
  assert.ok(/\[paste #1 \+\d+ lines\]/.test(output.buf),
    `应折叠成标记，实际尾部: ${JSON.stringify(output.buf.slice(-160))}`)
  assert.ok(!output.buf.includes('line49'), '原文不应直接铺满输入区')

  input.write('\r')
  await tick()
  assert.deepStrictEqual(submitted, [big], '提交时应展开为完整原文')
})

test('大批粘贴（>1000 字符，行数少）折叠成 chars 标记', async () => {
  const { input, output } = makeEnv()
  output.columns = 80
  const submitted = []
  const ctrl = createMultilineInput({
    stdin: input, stdout: output, prompt: '> ',
    onSubmit: (t) => submitted.push(t),
  })
  ctrl.start()

  const big = 'x'.repeat(1500)
  input.write('\x1b[200~' + big + '\x1b[201~')
  await tick()
  assert.ok(/\[paste #1 \d+ chars\]/.test(output.buf),
    `应折叠成 chars 标记，实际: ${JSON.stringify(output.buf.slice(-120))}`)

  input.write('\r')
  await tick()
  assert.deepStrictEqual(submitted, [big])
})

test('小批量粘贴（≤10 行且 ≤1000 字符）不折叠，原样保留', async () => {
  const { input, output } = makeEnv()
  output.columns = 80
  const submitted = []
  const ctrl = createMultilineInput({
    stdin: input, stdout: output, prompt: '> ',
    onSubmit: (t) => submitted.push(t),
  })
  ctrl.start()

  input.write('\x1b[200~a\nb\nc\x1b[201~')
  await tick()
  assert.ok(!output.buf.includes('[paste #'), '小粘贴不应折叠')

  input.write('\r')
  await tick()
  assert.deepStrictEqual(submitted, ['a\nb\nc'])
})

test('折叠标记是原子单元：退格一次删掉整个标记', async () => {
  const { input, output } = makeEnv()
  output.columns = 80
  const submitted = []
  const ctrl = createMultilineInput({
    stdin: input, stdout: output, prompt: '> ',
    onSubmit: (t) => submitted.push(t),
  })
  ctrl.start()

  const big = Array.from({ length: 20 }, (_, i) => `L${i}`).join('\n')
  input.write('\x1b[200~' + big + '\x1b[201~')
  await tick()
  input.write('\x7f')     // 一次退格
  await tick()
  input.write('ok\r')
  await tick()
  assert.deepStrictEqual(submitted, ['ok'], '退格应整块删掉标记')
})

test('重绘使用同步输出（CSI 2026）包裹', async () => {
  const { input, output } = makeEnv()
  output.columns = 80
  const ctrl = createMultilineInput({ stdin: input, stdout: output, prompt: '> ', onSubmit: () => {} })
  ctrl.start()
  output.buf = ''          // 清掉 start() 的输出
  input.write('abc')
  await tick()
  assert.ok(output.buf.includes('\x1b[?2026h'), '应有同步输出开始序列')
  assert.ok(output.buf.includes('\x1b[?2026l'), '应有同步输出结束序列')
})

test('孤立 ESC：静默后按 escape 冲刷，后续 Enter 仍为普通提交（不被当 Alt+Enter）', async () => {
  const { input, output } = makeEnv()
  const submitted = []
  const ctrl = createMultilineInput({
    stdin: input, stdout: output, prompt: '> ',
    onSubmit: (t) => submitted.push(t),
  })
  ctrl.start()

  input.write('abc')
  input.write('\x1b')   // 单独 ESC，之后没有字符
  await tick()          // 30ms > 10ms，flush 应已触发
  input.write('\r')     // 若 ESC 未冲刷，\x1b\r 会被当 Alt+Enter 折行
  input.write('X')
  input.write('\r')
  await tick()

  assert.deepStrictEqual(submitted, ['abc', 'X'])
})
