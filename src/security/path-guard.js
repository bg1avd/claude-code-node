/**
 * 路径安全防护 — 防止路径遍历攻击和敏感文件访问
 * 对应原版: src/utils/permissions/filesystem.ts + 多处路径检查
 *
 * v1.1 修复:
 * - /proc/self/ 加入禁止路径（容器逃逸/内存泄露）
 * - 新增 URL 编码绕过检测（%2e%2e, %2f, %5c 等）
 * - 双重编码绕过检测（%252e 等）
 */
import { resolve, normalize, isAbsolute, relative, sep } from 'path'

/**
 * 敏感路径列表 — 禁止读写
 */
const FORBIDDEN_PATHS = [
  '/etc/shadow',
  '/etc/passwd',
  '/etc/sudoers',
  '/etc/ssh/sshd_config',
  '/etc/gshadow',
  '/etc/pam.d/',
  '/boot/',
  '/proc/sys/',
  '/proc/self/',       // v1.1: 阻止 /proc/self 访问（容器逃逸/内存泄露）
  '/sys/kernel/',
]

/**
 * 敏感路径前缀 — 需要额外确认
 */
const SENSITIVE_PREFIXES = [
  '/etc/',
  '/usr/local/',
  '/var/log/',
  '/root/',
]

/**
 * 规范化路径 — 解析 .., ., 符号链接等
 * v1.1 修复: 增加编码绕过检测（%2e%2e, %252e 等 URL 编码变形）
 * @param {string} filePath — 输入路径
 * @param {string} cwd — 当前工作目录
 * @returns {string} 规范化后的绝对路径
 */
export function sanitizePath(filePath, cwd = process.cwd()) {
  // v1.1: 解码 URL 编码绕过（%2e = ., %2f = /, %5c = \）
  let decoded = filePath
  // 双重编码先解
  decoded = decoded.replace(/%252e/gi, '.').replace(/%252f/gi, '/').replace(/%255c/gi, '\\')
  // 单次编码
  decoded = decoded.replace(/%2e/gi, '.').replace(/%2f/gi, '/').replace(/%5c/gi, '\\')

  // 如果是相对路径，基于 cwd 解析
  const absPath = isAbsolute(decoded) ? decoded : resolve(cwd, decoded)
  // 规范化：消除 .. 和 .
  return normalize(absPath)
}

/**
 * 检查路径遍历攻击
 * @param {string} filePath — 用户输入的路径
 * @param {string} cwd — 工作目录
 * @param {string[]} allowedDirs — 允许访问的目录列表
 * @returns {{safe: boolean, resolvedPath: string, reason?: string}}
 */
export function checkPathTraversal(filePath, cwd = process.cwd(), allowedDirs = []) {
  const resolvedPath = sanitizePath(filePath, cwd)

  // 1. v1.1: 检查原始输入中的编码绕过尝试
  if (/%2e|%2f|%5c|%252e|%252f/i.test(filePath)) {
    return {
      safe: false,
      resolvedPath,
      reason: `路径编码绕过检测: ${filePath} 包含 URL 编码字符，疑似路径遍历攻击`,
    }
  }

  // 2. 检查 .. 在原始路径中的使用
  if (filePath.includes('..')) {
    const normalizedRelative = relative(cwd, resolvedPath)
    if (normalizedRelative.startsWith('..') || resolvedPath.startsWith('/etc/') || resolvedPath.startsWith('/root/')) {
      return {
        safe: false,
        resolvedPath,
        reason: `路径遍历：${filePath} 解析到 ${resolvedPath}，超出工作目录范围`,
      }
    }
  }

  // 3. 检查是否在允许的目录范围内
  if (allowedDirs.length > 0) {
    const isInAllowedDir = allowedDirs.some(dir => {
      const normDir = normalize(isAbsolute(dir) ? dir : resolve(cwd, dir))
      return resolvedPath.startsWith(normDir + sep) || resolvedPath === normDir
    })
    if (!isInAllowedDir) {
      return {
        safe: false,
        resolvedPath,
        reason: `路径 ${resolvedPath} 不在允许的目录范围内`,
      }
    }
  }
  return { safe: true, resolvedPath }
}

/**
 * 检查是否为禁止访问的敏感路径
 * @param {string} resolvedPath — 已规范化的绝对路径
 * @returns {{allowed: boolean, reason?: string}}
 */
export function checkForbiddenPath(resolvedPath) {
  // 1. 严格匹配禁止路径
  for (const forbidden of FORBIDDEN_PATHS) {
    if (resolvedPath === forbidden || resolvedPath.startsWith(forbidden + sep) || resolvedPath.startsWith(forbidden + '/')) {
      return { allowed: false, reason: `禁止访问敏感路径: ${resolvedPath}（匹配规则: ${forbidden}）` }
    }
  }

  // 2. SSH 目录特殊处理
  if (resolvedPath.includes('/.ssh/') || resolvedPath.includes('\\.ssh\\')) {
    const sshKeyPattern = /\/\.ssh\/id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/i
    const sshConfigPattern = /\/\.ssh\/(config|known_hosts|authorized_keys)$/i
    if (sshKeyPattern.test(resolvedPath)) {
      return { allowed: false, reason: `禁止访问 SSH 密钥文件: ${resolvedPath}` }
    }
    if (sshConfigPattern.test(resolvedPath)) {
      return { allowed: true, reason: `⚠️ 访问 SSH 配置文件: ${resolvedPath}` }
    }
  }

  // 3. 敏感前缀检查 — 允许但提示
  for (const prefix of SENSITIVE_PREFIXES) {
    if (resolvedPath.startsWith(prefix)) {
      return { allowed: true, reason: `⚠️ 访问系统敏感目录: ${resolvedPath}` }
    }
  }

  return { allowed: true }
}

/**
 * 综合路径安全检查
 * @param {string} filePath — 用户输入路径
 * @param {object} options — { cwd, allowedDirs, checkForbidden }
 * @returns {{safe: boolean, resolvedPath: string, reasons: string[]}}
 */
export function checkPathSafety(filePath, options = {}) {
  const { cwd = process.cwd(), allowedDirs = [], checkForbidden = true } = options
  const reasons = []

  const traversalResult = checkPathTraversal(filePath, cwd, allowedDirs)
  const resolvedPath = traversalResult.resolvedPath

  if (!traversalResult.safe) {
    reasons.push(traversalResult.reason)
  }

  if (checkForbidden) {
    const forbiddenResult = checkForbiddenPath(resolvedPath)
    if (!forbiddenResult.allowed) {
      reasons.push(forbiddenResult.reason)
    } else if (forbiddenResult.reason) {
      reasons.push(forbiddenResult.reason)
    }
  }

  return {
    safe: !reasons.some(r => r.startsWith('禁止') || r.startsWith('路径遍历') || r.startsWith('路径编码绕过')),
    resolvedPath,
    reasons,
  }
}

/**
 * 验证写入路径 — 比读取更严格
 * @param {string} filePath
 * @param {object} options
 * @returns {{safe: boolean, resolvedPath: string, reasons: string[]}}
 */
export function checkWritePathSafety(filePath, options = {}) {
  const result = checkPathSafety(filePath, options)

  // 写入额外检查：不能写到系统关键目录
  const systemWriteDirs = ['/etc/', '/boot/', '/usr/bin/', '/usr/lib/', '/sbin/', '/bin/', '/proc/', '/sys/']
  for (const dir of systemWriteDirs) {
    if (result.resolvedPath.startsWith(dir)) {
      result.safe = false
      result.reasons.push(`禁止写入系统关键目录: ${dir}`)
    }
  }
  return result
}
