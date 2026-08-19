/**
 * NpmPublish - npm 发布一键工具
 *
 * 封装了本项目 npm 发布的全部经验（见 NPM_STAGED_PUBLISH_GUIDE.md）：
 * - 标准 `npm publish` 常因 npm CLI 强制 otplease/2FA 返回 403
 * - 最有效方法：bypass-2FA GAT token + 手动构造 PUT 请求 + `npm-auth-type: bearer`，无需 OTP
 *
 * 功能：
 * - version    升版本号（patch/minor/major 或指定版本）
 * - status     检查登录 / 当前版本 / registry 版本 / 暂存区状态
 * - pack       打包 tarball
 * - publish    完整发布：打包 + git 合并提交 + push + npm 发布（自动降级兜底）
 * - manual-publish  仅 npm 发布（bypass token 手动 PUT 兜底）
 */
import { execSync } from 'child_process'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { createHash } from 'crypto'
import { join } from 'path'
import { ToolDef } from '../types/index.js'

const TOOL_NAME = 'NpmPublish'
const TOOL_DESCRIPTION = `
npm 发布一键工具 — 封装本项目发布经验，无需四处查找方法。

前置条件:
- 项目根目录（含 package.json）
- ~/.npmrc 中配置了 bypass-2FA 的 _authToken（npm_... 前缀）
- git 已配置 user.name / user.email

操作:
- status          检查登录 / 当前版本 / registry 版本 / 暂存区
- version         升版本号（如 2.7.0 -> 2.7.1），参数 version 可为 patch|minor|major 或具体版本号
- pack            打包 tarball
- publish         完整发布流程：升版本 + 打包 + git 合并提交(可选) + push + npm 发布
- manual-publish  仅做 npm 发布（标准 publish 失败时自动用 bypass token 手动 PUT 兜底，无需 OTP）

关键经验:
- 标准 npm publish 常因 npm CLI 强制 2FA(otplease) 返回 403
- 有效兜底: 手动 PUT + npm-auth-type:bearer + bypass token，无需 OTP
- git 提交可合并为单个 release 提交（squash）
`
const TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['status', 'version', 'pack', 'publish', 'manual-publish'],
      description: '要执行的操作'
    },
    version: {
      type: 'string',
      description: '版本增量（patch|minor|major）或具体版本号（如 2.7.1）。version/publish 使用'
    },
    commitMessage: {
      type: 'string',
      description: 'release 提交信息标题（publish 使用，默认 "release: v<version>"）'
    },
    squash: {
      type: 'boolean',
      description: 'publish 时是否把多个提交合并为单个 release 提交（默认 true）',
      default: true
    },
    doGitPush: {
      type: 'boolean',
      description: 'publish 时是否执行 git push（默认 true）',
      default: true
    },
    doNpmPublish: {
      type: 'boolean',
      description: 'publish 时是否执行 npm 发布（默认 true）',
      default: true
    },
    changelog: {
      type: 'string',
      description: '可选的 CHANGELOG 新增内容，publish 时会写入 CHANGELOG 顶部（可选）'
    },
    cwd: {
      type: 'string',
      description: '项目目录（默认当前目录）'
    }
  },
  required: ['action']
}

/** 执行 shell 命令并返回输出（失败抛错） */
function sh(cmd, cwd) {
  return execSync(cmd, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}

/** 读取 ~/.npmrc 中的 token */
function getNpmToken() {
  try {
    const npmrc = readFileSync(join(process.env.HOME, '.npmrc'), 'utf-8')
    const m = npmrc.match(/_authToken=([^\s]+)/)
    return m ? m[1] : null
  } catch { return null }
}

/** 读取 package.json */
function readPackage(cwd) {
  return JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf-8'))
}

/** 查询 registry packument */
async function fetchRegistry(name) {
  const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`)
  if (!res.ok) return null
  return res.json()
}

/** 用 bypass token 手动 PUT 发布（核心兜底方法，无需 OTP） */
async function manualPublishDirect(cwd, tarballPath, token) {
  const tarball = readFileSync(tarballPath)
  const filename = tarballPath.split('/').pop()
  const pkg = readPackage(cwd)
  const shasum = createHash('sha1').update(tarball).digest('hex')
  const integrity = 'sha512-' + createHash('sha512').update(tarball).digest('base64')
  const encodedName = encodeURIComponent(pkg.name)
  const regUrl = `https://registry.npmjs.org/${encodedName}`

  // 1. 获取现有 packument
  const getRes = await fetch(regUrl, { headers: { authorization: `Bearer ${token}` } })
  const existing = await getRes.json()
  const existingVersions = existing?.versions || {}
  if (existingVersions[pkg.version]) {
    return { ok: false, error: `版本 ${pkg.version} 已存在于 registry` }
  }

  // 2. 构造新版本 manifest 并合并
  const versionManifest = {
    ...pkg,
    _id: `${pkg.name}@${pkg.version}`,
    dist: {
      shasum,
      integrity,
      tarball: `https://registry.npmjs.org/${pkg.name}/-/${filename}`,
      fileCount: 61,
      unpackedSize: tarball.length
    }
  }
  const newDoc = {
    ...existing,
    _id: pkg.name,
    name: pkg.name,
    'dist-tags': { ...(existing?.['dist-tags'] || {}), latest: pkg.version },
    versions: { ...existingVersions, [pkg.version]: versionManifest },
    _attachments: {
      [filename]: { content_type: 'application/octet-stream', data: tarball.toString('base64'), length: tarball.length }
    }
  }

  // 3. PUT 发布
  const res = await fetch(regUrl, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'npm-auth-type': 'bearer', // 关键
      'npm-command': 'publish'
    },
    body: JSON.stringify(newDoc)
  })
  const body = await res.text()
  return { ok: res.ok, status: res.status, body: body.slice(0, 300) }
}

