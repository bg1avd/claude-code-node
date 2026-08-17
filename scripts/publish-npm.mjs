#!/usr/bin/env node
/**
 * 手动发布 npm 包 — bypass-2FA GAT token + 手动构造 PUT 请求
 *
 * 背景：npm CLI 默认认证会触发强制 2FA（403），
 * 但用 bypass_2fa=true 的 GAT token + 手动 HTTP PUT +
 * `npm-auth-type: bearer` 头，可无需 OTP 直接发布。
 *
 * 参考：DEPLOY_LOG_2026-08-04.md
 */
import { readFileSync } from 'node:fs'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, basename } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(__dirname, '..')

// 读取 package.json
const pkg = JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf8'))
const version = pkg.version

// 查找 tarball
const tarballName = `${pkg.name.split('/').pop()}-${version}.tgz`
let tarballPath = resolve(projectRoot, tarballName)
// 也支持传参指定 tarball
if (process.argv[2]) tarballPath = resolve(process.argv[2])

const tarballBuf = readFileSync(tarballPath)
console.log(`📦 读取 tarball: ${basename(tarballPath)} (${tarballBuf.length} bytes)`)

// 从 .npmrc 读取 token
const npmrc = readFileSync(resolve(process.env.HOME, '.npmrc'), 'utf8')
const tokenMatch = npmrc.match(/_authToken=([a-zA-Z0-9_-]+)/)
const token = process.env.NPM_TOKEN || (tokenMatch ? tokenMatch[1] : '')
if (!token) {
  console.error('❌ 未找到 npm token（~/.npmrc 的 _authToken 或 NPM_TOKEN 环境变量）')
  process.exit(1)
}
console.log(`🔑 使用 token: ${token.slice(0, 10)}***`)

// 构造完整的 publish manifest
const distTags = { latest: version }
const registryUrl = 'https://registry.npmjs.org'

const manifest = {
  _id: pkg.name,
  name: pkg.name,
  description: pkg.description,
  'dist-tags': distTags,
  versions: {
    [version]: {
      ...pkg,
      _id: `${pkg.name}@${version}`,
      dist: {
        shasum: crypto.createHash('sha1').update(tarballBuf).digest('hex'),
        integrity: 'sha512-' + crypto.createHash('sha512').update(tarballBuf).digest('base64'),
        tarball: `${registryUrl}/${pkg.name}/-/${tarballName}`,
      },
      _npmVersion: '12.0.2',
      _nodeVersion: process.version,
    },
  },
  _attachments: {
    [tarballName]: {
      content_type: 'application/octet-stream',
      data: tarballBuf.toString('base64'),
      length: tarballBuf.length,
    },
  },
}

const encodedName = pkg.name.replace('/', '%2f')
const url = `${registryUrl}/${encodedName}`

console.log(`🚀 发布 ${pkg.name}@${version} → ${url}`)

const res = await fetch(url, {
  method: 'PUT',
  headers: {
    'Authorization': `Bearer ${token}`,
    'npm-auth-type': 'bearer',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(manifest),
})

const text = await res.text()
console.log(`📡 HTTP ${res.status}`)
if (res.ok) {
  console.log('✅ 发布成功！')
  console.log(text.slice(0, 500))
} else {
  console.log('❌ 发布失败:')
  console.log(text.slice(0, 1000))
  process.exit(1)
}
