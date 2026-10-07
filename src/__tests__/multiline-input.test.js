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

// v3.6.9 起语义：Enter(CR) = 折行；发送用显式外部键 Ctrl+S（\x13）
const SUBMIT = '\x13'
const ENTER = '\r'

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
  input.write(SUBMIT) // Enter → 提交

  await tick()
  assert.deepStrictEqual(submitted, ['第一行\n第二行'])
})

test('提交后紧随的 LF 残留被忽略，不产生脏输入', async () => {
  const { input, output } = makeEnv()
  const submitted = []
  const ctrl = createMultilineInput({
    stdin: input, stdout: output, prompt: '> ',
    onSubmit: (t) => submitted.push(t),
  })
  ctrl.start()

  input.write('A段')
  input.write(SUBMIT)
  input.write('\n') // 提交后残留的 LF → 应被忽略
  input.write('B段')
  input.write(SUBMIT)

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
  input.write(SUBMIT)
  input.write('文章二')
  input.write(SUBMIT)

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
  input.write(SUBMIT)
  input.write('\x1b[A') // 上方向键
  input.write(SUBMIT)

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
  input.write(SUBMIT)

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
  input.write(SUBMIT)
  await p

  // 提问结束后，主输入缓冲应为空，输入新内容提交正常
  input.write('新输入')
  input.write(SUBMIT)
  await tick()
  assert.deepStrictEqual(submitted, ['新输入'])
})

