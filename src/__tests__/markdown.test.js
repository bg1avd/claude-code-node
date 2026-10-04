// ============================================================
//  markdown.test.js — Markdown → Telegram 富格式/HTML 转换单测
//  运行：node --test src/__tests__/markdown.test.js
// ============================================================
import { test } from 'node:test'
import assert from 'node:assert'
import {
  escapeHtml, markdownToTelegramHtml, splitMarkdown,
  RICH_MAX_LEN, CLASSIC_MAX_LEN,
} from '../utils/markdown.js'

test('escapeHtml: 转义 & < >', () => {
  assert.equal(escapeHtml('a & b <c> "d"'), 'a &amp; b &lt;c&gt; "d"')
})

test('粗体/斜体/删除线 → HTML', () => {
  assert.equal(markdownToTelegramHtml('**粗体**'), '<b>粗体</b>')
  assert.equal(markdownToTelegramHtml('__粗体__'), '<b>粗体</b>')
  assert.equal(markdownToTelegramHtml('*斜体*'), '<i>斜体</i>')
  assert.equal(markdownToTelegramHtml('~~删除~~'), '<s>删除</s>')
})

test('行内代码优先，内部不再解析 markdown', () => {
  assert.equal(markdownToTelegramHtml('`a **b** c`'), '<code>a **b** c</code>')
})

test('代码里的 HTML 特殊字符被转义（不再触发 Telegram 400）', () => {
  const out = markdownToTelegramHtml('```\n<div> & </div>\n```')
  assert.equal(out, '<pre><code>&lt;div&gt; &amp; &lt;/div&gt;</code></pre>')
})

test('围栏代码块（带语言标注）', () => {
  const out = markdownToTelegramHtml('```js\nconsole.log(1)\n```')
  assert.equal(out, '<pre><code>console.log(1)</code></pre>')
})

test('链接与图片', () => {
  assert.equal(markdownToTelegramHtml('[TG](https://t.me)'), '<a href="https://t.me">TG</a>')
  assert.equal(markdownToTelegramHtml('![alt](https://x/y.png)'), '<a href="https://x/y.png">alt</a>')
})

test('不安全 URL 的引号被转义', () => {
  const out = markdownToTelegramHtml('[x](https://a/"b")')
  assert.ok(out.includes('&quot;'), 'url 中的双引号应转义')
})

test('标题 → <b>；分隔线 → 等宽划线', () => {
  assert.equal(markdownToTelegramHtml('## 标题'), '<b>标题</b>')
  assert.equal(markdownToTelegramHtml('---'), '────────────')
})

test('列表 → 项目符号纯文本', () => {
  assert.equal(markdownToTelegramHtml('- a\n- b'), '• a\n• b')
  assert.equal(markdownToTelegramHtml('1. a\n2. b'), '1. a\n2. b')
})

test('引用块合并', () => {
  assert.equal(markdownToTelegramHtml('> a\n> b'), '<blockquote>a\nb</blockquote>')
})

test('表格 → <pre> 等宽伪表格（降级）', () => {
  const md = '| A | BB |\n|:--|--:|\n| 1 | 2 |'
  const out = markdownToTelegramHtml(md)
  assert.ok(out.startsWith('<pre>') && out.endsWith('</pre>'), '表格应转成 pre')
  assert.ok(out.includes('A') && out.includes('BB') && out.includes('1') && out.includes('2'))
  const rows = out.slice(5, -6).split('\n')
  assert.equal(rows.length, 2, '表头 + 1 数据行 = 2 行')
})

test('snake_case 不被误判为斜体', () => {
  assert.equal(markdownToTelegramHtml('foo_bar_baz'), 'foo_bar_baz')
})

test('splitMarkdown: 短文本不切', () => {
  assert.deepEqual(splitMarkdown('hello', 100), ['hello'])
})

test('splitMarkdown: 超长按行切分', () => {
  const text = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n')
  const parts = splitMarkdown(text, 60)
  assert.ok(parts.length > 1)
  // 拼回无损
  assert.equal(parts.join('\n'), text)
  for (const p of parts) assert.ok([...p].length <= 60 || !p.includes('\n'))
})

test('splitMarkdown: 代码围栏可容纳时不被切断', () => {
  const code = '```\nconst x = 1\nconst y = 2\n```'
  const text = Array.from({ length: 10 }, (_, i) => `普通行 ${i} ${'x'.repeat(20)}`).join('\n') + '\n' + code
  const parts = splitMarkdown(text, 60)
  const owner = parts.filter(p => p.includes('const x = 1'))
  assert.equal(owner.length, 1, '代码块应在同一个分片内')
  assert.ok(owner[0].includes('const y = 2') && owner[0].includes('```'))
  assert.equal((owner[0].match(/```/g) || []).length % 2, 0, '围栏应成对')
})

test('splitMarkdown: 超大单行必须硬切', () => {
  const line = 'x'.repeat(250)
  const parts = splitMarkdown(line, 100)
  assert.equal(parts.length, 3)
  assert.equal(parts.join(''), line)
})

test('splitMarkdown: 单行超长硬切', () => {
  const parts = splitMarkdown('x'.repeat(250), 100)
  assert.equal(parts.length, 3)
  assert.equal(parts.join(''), 'x'.repeat(250))
})

test('常量：富消息 32768 / 旧接口 4096', () => {
  assert.equal(RICH_MAX_LEN, 32768)
  assert.equal(CLASSIC_MAX_LEN, 4096)
})
