/**
 * Telegram 版本汇报测试（v3.6.14）
 *
 * 背景：用户反馈"在 Telegram 命令里拿不到版本号"——查证属实，
 *       `/status` 只输出 uptime/channels/PID，**完全没有版本**。
 * 本文件保证：① 版本号有单一来源；② /status 与 /version 都汇报版本。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { CC_NODE_VERSION } from '../core/version.js'
import { t, setLanguage } from '../core/i18n.js'

test('版本号单一来源：与 package.json 一致', async () => {
  const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'))
  assert.equal(CC_NODE_VERSION, pkg.version)
  assert.match(CC_NODE_VERSION, /^\d+\.\d+\.\d+/, '版本号格式应为 x.y.z')
})

test('i18n：tg.status.version 中英文都能正确插值', (t2) => {
  t2.after(() => setLanguage('en'))
  setLanguage('zh')
  const zh = t('tg.status.version', { n: '3.6.14' })
  assert.ok(zh.includes('3.6.14'), `中文应含版本号，实际: ${zh}`)
  assert.ok(/版本/.test(zh), `中文文案应含"版本"，实际: ${zh}`)

  setLanguage('en')
  const en = t('tg.status.version', { n: '3.6.14' })
  assert.ok(en.includes('3.6.14'), `英文应含版本号，实际: ${en}`)
  assert.ok(/version/i.test(en), `英文文案应含 version，实际: ${en}`)
})

test('tg-listener：/status 与 /version 都汇报版本号（防回归）', async () => {
  const src = await readFile(new URL('../channel/tg-listener.js', import.meta.url), 'utf8')

  assert.ok(src.includes("from '../core/version.js'"), 'tg-listener 应导入 version 模块')

  const statusBlock = src.slice(src.indexOf("case '/status'"), src.indexOf("case '/run'"))
  assert.ok(
    statusBlock.includes("t('tg.status.version'"),
    '/status 的输出里必须包含版本号（用户反馈过这里拿不到版本）',
  )

  assert.ok(src.includes("case '/version'"), '应提供 /version 命令')
  assert.ok(src.includes('tg.help.sys.version'), '/help 里应列出 /version')
})