test('单行输入回显稳定（关闭软键行时）：不发出光标上移\\x1b[1A', async () => {
  const { input, output } = makeEnv()
  output.columns = 80
  const ctrl = createMultilineInput({
    stdin: input, stdout: output, prompt: '> ',
    onSubmit: () => {},
    softkeys: false,
  })
  ctrl.start()

  input.write('hello')
  await tick()

  const raw = output.buf
  // 单行输入且无软键行时，绝不出现光标上移序列（会导致屏幕乱跳）
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

test('Alt+Enter（Esc+Enter）折行、Ctrl+S 发送 — 跨终端可靠多行输入', async () => {
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
  // 第二行 + Ctrl+S 发送
  input.write('第二行')
  input.write(SUBMIT)

  await tick()
  assert.deepStrictEqual(submitted, ['第一行\n第二行'])
})

test('新默认语义：Enter = 折行（不发送），Ctrl+S = 发送', async () => {
  const { input, output } = makeEnv()
  const submitted = []
  const ctrl = createMultilineInput({
    stdin: input, stdout: output, prompt: '> ',
    onSubmit: (t) => submitted.push(t),
  })
  ctrl.start()

  input.write('hello')
  input.write(ENTER)      // Enter 只折行，绝不发送
  input.write('world')
  await tick()
  assert.deepStrictEqual(submitted, [], 'Enter 不应触发发送')

  input.write(SUBMIT)     // 显式外部键才发送
  await tick()
  assert.deepStrictEqual(submitted, ['hello\nworld'])
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
  input.write(ENTER)    // 随后的 Enter → 应视为 Alt+Enter 折行
  input.write('第二行')
  input.write(SUBMIT)   // Ctrl+S 发送

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
  input.write(SUBMIT)       // 普通 Enter 提交

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
  input.write(SUBMIT)

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
  input.write(SUBMIT)
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
  input.write(SUBMIT)

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

  input.write(SUBMIT) // 用户真正按 Enter
  await tick()
  assert.deepStrictEqual(submitted, ['line1\nline2'])
})

test('单独的 \\r 数据块只折行，不再发送（不误判为粘贴）', async () => {
  const { input, output } = makeEnv()
  const submitted = []
  const ctrl = createMultilineInput({
    stdin: input, stdout: output, prompt: '> ',
    onSubmit: (t) => submitted.push(t),
  })
  ctrl.start()

  input.write('abc')
  input.write('\r') // 单独一块：换行前有内容，但不构成「多行粘贴」→ 折行
  await tick()
  assert.deepStrictEqual(submitted, [], 'Enter 应折行而非发送')

  input.write(SUBMIT)
  await tick()
  assert.deepStrictEqual(submitted, ['abc\n'])
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
  input.write(SUBMIT)

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
  input.write(SUBMIT)

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
  input.write(SUBMIT)

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
  input.write(SUBMIT)

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
  input.write(SUBMIT)

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
  input.write(SUBMIT)

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
  input.write(SUBMIT)
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
  input.write(SUBMIT)
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

test('同一数据块内「括号粘贴 + 紧随的 Ctrl+S」→ 只发送一次（不被突发兜底误判）', async () => {
  const { input, output } = makeEnv()
  const submitted = []
  const ctrl = createMultilineInput({
    stdin: input, stdout: output, prompt: '> ',
    onSubmit: (t) => submitted.push(t),
  })
  ctrl.start()

  // 粘贴与用户随后的发送键被终端合并进同一数据块
  input.write('\x1b[200~line1\nline2\x1b[201~\x13')
  await tick()
  assert.deepStrictEqual(submitted, ['line1\nline2'])

  // 再输入 /exit 类命令仍能正常发送
  input.write('next')
  input.write(SUBMIT)
  await tick()
  assert.deepStrictEqual(submitted, ['line1\nline2', 'next'])
})

test('含括号标记的数据块：突发兜底不生效，Ctrl+S 仍发送', async () => {
  const { input, output } = makeEnv()
  const submitted = []
  const ctrl = createMultilineInput({
    stdin: input, stdout: output, prompt: '> ',
    onSubmit: (t) => submitted.push(t),
  })
  ctrl.start()

  input.write('hello')            // 普通单行
  input.write('\x1b[200~p\x1b[201~\x13') // 含标记的块（此处无换行）
  await tick()
  assert.deepStrictEqual(submitted, ['hellop'])
})

test('单独的 CR 不被突发兜底误判（换行前无内容）', async () => {
  const { input, output } = makeEnv()
  const submitted = []
  const ctrl = createMultilineInput({
    stdin: input, stdout: output, prompt: '> ',
    onSubmit: (t) => submitted.push(t),
  })
  ctrl.start()

  // 单独的 CR（换行前无内容）不构成突发粘贴 → 应折行；随后命令用 Ctrl+S 发送
  input.write('\r')
  input.write('/help')
  input.write(SUBMIT)
  await tick()
  assert.deepStrictEqual(submitted, ['\n/help'])
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

  input.write(SUBMIT)
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

  input.write(SUBMIT)
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

  input.write(SUBMIT)
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
  input.write('ok\x13')
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
  input.write(SUBMIT)     // 若 ESC 未冲刷，\x1b\r 会被当 Alt+Enter 折行
  input.write('X')
  input.write(SUBMIT)
  await tick()

  assert.deepStrictEqual(submitted, ['abc', 'X'])
})

// ============================================================
//  软键行（输入区下方的键位提示；由当前绑定实时生成）
// ============================================================

test('软键行默认显示：发送键 + 折行提示', async () => {
  const { input, output } = makeEnv()
  output.columns = 80
  const ctrl = createMultilineInput({ stdin: input, stdout: output, prompt: '> ', onSubmit: () => {} })
  ctrl.start()
  await tick()
  const raw = output.buf
  assert.ok(raw.includes('发送'), '应显示「发送」提示')
  assert.ok(raw.includes('^S'), '应显示发送键 Ctrl+S 的标签')
  assert.ok(raw.includes('折行'), '应显示「折行」提示')
})

test('软键行随用户改键自动跟随', async () => {
  const { input, output } = makeEnv()
  output.columns = 80
  const ctrl = createMultilineInput({
    stdin: input, stdout: output, prompt: '> ', onSubmit: () => {},
    keybindings: { submit: ['ctrl+g'], newline: ['enter'] },
  })
  ctrl.start()
  await tick()
  const raw = output.buf
  assert.ok(raw.includes('^G'), '应显示用户自定义的发送键')
  assert.ok(!raw.includes('^S'), '不应再显示默认发送键')
})

test('softkeys:false 关闭软键行', async () => {
  const { input, output } = makeEnv()
  output.columns = 80
  const ctrl = createMultilineInput({
    stdin: input, stdout: output, prompt: '> ', onSubmit: () => {}, softkeys: false,
  })
  ctrl.start()
  await tick()
  assert.ok(!output.buf.includes('发送'), '关闭时不应出现软键行')
})

test('softkeys 数组：只显示指定动作', async () => {
  const { input, output } = makeEnv()
  output.columns = 80
  const ctrl = createMultilineInput({
    stdin: input, stdout: output, prompt: '> ', onSubmit: () => {}, softkeys: ['submit'],
  })
  ctrl.start()
  await tick()
  const raw = output.buf
  assert.ok(raw.includes('发送'), '应显示发送')
  assert.ok(!raw.includes('折行'), '未指定折行则不应显示')
})

// ============================================================
//  焦点模式：输入区 ↔ 虚拟按键区（F2 切换）—— TUI 式选择器
// ============================================================

const F2 = '\x1bOQ'
const ARROW_R = '\x1b[C'

test('F2 切到虚拟按键区：隐藏硬件光标并高亮首项', async () => {
  const { input, output } = makeEnv()
  output.columns = 80
  const ctrl = createMultilineInput({ stdin: input, stdout: output, prompt: '> ', onSubmit: () => {} })
  ctrl.start()
  input.write('abc')
  await tick()
  output.buf = ''
  input.write(F2)
  await tick()
  const raw = output.buf
  assert.ok(raw.includes('\x1b[?25l'), '应隐藏硬件光标')
  assert.ok(raw.includes('▸^S 发送◂'), `应高亮首项「发送」，实际: ${JSON.stringify(raw.slice(-160))}`)
})

test('软键模式下 ←/→ 移动高亮', async () => {
  const { input, output } = makeEnv()
  output.columns = 80
  const ctrl = createMultilineInput({ stdin: input, stdout: output, prompt: '> ', onSubmit: () => {} })
  ctrl.start()
  input.write(F2)
  await tick()
  output.buf = ''
  input.write(ARROW_R)
  await tick()
  assert.ok(output.buf.includes('▸⏎ 折行◂'), `→ 应把高亮移到「折行」，实际: ${JSON.stringify(output.buf.slice(-160))}`)
})

test('软键模式下 Enter 激活高亮按键（发送）', async () => {
  const { input, output } = makeEnv()
  output.columns = 80
  const submitted = []
  const ctrl = createMultilineInput({
    stdin: input, stdout: output, prompt: '> ',
    onSubmit: (t) => submitted.push(t),
  })
  ctrl.start()
  input.write('hello')
  input.write(F2)      // 焦点移入虚拟按键区（默认停在「发送」）
  await tick()
  assert.deepStrictEqual(submitted, [], '切到软键模式不应发送')
  input.write(ENTER)   // Enter 现在是「激活」而非折行
  await tick()
  assert.deepStrictEqual(submitted, ['hello'])
})

test('F2 可来回切换；回到输入模式后恢复光标且高亮消失', async () => {
  const { input, output } = makeEnv()
  output.columns = 80
  const ctrl = createMultilineInput({ stdin: input, stdout: output, prompt: '> ', onSubmit: () => {} })
  ctrl.start()
  input.write(F2)
  await tick()
  output.buf = ''
  input.write(F2)      // 再按一次 → 回输入模式
  await tick()
  const raw = output.buf
  assert.ok(raw.includes('\x1b[?25h'), '应恢复硬件光标')
  assert.ok(!raw.includes('▸'), '不应再有高亮')
})

test('软键模式下 Esc 回到输入模式', async () => {
  const { input, output } = makeEnv()
  output.columns = 80
  const ctrl = createMultilineInput({ stdin: input, stdout: output, prompt: '> ', onSubmit: () => {} })
  ctrl.start()
  input.write(F2)
  await tick()
  output.buf = ''
  input.write('\x1b')   // 单独 Esc → 10ms 后被 flush 成 escape 键
  await tick()
  assert.ok(output.buf.includes('\x1b[?25h'), 'Esc 应回到输入模式并恢复光标')
})

test('软键模式下直接打字 → 自动切回输入模式并插入该字符', async () => {
  const { input, output } = makeEnv()
  output.columns = 80
  const submitted = []
  const ctrl = createMultilineInput({
    stdin: input, stdout: output, prompt: '> ',
    onSubmit: (t) => submitted.push(t),
  })
  ctrl.start()
  input.write('ab')
  input.write(F2)
  await tick()
  input.write('c')     // 打字 → 自动回输入模式并插入
  await tick()
  input.write(SUBMIT)
  await tick()
  assert.deepStrictEqual(submitted, ['abc'])
})

test('softkeys-toggle 可重映射（F2 解绑、改用 Ctrl+G）', async () => {
  const { input, output } = makeEnv()
  output.columns = 80
  const ctrl = createMultilineInput({
    stdin: input, stdout: output, prompt: '> ', onSubmit: () => {},
    keybindings: { 'softkeys-toggle': ['ctrl+g'] },
  })
  ctrl.start()
  output.buf = ''
  input.write(F2)
  await tick()
  assert.ok(!output.buf.includes('\x1b[?25l'), 'F2 已解绑，不应切换')
  input.write('\x07')  // Ctrl+G
  await tick()
  assert.ok(output.buf.includes('\x1b[?25l'), 'Ctrl+G 应切换')
})

test('softkeys:false 时 F2 不生效（没有可切换的按键）', async () => {
  const { input, output } = makeEnv()
  output.columns = 80
  const ctrl = createMultilineInput({
    stdin: input, stdout: output, prompt: '> ', onSubmit: () => {}, softkeys: false,
  })
  ctrl.start()
  output.buf = ''
  input.write(F2)
  await tick()
  assert.ok(!output.buf.includes('\x1b[?25l'), '无软键行时不应进入软键模式')
})