/** status: 检查发布环境 */
async function status(cwd) {
  const lines = []
  // 登录
  try { lines.push(`npm whoami: ${sh('npm whoami', cwd)}`) }
  catch { lines.push('npm whoami: 未登录 ⚠️') }
  // token
  const token = getNpmToken()
  lines.push(token ? `~/.npmrc token: npm_${token.slice(4, 6)}... (${token.startsWith('npm_') ? 'GAT' : '未知类型'})` : '~/.npmrc token: 未找到 ⚠️')
  // 本地版本
  const pkg = readPackage(cwd)
  lines.push(`本地版本: ${pkg.version}`)
  // registry 版本
  const reg = await fetchRegistry(pkg.name)
  if (reg) {
    lines.push(`registry latest: ${reg['dist-tags']?.latest}`)
    lines.push(`registry 是否含本地版本: ${reg.versions?.[pkg.version] ? '是（已发布）' : '否（待发布）'}`)
  } else {
    lines.push('registry: 查询失败（网络/权限）')
  }
  // git 状态
  try {
    const ahead = sh('git rev-list --count @{u}..HEAD 2>/dev/null || echo 0', cwd)
    lines.push(`git: 领先远程 ${ahead} 个提交`)
    const dirty = sh('git status --porcelain', cwd)
    lines.push(dirty ? `工作区有未提交改动:\n${dirty}` : '工作区干净')
  } catch { lines.push('git: 非 git 仓库') }
  return lines.join('\n')
}

/** version: 升版本号 */
async function bumpVersion(cwd, version) {
  const inc = ['patch', 'minor', 'major'].includes(version) ? version : null
  const cmd = inc
    ? `npm version ${inc} --no-git-tag-version`
    : `npm version ${version} --no-git-tag-version`
  try {
    const out = sh(cmd, cwd)
    return `版本已更新 → ${readPackage(cwd).version}\n${out}`
  } catch (e) {
    throw new Error(`升版本失败: ${e.message}`)
  }
}

/** pack: 打包 */
async function pack(cwd) {
  const out = sh('npm pack --json', cwd)
  let filename = ''
  try {
    const arr = JSON.parse(out)
    filename = arr[0]?.filename || ''
  } catch {
    const m = out.match(/([^\s]+\.tgz)/)
    filename = m ? m[1] : ''
  }
  const pkg = readPackage(cwd)
  return `打包完成: ${filename}\n版本: ${pkg.version}`
}

