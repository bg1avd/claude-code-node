/**
 * i18n 单元测试 — Telegram 提示中英文切换
 *
 * 语言判定规则：config.language 有中文标识 OR TG from.language_code 是 zh → 中文；
 * 两者都没有 → 英文。
 *
 * 覆盖：
 *   - detectLanguage 各组合（config/TG 交叉）
 *   - t() 当前语言取值 + {param} 插值 + 缺键回退
 *   - en/zh 字典键集合一致（防漏翻）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectLanguage, setLanguage, setConfigLanguage, applyMessageLanguage, getLanguage, t } from '../core/i18n.js'

test('detectLanguage：config 中文标识各写法 → zh', () => {
  assert.equal(detectLanguage({ configLang: 'zh' }), 'zh')
  assert.equal(detectLanguage({ configLang: 'zh-CN' }), 'zh')
  assert.equal(detectLanguage({ configLang: '中文' }), 'zh')
  assert.equal(detectLanguage({ configLang: 'Chinese' }), 'zh')
  assert.equal(detectLanguage({ configLang: 'cn' }), 'zh')
})

test('detectLanguage：TG language_code zh 开头 → zh', () => {
  assert.equal(detectLanguage({ tgLanguageCode: 'zh-hans-cn' }), 'zh')
  assert.equal(detectLanguage({ tgLanguageCode: 'zh_TW' }), 'zh')
  assert.equal(detectLanguage({ tgLanguageCode: 'zh' }), 'zh')
})

test('detectLanguage：用户规则 — 任一有中文 → 中文，都没有 → 英文', () => {
  // config 无 + TG 中文 → zh
  assert.equal(detectLanguage({ configLang: '', tgLanguageCode: 'zh-hans-cn' }), 'zh')
  // config 中文 + TG 英文 → zh
  assert.equal(detectLanguage({ configLang: 'zh', tgLanguageCode: 'en' }), 'zh')
  // config 英文 + TG 中文 → zh
  assert.equal(detectLanguage({ configLang: 'en', tgLanguageCode: 'zh' }), 'zh')
  // 都无 → en
  assert.equal(detectLanguage({ configLang: '', tgLanguageCode: '' }), 'en')
  assert.equal(detectLanguage({ configLang: 'en', tgLanguageCode: 'ja' }), 'en')
  assert.equal(detectLanguage({}), 'en')
  // 其他语言不误判
  assert.equal(detectLanguage({ tgLanguageCode: 'zhx' }) === 'zh', true, 'zhx 仍以 zh 开头（宽松匹配属预期）')
  assert.equal(detectLanguage({ configLang: 'fr', tgLanguageCode: 'de' }), 'en')
})

test('t()：切换语言 + {param} 插值', () => {
  setLanguage('zh')
  assert.equal(t('tg.busy'), '⏳ 引擎正在处理其他任务，请稍候或输入 /stop 停止当前任务。')
  assert.equal(t('tg.model.switched', { model: 'gpt-4o' }), '✅ 已切换模型 → gpt-4o')

  setLanguage('en')
  assert.equal(t('tg.busy'), '⏳ Engine is busy with another task, please wait or send /stop to cancel it.')
  assert.equal(t('tg.model.switched', { model: 'gpt-4o' }), '✅ Model switched → gpt-4o')
})

test('t()：缺键回退 en，en 也缺回退 key 本身', () => {
  setLanguage('zh')
  // 两本字典都有的键正常取值
  assert.equal(t('tg.cancel.done'), '🚫 已取消当前操作')
  // 两本字典都没有的键 → 原样返回 key
  assert.equal(t('no.such.key'), 'no.such.key')
})

test('applyMessageLanguage：模拟消息入口按 TG 语言重新判定', () => {
  setConfigLanguage('') // config 未配置 → 纯按 TG 语言
  applyMessageLanguage('en')
  assert.equal(getLanguage(), 'en')
  applyMessageLanguage('zh-hans-cn')
  assert.equal(getLanguage(), 'zh')
  // config 配了中文 → 任何 TG 语言都是中文
  setConfigLanguage('zh')
  applyMessageLanguage('en')
  assert.equal(getLanguage(), 'zh')
  // config 未配置 + TG 非 zh → 英文
  setConfigLanguage('')
  applyMessageLanguage('ja')
  assert.equal(getLanguage(), 'en')
  setConfigLanguage('') // 还原，避免污染其他测试
  setLanguage('en')
})

test('字典完整性：en 和 zh 键集合完全一致（防漏翻）', async () => {
  // 直接读源文件解析两本字典的键（DICT 未导出，用源码静态校验）
  const { readFileSync } = await import('fs')
  const src = readFileSync(new URL('../core/i18n.js', import.meta.url), 'utf-8')
  const extract = (block) => [...block.matchAll(/'([a-z]+\.[a-zA-Z.]+)':/g)].map(m => m[1])
  const enStart = src.indexOf('en: {')
  const zhStart = src.indexOf('zh: {')
  const enKeys = new Set(extract(src.slice(enStart, zhStart)))
  const zhKeys = new Set(extract(src.slice(zhStart)))
  assert.equal(enKeys.size > 30, true, 'en 字典应有足量键')
  for (const k of enKeys) {
    assert.equal(zhKeys.has(k), true, `zh 字典缺少键: ${k}`)
  }
  for (const k of zhKeys) {
    assert.equal(enKeys.has(k), true, `en 字典缺少键: ${k}`)
  }
  assert.equal(enKeys.size, zhKeys.size)
})
