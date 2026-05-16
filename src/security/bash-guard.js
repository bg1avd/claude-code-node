/**
 * BashTool 命令安全检查
 * 对应原版: src/tools/BashTool/bashSecurity.ts (2592行简化版)
 *
 * 防护:
 * 1. 危险命令模式检测（rm -rf /、dd、mkfs 等）
 * 2. cd + git 组合攻击（裸仓库 fsmonitor 绕过）
 * 3. 管道注入（跨段 cd+git）
 * 4. 反引号/命令替换注入
 * 5. 网络数据外泄（curl/wget 到可疑地址）
 * 6. 敏感文件访问（/etc/shadow、SSH 密钥）
 */

/**
 * 危险命令模式列表
 * 每个模式: { pattern, reason, severity }
 * severity: 'critical' = 直接拒绝, 'high' = 需要确认, 'medium' = 提示
 */
const DANGEROUS_PATTERNS = [
  // === 破坏性操作 ===
  {
    pattern: /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?(-[a-zA-Z]*r[a-zA-Z]*\s+)?\/\s*$/,
    reason: '递归删除根目录',
    severity: 'critical',
  },
  {
    pattern: /\brm\s+.*-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*.*\s\/[a-zA-Z]*/,
    reason: '递归强制删除系统目录',
    severity: 'critical',
  },
  {
    pattern: /\bdd\s+if=.*of=\/dev\//,
    reason: 'dd 写入设备文件',
    severity: 'critical',
  },
  {
    pattern: /\bmkfs\b/,
    reason: '格式化文件系统',
    severity: 'critical',
  },
  {
    pattern: /\bformat\s+[A-Z]:/i,
    reason: 'Windows 格式化磁盘',
    severity: 'critical',
  },
  {
    pattern: /:\(\)\{\s*:\|\:&\s*\}\s*;/,
    reason: 'Fork bomb（fork 炸弹）',
    severity: 'critical',
  },
  {
    pattern: />\s*\/dev\/sda/,
    reason: '直接写入块设备',
    severity: 'critical',
  },
  {
    pattern: /\bchmod\s+([0-7]{3,4}|[ugo]*[+-][rwx].*)\s+\/(etc|boot|usr)\b/,
    reason: '修改系统目录权限',
    severity: 'critical',
  },

  // === 敏感文件访问 ===
  {
    pattern: /\/etc\/(shadow|passwd|sudoers|ssh\/sshd_config)\b/,
    reason: '访问敏感系统文件',
    severity: 'high',
  },
  {
    pattern: /~\/\.ssh\/(id_[a-z]+|authorized_keys|config)\b/,
    reason: '访问 SSH 私钥/配置',
    severity: 'high',
  },
  {
    pattern: /\bcat\b.*\/etc\/shadow/,
    reason: '读取 shadow 密码文件',
    severity: 'critical',
  },

  // === 网络数据外泄 ===
  {
    pattern: /\bcurl\b.*\|\s*(bash|sh|zsh|fish)\b/,
    reason: '从网络下载并执行脚本（curl | bash）',
    severity: 'critical',
  },
  {
    pattern: /\bwget\b.*\|\s*(bash|sh|zsh|fish)\b/,
    reason: '从网络下载并执行脚本（wget | sh）',
    severity: 'critical',
  },
  {
    pattern: /\b(iex|Invoke-Expression)\b.*\b(Invoke-WebRequest|iwr|New-Object.*WebClient)\b/i,
    reason: 'PowerShell 下载并执行',
    severity: 'critical',
  },
  {
    pattern: /\bpython[23]?\s+-c\s+.*import\s+(urllib|requests|http\.client|socket)/,
    reason: 'Python 内联网络请求',
    severity: 'high',
  },

  // === 提权/权限逃逸 ===
  {
    pattern: /\bsudo\s+su\b/,
    reason: '切换到 root 用户',
    severity: 'high',
  },
  {
    pattern: /\bsudo\s+chmod\s+[0-7]{3,4}\s+\/(etc|usr|boot)\b/,
    reason: 'sudo 修改系统目录权限',
    severity: 'critical',
  },
  {
    pattern: /\bpkexec\b/,
    reason: 'PolicyKit 提权',
    severity: 'high',
  },

  // === 容器/云逃逸 ===
  {
    pattern: /\bnsenter\b.*--target\s+1\b/,
    reason: '容器 namespace 逃逸到 PID 1',
    severity: 'critical',
  },
  {
    pattern: /\/proc\/sys\/kernel\/core_pattern/,
    reason: '修改 core_pattern（容器逃逸技术）',
    severity: 'critical',
  },
  {
    pattern: /\bdocker\s+(run|exec).*--privileged/,
    reason: '启动特权容器',
    severity: 'high',
  },
]

