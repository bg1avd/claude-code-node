#!/usr/bin/env node
/**
 * Pre-publish consistency check for @raolin2025/claude-code-node.
 *
 * 把「发布后才发现」的坑固化为机器检查（CI 与 npm publish 共用同一脚本）：
 *   1) 包名一致性 —— README 的安装/运行命令必须使用带 scope 的真实包名。
 *      背景：包名是 @raolin2025/claude-code-node；若 README 写成无 scope 的
 *      `claude-code-node`，用户会装到**别人的包**上。
 *   2) 依赖口径一致性 —— package.json 描述「Zero dependencies」，则 dependencies 必须为空。
 *   3) 发布内容白名单 —— `npm pack` 产物不得包含 .claude-code/（内含会话与 token）、
 *      .npmrc、内部文档、log/、*.tgz、src/__tests__/（测试不进产物）等；
 *      必须包含 LICENSE / README / src/index.js。
 *   4) 版本与 CHANGELOG —— 便于追溯（warning，不阻断救火发布）。
 *
 * 用法:
 *   node scripts/prepublish-check.js     # 手动
 *   npm run prepublish-check             # 同上
 *   npm publish                          # 由 prepublishOnly 自动强制执行
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const errors = []
const warnings = []

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

let pkg
try {
  pkg = JSON.parse(read('package.json'))
} catch (e) {
  console.error(`✖ 无法解析 package.json: ${e.message}`)
  process.exit(1)
}

const NAME = pkg.name                          // @raolin2025/claude-code-node
const BARE = NAME.replace(/^@[^/]+\//, '')     // claude-code-node
const deps = Object.keys(pkg.dependencies || {})

let readme = ''
try {
  readme = read('README.md')
} catch {
  errors.push('README.md 不存在或不可读')
}

/* ---------- 1. 包名一致性 ---------- */

if (!readme.includes(`npm install -g ${NAME}`)) {
  errors.push(`README 缺少正确的安装命令：npm install -g ${NAME}`)
}
if (!readme.includes(`npx ${NAME}`)) {
  errors.push(`README 缺少正确的运行命令：npx ${NAME}`)
}
// 负向断言：不得出现「安装/运行无 scope 裸名」的命令（会装到别人的包）
const bareInstall = new RegExp(`(?:npm (?:install|i|add)|yarn add|pnpm add)\\s+(?:-g\\s+)?${BARE}(?![\\w@/-])`)
if (bareInstall.test(readme)) {
  errors.push(`README 出现无 scope 安装命令（会装到别人的包）: npm install ${BARE}`)
}
const bareNpx = new RegExp(`npx\\s+${BARE}(?![\\w@/-])`)
if (bareNpx.test(readme)) {
  errors.push(`README 出现无 scope 运行命令（会跑到别人的包）: npx ${BARE}`)
}

/* ---------- 2. 依赖口径一致性 ---------- */

const claimsZero = /zero\s+dependencies|零依赖|零运行时依赖/i.test(String(pkg.description || ''))
if (claimsZero && deps.length > 0) {
  errors.push(`package.json 描述声称「零依赖」，但有 ${deps.length} 个运行时依赖：${deps.join(', ')}`)
}
if (deps.length === 0) {
  const m = readme.match(/\|\s*Dependencies\s*\|\s*([^|\n]+)\|/i)
  if (m && !/none|无|零/i.test(m[1])) {
    warnings.push(`README 对比表 Dependencies 行写着「${m[1].trim()}」，但实际零依赖`)
  }
}

/* ---------- 3. 版本 / Changelog ---------- */

const esc = pkg.version.replace(/\./g, '\\.')
if (!new RegExp(`^##\\s*v?${esc}\\b`, 'm').test(read('CHANGELOG.md'))) {
  warnings.push(`CHANGELOG.md 缺少 v${pkg.version} 小节（建议补上）`)
}

/* ---------- 4. 发布内容白名单（真实 npm pack 产物） ---------- */

const FORBIDDEN = [
  [/^\.claude-code\//, 'AI 会话/配置目录 .claude-code/（可能含 token 与内网信息）'],
  [/^\.claude-code-safe-trash\//, '本地回收目录'],
  [/^log\//, '本地日志目录 log/'],
  [/^scripts\//, '内部脚本 scripts/'],
  [/^node_modules\//, 'node_modules/'],
  [/(^|\/)\.git($|\/)/, 'git 元数据'],
  [/(^|\/)\.npmrc$/, '含有 auth token 的 .npmrc'],
  [/(^|\/)\.env/, '环境变量文件'],
  [/^PROJECT_MEMORY\.md$/, '私有记忆文档 PROJECT_MEMORY.md'],
  [/^CI_NPM_RELEASE_GUIDE\.md$/, '内部发布手册 CI_NPM_RELEASE_GUIDE.md'],
  [/^cc-local-backup-/, '本地备份包'],
  [/^qqbot\.json$/, 'QQ Bot 密钥 qqbot.json'],
  [/\.tgz$/, '打包产物自身'],
  [/\.md$/, '内部文档（README.md 除外）'],
]

const REQUIRED = ['package.json', 'README.md', 'LICENSE', 'src/index.js']

let packedFiles = null
try {
  const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const out = execFileSync(npmBin, ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  })
  const parsed = JSON.parse(out)
  const entry = Array.isArray(parsed) ? parsed[0] : parsed[Object.keys(parsed)[0]]
  packedFiles = entry.files.map((f) => f.path)
} catch (e) {
  errors.push(`npm pack --dry-run 失败: ${String(e.stderr || e.message || '').trim().split('\n')[0]}`)
}

if (packedFiles) {
  for (const file of packedFiles) {
    if (file === 'README.md') continue
    for (const [re, label] of FORBIDDEN) {
      if (re.test(file)) errors.push(`发布产物包含不应发布的${label}: ${file}`)
    }
  }
  for (const required of REQUIRED) {
    if (!packedFiles.includes(required)) errors.push(`发布产物缺少必需文件: ${required}`)
  }
  const testCount = packedFiles.filter((f) => f.startsWith('src/__tests__/')).length
  if (testCount > 0) {
    errors.push(`发布产物含 ${testCount} 个测试文件 —— files 白名单必须排除 src/__tests__/（当前 files=${JSON.stringify(pkg.files)}）`)
  }
  if (!Array.isArray(pkg.files) || !pkg.files.includes('!src/__tests__/')) {
    errors.push('package.json files 缺少 "!src/__tests__/"（测试文件不得进入发布产物）')
  }
}

/* ---------- 报告 ---------- */

console.log(`prepublish-check ${NAME} v${pkg.version}`)
console.log(`  README 包名 / 依赖口径：已核对`)
if (packedFiles) console.log(`  npm pack 产物：${packedFiles.length} 个文件，白名单校验完成`)

if (warnings.length > 0) {
  console.log('\n⚠️  警告：')
  warnings.forEach((w) => console.log(`  - ${w}`))
}

if (errors.length > 0) {
  console.error('\n✖ 发布前检查未通过：')
  errors.forEach((e) => console.error(`  - ${e}`))
  process.exit(1)
}

console.log('\n✅ 发布前检查全部通过')