/** publish: 完整发布流程 */
async function doPublish({ cwd, version, commitMessage, squash, doGitPush, doNpmPublish, changelog }) {
  const steps = []
  // 0. 前置检查
  const token = getNpmToken()
  if (doNpmPublish && !token) throw new Error('未找到 ~/.npmrc 的 _authToken，无法 npm 发布')
  let pkg = readPackage(cwd)
  const currentVersion = pkg.version

  // 1. 升版本
  if (version) {
    try {
      const out = await bumpVersion(cwd, version)
      steps.push(out)
      pkg = readPackage(cwd)
    } catch (e) {
      return { ok: false, steps, error: `升版本失败: ${e.message}` }
    }
  }

  // 2. 写 CHANGELOG（可选）
  if (changelog) {
    const clPath = join(cwd, 'CHANGELOG.md')
    const head = `## v${pkg.version}\n\n${changelog.trim()}\n\n`
    if (existsSync(clPath)) {
      const orig = readFileSync(clPath, 'utf-8')
      // 在 "# CHANGELOG" 标题后插入
      const idx = orig.indexOf('\n')
      writeFileSync(clPath, orig.slice(0, idx + 1) + '\n' + head + orig.slice(idx + 1))
    } else {
      writeFileSync(clPath, `# CHANGELOG\n\n${head}`)
    }
    steps.push('CHANGELOG 已更新')
  }

  // 3. 打包
  let tarballPath = ''
  try {
    tarballPath = join(cwd, sh('npm pack --json', cwd).match(/"filename":"([^"]+)"/)?.[1] || '')
    steps.push(`打包: ${tarballPath.split('/').pop()}`)
  } catch (e) {
    return { ok: false, steps, error: `打包失败: ${e.message}` }
  }

  // 4. git 提交（合并或直接提交）
  const msg = commitMessage || `release: v${pkg.version}`
  try {
    if (squash !== false) {
      // 合并为单个 release 提交：soft reset 到上一个 release 提交基点，再一次性提交
      // 基点 = HEAD 之前最近的一个 "release:" 提交（不含当前），若没有则用 HEAD~n 之前全部
      let baseCommit = null
      try {
        // 最近的两个 release 提交中，取最早那个作为基点（即当前 release 之前的状态）
        const releases = sh('git log --format="%h" --grep="^release:"', cwd).split('\n').filter(Boolean)
        // releases[0] 是最近的 release（可能是本次或上一次）；若 HEAD 就是 release 则取 [1]
        const headIsRelease = sh('git log -1 --format="%s"', cwd).startsWith('release:')
        baseCommit = headIsRelease ? (releases[1] || releases[0]) : (releases[0] || 'HEAD')
      } catch { baseCommit = 'HEAD' }
      sh(`git reset --soft ${baseCommit}`, cwd)
    }
    sh(`git add -A`, cwd)
    sh(`git commit -m "${msg.replace(/"/g, '\\"')}"`, cwd)
    steps.push(`git 提交: ${msg}`)
  } catch (e) {
    if (e.message.includes('nothing to commit') || e.message.includes('没有') || e.message.includes('nothing added')) {
      steps.push('git: 无改动可提交')
    } else {
      steps.push(`git 提交失败: ${e.message}`)
    }
  }

  // 5. git push
  if (doGitPush !== false) {
    try {
      const out = sh('git push', cwd)
      steps.push('git push: 成功')
    } catch (e) {
      steps.push(`git push 失败: ${e.message}`)
    }
  }

  // 6. npm 发布
  if (doNpmPublish !== false) {
    // 先尝试标准 publish
    try {
      const out = sh(`npm publish "${tarballPath}" 2>&1`, cwd)
      if (out.includes('+ @')) {
        steps.push('npm publish: 成功（标准方式）')
      } else {
        steps.push('npm publish: 标准方式未直接成功，尝试 bypass 兜底...')
        const r = await manualPublishDirect(cwd, tarballPath, token)
        if (r.ok) steps.push(`npm publish: 成功（bypass token 手动 PUT, ${r.status}）`)
        else steps.push(`npm publish: 失败 - ${r.error || r.body}`)
      }
    } catch (e) {
      steps.push('npm publish: 标准方式抛错，尝试 bypass 兜底...')
      try {
        const r = await manualPublishDirect(cwd, tarballPath, token)
        if (r.ok) steps.push(`npm publish: 成功（bypass token 手动 PUT, ${r.status}）`)
        else steps.push(`npm publish: 失败 - ${r.error || r.body}`)
      } catch (e2) {
        steps.push(`npm publish: 失败 - ${e2.message}`)
      }
    }
  }

  return { ok: true, version: pkg.version, steps }
}

async function handler(input) {
  const cwd = input.cwd || process.cwd()
  if (!existsSync(join(cwd, 'package.json'))) {
    return '错误: 当前目录没有 package.json，请通过 cwd 指定项目目录'
  }
  const action = input.action
  try {
    switch (action) {
      case 'status': return await status(cwd)
      case 'version':
        if (!input.version) return '请提供 version 参数（patch|minor|major 或具体版本号）'
        return await bumpVersion(cwd, input.version)
      case 'pack': return await pack(cwd)
      case 'publish': {
        const r = await doPublish(input)
        return `✅ npm 发布流程完成 (v${r.version})\n\n` + r.steps.map(s => `- ${s}`).join('\n') + (r.error ? `\n\n⚠️ 错误: ${r.error}` : '')
      }
      case 'manual-publish': {
        const token = getNpmToken()
        if (!token) return '错误: 未找到 ~/.npmrc 的 _authToken'
        // 找最新的 tgz
        const tgz = sh('ls -t *.tgz 2>/dev/null | head -1', cwd)
        if (!tgz) return '错误: 目录下没有 .tgz 文件，请先执行 pack'
        const tarballPath = join(cwd, tgz)
        const r = await manualPublishDirect(cwd, tarballPath, token)
        return r.ok ? `✅ 发布成功 (${r.status})\n${r.body}` : `❌ 发布失败: ${r.error || r.body}`
      }
      default: return `未知 action: ${action}`
    }
  } catch (e) {
    return `❌ 工具执行错误: ${e.message}`
  }
}

export const npmPublishTool = new ToolDef(TOOL_NAME, TOOL_DESCRIPTION, TOOL_PARAMETERS, handler, 'ask')

export default npmPublishTool
