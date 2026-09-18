// 手动原子 PUT 发布（绕过 npm CLI 分阶段发布 + 2FA）
// 用法: node scripts/manual-put-publish.mjs <tarball.tgz>
// 读取 ~/.npmrc 的 bypass token，PUT 完整 manifest 到 registry 包端点
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

const tgzPath = process.argv[2]
if (!tgzPath) { console.error('usage: node scripts/manual-put-publish.mjs <tarball.tgz>'); process.exit(1) }

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const tgz = fs.readFileSync(tgzPath)
const shasum = crypto.createHash('sha1').update(tgz).digest('hex')
const integrity = 'sha512-' + crypto.createHash('sha512').update(tgz).digest('base64')
const tarballName = path.basename(tgzPath)
const version = pkg.version

// token from ~/.npmrc
const npmrc = fs.readFileSync(path.join(os.homedir(), '.npmrc'), 'utf8')
const m = npmrc.match(/\/\/registry\.npmjs\.org\/:_authToken=(\S+)/)
if (!m) { console.error('no authToken in ~/.npmrc'); process.exit(1) }
const token = m[1]

const v = {
  name: pkg.name,
  version,
  description: pkg.description,
  type: pkg.type,
  main: pkg.main,
  bin: pkg.bin,
  scripts: pkg.scripts,
  keywords: pkg.keywords,
  author: pkg.author,
  license: pkg.license,
  files: pkg.files,
  repository: pkg.repository,
  bugs: pkg.bugs,
  homepage: pkg.homepage,
  engines: pkg.engines,
  dependencies: pkg.dependencies || {},
  readme: fs.existsSync('README.md') ? fs.readFileSync('README.md', 'utf8') : '',
  _id: `${pkg.name}@${version}`,
  dist: {
    integrity,
    shasum,
    tarball: `https://registry.npmjs.org/${pkg.name}/-/${pkg.name.split('/')[1]}-${version}.tgz`,
  },
}

const doc = {
  _id: pkg.name,
  name: pkg.name,
  description: pkg.description,
  'dist-tags': { latest: version },
  versions: { [version]: v },
  readme: v.readme,
  _attachments: {
    [tarballName]: {
      content_type: 'application/octet-stream',
      data: tgz.toString('base64'),
      length: tgz.length,
    },
  },
}

const url = `https://registry.npmjs.org/${encodeURIComponent(pkg.name).replace('%40', '%40').replace('/', '%2F')}`
console.log(`PUT ${url} (version ${version}, ${tgz.length} bytes)`)

const res = await fetch(url, {
  method: 'PUT',
  headers: {
    authorization: `Bearer ${token}`,
    'npm-auth-type': 'bearer',
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(JSON.stringify(doc)),
  },
  body: JSON.stringify(doc),
})
const text = await res.text()
console.log(`status: ${res.status}`)
console.log(text.slice(0, 600))
process.exit(res.ok ? 0 : 1)
