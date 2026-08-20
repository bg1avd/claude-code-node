/**
 * Shell 探测抽象层
 * ------------------------------------------------------------
 * 负责在启动时探测当前平台可用的 shell，并缓存探测结果。
 * 解决「工具库默认 Bash/Linux 语义，但运行在 Windows 上时
 * 命令可能失败、安全检查失效」的问题。
 *
 * 返回统一的 shell 配置对象：
 *   {
 *     platform: 'linux' | 'darwin' | 'win32',
 *     kind:     'bash' | 'wsl' | 'powershell' | 'cmd',
 *     name:     'Bash' | 'WSL Bash' | 'PowerShell' | 'Command Prompt',
 *     shell,          // 可执行文件路径
 *     args: [...],    // spawn 参数（不含 command）
 *     cmdPrefix: '...',  // 检测/描述用，非执行用
 *     supportsPipe: true|false,
 *   }
 *
 * 探测优先级（Windows）：
 *   1. Git Bash       —— 最接近 bash 语义，命令无需改写
 *   2. WSL bash       —— 完整 Linux 环境
 *   3. PowerShell     —— Windows 原生（pwsh 优先，退 powershell.exe）
 *   4. cmd.exe        —— 最后兜底
 * 非 Windows：SHELL 环境变量或 /bin/bash
 */
import { existsSync } from 'node:fs'

// ---- 常见 Git Bash 安装路径（Windows）----
const GIT_BASH_CANDIDATES = [
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
  'C:\\Git\\bin\\bash.exe',
  process.env.GIT_BASH,
].filter(Boolean)

// ---- 常见 PowerShell 可执行文件（Windows）----
const POWERSHELL_CANDIDATES = [
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
].filter(Boolean)

// ---- 常见 WSL bash（Windows）----
const WSL_CANDIDATES = [
  'C:\\Windows\\System32\\wsl.exe',
  'C:\\Windows\\Sysnative\\wsl.exe',
].filter(Boolean)

let cached = null

/** 同步查找第一个存在的文件路径 */
function findFirst(paths) {
  for (const p of paths) {
    try {
      if (p && existsSync(p)) return p
    } catch { /* ignore */ }
  }
  return null
}

/** 探测 Windows 上可用的 shell（同步，仅基于常见路径） */
function probeWindows() {
  // 1. Git Bash
  const gitBash = findFirst(GIT_BASH_CANDIDATES)
  if (gitBash) {
    return {
      platform: 'win32',
      kind: 'bash',
      name: 'Git Bash',
      shell: gitBash,
      args: ['-c'],
      cmdPrefix: '',
      supportsPipe: true,
    }
  }

  // 2. WSL bash
  const wsl = findFirst(WSL_CANDIDATES)
  if (wsl) {
    return {
      platform: 'win32',
      kind: 'wsl',
      name: 'WSL Bash',
      shell: wsl,
      args: ['--exec', 'bash', '-c'],
      cmdPrefix: 'wsl ',
      supportsPipe: true,
    }
  }

  // 3. PowerShell
  const ps = findFirst(POWERSHELL_CANDIDATES)
  if (ps) {
    return {
      platform: 'win32',
      kind: 'powershell',
      name: 'PowerShell',
      shell: ps,
      args: ['-NoProfile', '-NonInteractive', '-Command'],
      cmdPrefix: 'powershell ',
      supportsPipe: true,
    }
  }

  // 4. cmd.exe 兜底
  return {
    platform: 'win32',
    kind: 'cmd',
    name: 'Command Prompt',
    shell: process.env.ComSpec || 'cmd.exe',
    args: ['/c'],
    cmdPrefix: 'cmd /c ',
    supportsPipe: true,
  }
}

/**
 * 探测并缓存当前平台的 shell 配置。
 * 幂等：首次调用后缓存结果，后续直接返回。
 * @param {boolean} [force=false] 强制重新探测
 */
export function detectShell(force = false) {
  if (cached && !force) return cached

  const platform = process.platform

  if (platform === 'win32') {
    cached = probeWindows()
  } else {
    // Linux / macOS / 其他：优先 SHELL 环境变量，默认 /bin/bash
    const shell = process.env.SHELL && process.env.SHELL.trim() ? process.env.SHELL : '/bin/bash'
    cached = {
      platform,
      kind: shell.includes('zsh') ? 'zsh' : 'bash',
      name: shell.includes('zsh') ? 'Zsh' : 'Bash',
      shell,
      args: ['-c'],
      cmdPrefix: '',
      supportsPipe: true,
    }
  }

  return cached
}

/**
 * 获取供 LLM 阅读的 shell 环境描述。
 * 用于动态生成工具 description，告知模型当前命令语义。
 */
export function getShellDescription() {
  const s = detectShell()
  const lines = []
  lines.push(`Current platform: ${s.platform}`)
  lines.push(`Current shell: ${s.name} (${s.kind})`)
  if (s.kind === 'bash' || s.kind === 'zsh' || s.kind === 'wsl') {
    lines.push('Syntax: POSIX shell / bash. e.g. ls -la, cat file, cd dir')
  } else if (s.kind === 'powershell') {
    lines.push('Syntax: PowerShell. e.g. Get-ChildItem, Get-Content file, Set-Location')
    lines.push('NOTE: use PowerShell cmdlets, NOT bash commands (ls -> Get-ChildItem, cat -> Get-Content)')
  } else if (s.kind === 'cmd') {
    lines.push('Syntax: cmd.exe. e.g. dir, type file, cd')
    lines.push('NOTE: use cmd built-ins, NOT bash commands')
  }
  return lines.join('\n')
}

/** 是否 Linux/Unix 语义（bash/zsh/wsl） */
export function isUnixShell() {
  const s = detectShell()
  return s.kind === 'bash' || s.kind === 'zsh' || s.kind === 'wsl'
}

/** 测试用：重置缓存 */
export function _resetShellCache() {
  cached = null
}
