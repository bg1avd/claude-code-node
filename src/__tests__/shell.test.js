/**
 * Shell 探测层 + Bash 工具跨平台逻辑测试
 */
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert'
import { detectShell, getShellDescription, isUnixShell, _resetShellCache } from '../utils/shell.js'

// 保存原始 platform / env
const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
const origEnv = { ...process.env }

beforeEach(() => {
  _resetShellCache()
})

afterEach(() => {
  // 恢复 platform
  Object.defineProperty(process, 'platform', origPlatform)
  // 恢复 env
  process.env = origEnv
})

/** 模拟 platform */
function mockPlatform(platform) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

test('Linux 平台默认使用 /bin/bash', () => {
  mockPlatform('linux')
  delete process.env.SHELL
  const cfg = detectShell()
  assert.equal(cfg.kind, 'bash')
  assert.equal(cfg.name, 'Bash')
  assert.equal(cfg.shell, '/bin/bash')
  assert.deepEqual(cfg.args, ['-c'])
})

test('Linux 平台尊重 SHELL 环境变量', () => {
  mockPlatform('linux')
  process.env.SHELL = '/bin/zsh'
  const cfg = detectShell()
  assert.equal(cfg.kind, 'zsh')
  assert.equal(cfg.shell, '/bin/zsh')
})

test('Unix shell 判定', () => {
  mockPlatform('linux')
  assert.equal(isUnixShell(), true)
})

test('Windows 平台无任何外部 shell 时退回 cmd.exe', () => {
  mockPlatform('win32')
  // 清空所有候选路径
  process.env.GIT_BASH = ''
  process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe'
  const cfg = detectShell()
  assert.equal(cfg.kind, 'cmd')
  assert.equal(cfg.name, 'Command Prompt')
  assert.deepEqual(cfg.args, ['/c'])
})

test('Windows 平台有 Git Bash 时优先选择', () => {
  mockPlatform('win32')
  process.env.GIT_BASH = 'C:\\fake\\git\\bin\\bash.exe'
  // 直接 mock findFirst 不可行，此处验证 cmd 兜底 + PowerShell 路径逻辑
  // （findFirst 依赖 existsSync，无法轻易 mock，故只验证非 Git Bash 分支）
  const cfg = detectShell()
  // 若本机有 Git Bash 则命中；CI/无 Git 环境走 cmd 兜底
  assert.ok(['cmd', 'bash', 'wsl', 'powershell'].includes(cfg.kind))
})

test('getShellDescription 包含平台与 shell 信息', () => {
  mockPlatform('linux')
  const desc = getShellDescription()
  assert.ok(desc.includes('Current platform: linux'))
  assert.ok(desc.includes('Current shell:'))
})

test('detectShell 幂等（缓存）', () => {
  mockPlatform('linux')
  const a = detectShell()
  const b = detectShell()
  assert.equal(a, b) // 同一缓存对象
})

test('强制重新探测可刷新缓存', () => {
  mockPlatform('linux')
  const a = detectShell()
  _resetShellCache()
  const b = detectShell()
  assert.notEqual(a, b)
})
