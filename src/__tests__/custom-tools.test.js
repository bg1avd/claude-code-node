/**
 * 自定义工具加载器单元测试
 *
 * 背景：cc-node 原先只有"内置工具 + MCP"两种工具入口，用户每换一个子目录都要重新指路径。
 * 本次新增「机器级 ~/.cc-node/tools/ + 项目级 <cwd>/.claude-code/tools/」目录式自动加载。
 *
 * 覆盖：
 *   - normalizeTool：对象 / 函数 / 非法值 归一化
 *   - loadToolsFromDir：<name>/index.js 对象、默认导出函数、export const tools、.cjs、坏文件容错、目录缺失
 *   - loadCustomTools：优先级（extra > project），并自动补 package.json（ESM 解析）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  normalizeTool,
  loadToolsFromDir,
  loadCustomTools,
  machineToolsDir,
  projectToolsDir,
  expandHome,
} from '../tools/loadCustomTools.js'

async function tmp(prefix) {
  return mkdtemp(join(tmpdir(), prefix))
}

/** 在 dir/<name>/<file> 写入代码 */
async function writeTool(dir, name, file, code) {
  await mkdir(join(dir, name), { recursive: true })
  await writeFile(join(dir, name, file), code, 'utf8')
}

// ---------- normalizeTool ----------

test('normalizeTool：纯对象 → ToolDef（名字取兜底）', () => {
  const t = normalizeTool({ description: 'd', handler: () => 'x' }, 'my-tool')
  assert.ok(t)
  assert.equal(t.name, 'my-tool')
  assert.equal(t.description, 'd')
  assert.equal(t.permissionLevel, 'ask')
})

test('normalizeTool：显式 name/parameters/permissionLevel 生效', () => {
  const t = normalizeTool(
    { name: 'foo', description: 'd', parameters: { type: 'object' }, permissionLevel: 'deny', handler: () => 'x' },
    'ignored',
  )
  assert.equal(t.name, 'foo')
  assert.equal(t.permissionLevel, 'deny')
  assert.deepEqual(t.parameters, { type: 'object' })
})

test('normalizeTool：函数 → ToolDef（名字取兜底）', () => {
  const t = normalizeTool(async () => 'x', 'fn-tool')
  assert.ok(t)
  assert.equal(t.name, 'fn-tool')
})

test('normalizeTool：无 handler 的对象 → null', () => {
  assert.equal(normalizeTool({ name: 'x', description: 'd' }, 'x'), null)
})

// ---------- loadToolsFromDir ----------

test('loadToolsFromDir：<name>/index.js 默认导出对象', async () => {
  const dir = await tmp('ccn-ct-')
  await writeTool(dir, 'send-message', 'index.js', `
    export default { description: 'send', handler: async () => 'ok' }
  `)
  const { tools, errors } = await loadToolsFromDir(dir, { source: 'machine' })
  assert.equal(errors.length, 0)
  assert.equal(tools.length, 1)
  assert.equal(tools[0].name, 'send-message')
  assert.equal(tools[0]._source, 'machine')
})

test('loadToolsFromDir：默认导出函数 → 名字取目录名', async () => {
  const dir = await tmp('ccn-ct-')
  await writeTool(dir, 'chart', 'index.js', `export default function () { return 'chart' }`)
  const { tools } = await loadToolsFromDir(dir)
  assert.equal(tools.length, 1)
  assert.equal(tools[0].name, 'chart')
})

test('loadToolsFromDir：export const tools = [...] 多工具', async () => {
  const dir = await tmp('ccn-ct-')
  await writeTool(dir, 'multi', 'index.js', `
    export const tools = [
      { name: 'alpha', description: 'a', handler: () => 'a' },
      { name: 'beta',  description: 'b', handler: () => 'b' },
    ]
  `)
  const { tools } = await loadToolsFromDir(dir)
  assert.deepEqual(tools.map((t) => t.name).sort(), ['alpha', 'beta'])
})

test('loadToolsFromDir：<name>/index.cjs（CommonJS）也能加载', async () => {
  const dir = await tmp('ccn-ct-')
  await writeTool(dir, 'legacy', 'index.cjs', `
    module.exports = { name: 'legacy', description: 'cjs', handler: () => 'cjs-ok' }
  `)
  const { tools } = await loadToolsFromDir(dir)
  assert.equal(tools.length, 1)
  assert.equal(tools[0].name, 'legacy')
})

test('loadToolsFromDir：坏文件只报错、不抛', async () => {
  const dir = await tmp('ccn-ct-')
  await writeTool(dir, 'broken', 'index.js', `this is not valid js {`)
  const { tools, errors } = await loadToolsFromDir(dir)
  assert.equal(tools.length, 0)
  assert.equal(errors.length, 1)
})

test('loadToolsFromDir：目录不存在 → 空且无错', async () => {
  const { tools, errors } = await loadToolsFromDir('/no/such/dir/cc-node-really')
  assert.deepEqual(tools, [])
  assert.deepEqual(errors, [])
})

// ---------- loadCustomTools 优先级 ----------

test('loadCustomTools：extra 目录覆盖 项目级 同名工具', async () => {
  const project = await tmp('ccn-proj-')
  const extra = await tmp('ccn-extra-')
  await writeTool(join(project, '.claude-code', 'tools'), 'foo', 'index.js', `
    export default { name: 'foo', description: 'from-project', handler: () => 'p' }
  `)
  await writeTool(extra, 'foo', 'index.js', `
    export default { name: 'foo', description: 'from-extra', handler: () => 'e' }
  `)

  // 用空 HOME 隔离机器级目录（~/.cc-node/tools），避免真实环境干扰
  const home = await tmp('ccn-home-')
  const savedHome = process.env.HOME
  process.env.HOME = home
  try {
    const { tools, errors } = await loadCustomTools({ cwd: project, extraDirs: [extra] })
    assert.equal(errors.length, 0)
    const foo = tools.find((t) => t.name === 'foo')
    assert.ok(foo, 'foo 应被加载')
    assert.equal(foo.description, 'from-extra') // extra > project
    assert.equal(foo._source, 'config')
  } finally {
    process.env.HOME = savedHome
  }
})

test('machineToolsDir / projectToolsDir / expandHome 路径正确', () => {
  assert.match(machineToolsDir(), /\.cc-node[/\\]tools$/)
  assert.equal(projectToolsDir('/tmp/x'), join('/tmp/x', '.claude-code', 'tools'))
  assert.equal(expandHome('~/a'), join(process.env.HOME || '', 'a'))
  assert.equal(expandHome('/abs/path'), '/abs/path')
})