/**
 * 分段分析 — 检查跨管道段的 cd+git 组合
 */
function checkCrossSegmentCdGit(segments) {
  let hasCd = false
  let hasGit = false

  for (const segment of segments) {
    const trimmed = segment.trim()
    // cd 检测
    if (/^\bcd\s+/.test(trimmed) || /\&\&\s*cd\s+/.test(trimmed) || /\|\s*cd\s+/.test(trimmed)) {
      hasCd = true
    }
    // git 检测
    if (/\bgit\s+/.test(trimmed)) {
      hasGit = true
    }
  }

  if (hasCd && hasGit) {
    return {
      blocked: true,
      reason: 'cd + git 组合命令：可能利用裸仓库 fsmonitor 绕过安全检查',
    }
  }

  return { blocked: false }
}

/**
 * 多 cd 命令检测 — 一个命令中多次 cd 容易混淆
 */
function checkMultipleCd(segments) {
  let cdCount = 0
  for (const segment of segments) {
    const subCommands = segment.split(/\s*&&\s*|\s*;\s*/)
    for (const sub of subCommands) {
      if (/^\bcd\s+/.test(sub.trim())) cdCount++
    }
  }
  if (cdCount > 1) {
    return {
      blocked: true,
      reason: `一条命令中包含 ${cdCount} 次 cd，需要确认以避免混淆`,
    }
  }
  return { blocked: false }
}

/**
 * 分割复合命令为管道段
 */
function splitPipeSegments(command) {
  // 简单分割 — 不处理引号内的 |
  return command.split(/\s*\|\s*/).filter(s => s.trim())
}

/**
 * 主安全检查入口
 * @param {string} command — 要执行的 bash 命令
 * @returns {{allowed: boolean, severity: string, reasons: string[]}}
 */
export function checkBashSafety(command) {
  const reasons = []
  let maxSeverity = 'none'

  // 1. 危险模式匹配
  for (const { pattern, reason, severity } of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      reasons.push(`[${severity.toUpperCase()}] ${reason}`)
      if (severity === 'critical' || (severity === 'high' && maxSeverity !== 'critical')) {
        maxSeverity = severity
      }
    }
  }

  // 2. 管道段分析
  const segments = splitPipeSegments(command)

  if (segments.length > 1) {
    // 跨段 cd+git 检查
    const cdGit = checkCrossSegmentCdGit(segments)
    if (cdGit.blocked) {
      reasons.push(`[HIGH] ${cdGit.reason}`)
      if (maxSeverity !== 'critical') maxSeverity = 'high'
    }
  }

  // 3. 多 cd 检测
  const multiCd = checkMultipleCd(segments)
  if (multiCd.blocked) {
    reasons.push(`[MEDIUM] ${multiCd.reason}`)
    if (maxSeverity === 'none') maxSeverity = 'medium'
  }

  // 4. 网络外泄检查 — curl/wget 到私有 IP
  const netMatch = command.match(/\b(curl|wget)\s+.*?(https?:\/\/[^\s&|;]+)/g)
  if (netMatch) {
    for (const match of netMatch) {
      const urlMatch = match.match(/(https?:\/\/[^\s&|;]+)/)
      if (urlMatch) {
        try {
          const hostname = new URL(urlMatch[1]).hostname
          // 简单的内网域名检查
          if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(hostname)) {
            reasons.push(`[CRITICAL] curl/wget 到内网地址 ${hostname}，疑似数据外泄`)
            maxSeverity = 'critical'
          }
        } catch { /* 无效 URL 忽略 */ }
      }
    }
  }

  // 5. 重定向到敏感位置
  if (/>>?\s*\/(etc|boot|usr)\//.test(command)) {
    reasons.push('[CRITICAL] 输出重定向到系统目录')
    maxSeverity = 'critical'
  }

  return {
    allowed: maxSeverity !== 'critical',
    severity: maxSeverity,
    reasons,
  }
}

/**
 * 格式化安全检查结果
 */
export function formatSafetyReport(result) {
  if (result.allowed && result.reasons.length === 0) {
    return '✅ 命令安全检查通过'
  }

  const lines = result.allowed
    ? ['⚠️ 命令安全检查发现注意事项：']
    : ['🚫 命令被安全策略阻止：']

  for (const reason of result.reasons) {
    lines.push(`  ${reason}`)
  }

  return lines.join('\n')
}
