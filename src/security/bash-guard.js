/**
 * BashTool 命令安全检查
 * 对应原版: src/tools/BashTool/bashSecurity.ts (2592行简化版)
 *
 * v1.1 修复:
 * - 新增危险命令: mount, umount, chown, chroot, chgrp, mkswap, swapoff, swapon
 * - 新增命令替换注入检测: $(cmd) 和 `cmd` 在高危上下文中阻止
 * - 新增进程注入检测: /proc/self 内存操作
 * - 新增环境变量注入检测: LD_PRELOAD, LD_LIBRARY_PATH
 * - 强化管道注入: curl/wget 到任意端口 + 管道执行
 * - 修复 splitPipeSegments: 正确处理引号内的 |
 */

/**
 * 危险命令模式列表
 * 每个模式: { pattern, reason, severity }
 * severity: 'critical' = 直接拒绝, 'high' = 需要确认, 'medium' = 提示
 */
const DANGEROUS_PATTERNS = [
  // === 破坏性操作 ===
  { pattern: /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?(-[a-zA-Z]*r[a-zA-Z]*\s+)?\/\s*$/, reason: '递归删除根目录', severity: 'critical' },
  { pattern: /\brm\s+.*-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*.*\s\/[a-zA-Z]*/, reason: '递归强制删除系统目录', severity: 'critical' },
  { pattern: /\bdd\s+if=.*of=\/dev\//, reason: 'dd 写入设备文件', severity: 'critical' },
  { pattern: /\bmkfs\b/, reason: '格式化文件系统', severity: 'critical' },
  { pattern: /\bformat\s+[A-Z]:/i, reason: 'Windows 格式化磁盘', severity: 'critical' },
  { pattern: /:\(\)\{\s*:\|\:&\s*\}\s*;/, reason: 'Fork bomb（fork 炸弹）', severity: 'critical' },
  { pattern: />\s*\/dev\/sda/, reason: '直接写入块设备', severity: 'critical' },
  { pattern: /\bchmod\s+([0-7]{3,4}|[ugo]*[+-][rwx].*)\s+\/(etc|boot|usr)\b/, reason: '修改系统目录权限', severity: 'critical' },

  // === v1.1 新增: 系统级破坏命令 ===
  { pattern: /\bmount\b/, reason: '挂载文件系统（可能修改系统分区）', severity: 'critical' },
  { pattern: /\bumount\b/, reason: '卸载文件系统（可能导致数据丢失）', severity: 'high' },
  { pattern: /\bchown\b.*\/(etc|boot|usr|root)\b/, reason: '修改系统目录所有者', severity: 'critical' },
  { pattern: /\bchgrp\b.*\/(etc|boot|usr|root)\b/, reason: '修改系统目录组', severity: 'high' },
  { pattern: /\bchroot\b/, reason: 'chroot 改变根目录（逃逸风险）', severity: 'high' },
  { pattern: /\bmkswap\b/, reason: '创建交换分区', severity: 'critical' },
  { pattern: /\bswapoff\b/, reason: '禁用交换分区', severity: 'high' },
  { pattern: /\bswapon\b/, reason: '启用交换分区', severity: 'high' },

  // === 敏感文件访问 ===
  { pattern: /\/etc\/(shadow|passwd|sudoers|ssh\/sshd_config|gshadow|pam\.d)\b/, reason: '访问敏感系统文件', severity: 'high' },
  { pattern: /~\/\.ssh\/(id_[a-z]+|authorized_keys|config)\b/, reason: '访问 SSH 私钥/配置', severity: 'high' },
  { pattern: /\bcat\b.*\/etc\/shadow/, reason: '读取 shadow 密码文件', severity: 'critical' },

  // === v1.1 新增: /proc/self 内存操作 ===
  { pattern: /\/proc\/self\/(mem|environ|maps|auxv)/, reason: '访问 /proc/self 敏感文件（内存泄露/逃逸）', severity: 'critical' },
  { pattern: /\/proc\/sys\/kernel\/(core_pattern|modprobe|panic|hostname)/, reason: '修改内核参数（容器逃逸）', severity: 'critical' },

  // === 网络数据外泄 ===
  { pattern: /\bcurl\b.*\|\s*(bash|sh|zsh|fish)\b/, reason: '从网络下载并执行脚本（curl | bash）', severity: 'critical' },
  { pattern: /\bwget\b.*\|\s*(bash|sh|zsh|fish)\b/, reason: '从网络下载并执行脚本（wget | sh）', severity: 'critical' },
  { pattern: /\b(iex|Invoke-Expression)\b.*\b(Invoke-WebRequest|iwr|New-Object.*WebClient)\b/i, reason: 'PowerShell 下载并执行', severity: 'critical' },
  { pattern: /\bpython[23]?\s+-c\s+.*import\s+(urllib|requests|http\.client|socket)/, reason: 'Python 内联网络请求', severity: 'high' },

  // === v1.1 新增: 管道 + shell 执行 ===
  { pattern: /\bcurl\b.*--exec\b/, reason: 'curl --exec 下载并执行', severity: 'critical' },
  { pattern: /\bcurl\b.*\bxargs\b.*\b(bash|sh|zsh)\b/, reason: 'curl 下载 + xargs 执行', severity: 'critical' },

  // === 提权/权限逃逸 ===
  { pattern: /\bsudo\s+su\b/, reason: '切换到 root 用户', severity: 'high' },
  { pattern: /\bsudo\s+chmod\s+[0-7]{3,4}\s+\/(etc|usr|boot)\b/, reason: 'sudo 修改系统目录权限', severity: 'critical' },
  { pattern: /\bpkexec\b/, reason: 'PolicyKit 提权', severity: 'high' },

  // === v1.1 新增: 环境变量注入 ===
  { pattern: /\bLD_PRELOAD\s*=/, reason: 'LD_PRELOAD 注入（劫持动态链接库）', severity: 'critical' },
  { pattern: /\bLD_LIBRARY_PATH\s*=/, reason: 'LD_LIBRARY_PATH 注入（劫持库搜索路径）', severity: 'high' },
  { pattern: /\bPYTHONPATH\s*=/, reason: 'PYTHONPATH 注入（劫持 Python 模块搜索）', severity: 'high' },

  // === 容器/云逃逸 ===
  { pattern: /\bnsenter\b.*--target\s+1\b/, reason: '容器 namespace 逃逸到 PID 1', severity: 'critical' },
  { pattern: /\/proc\/sys\/kernel\/core_pattern/, reason: '修改 core_pattern（容器逃逸技术）', severity: 'critical' },
  { pattern: /\bdocker\s+(run|exec).*--privileged/, reason: '启动特权容器', severity: 'high' },

  // === v1.1 新增: 内核模块 ===
  { pattern: /\binsmod\b/, reason: '加载内核模块', severity: 'critical' },
  { pattern: /\brmmod\b/, reason: '卸载内核模块', severity: 'high' },
  { pattern: /\bmodprobe\b/, reason: '自动加载内核模块', severity: 'high' },
]

/**
 * 命令替换注入检测
 * 检查 $(cmd) 和 `cmd` 在高危上下文中的使用
 */
function checkCommandSubstitution(command) {
  const findings = []

  // 检测 $() 命令替换
  const subshellPattern = /\$\([^)]*\)/g
  let match
  while ((match = subshellPattern.exec(command)) !== null) {
    const subCmd = match[0]
    // 检查子命令中是否包含危险操作
    for (const { pattern, reason, severity } of DANGEROUS_PATTERNS) {
      if (pattern.test(subCmd)) {
        findings.push({ blocked: true, reason: `命令替换注入: ${subCmd} 包含 ${reason}`, severity })
      }
    }
    // 检查子命令中的网络请求（SSRF via 命令替换）
    if (/\b(curl|wget|fetch|nc|ncat|socat)\b/.test(subCmd)) {
      findings.push({ blocked: true, reason: `命令替换中包含网络请求: ${subCmd}`, severity: 'high' })
    }
  }

  // 检测反引号命令替换
  const backtickPattern = /`[^`]+`/g
  while ((match = backtickPattern.exec(command)) !== null) {
    const subCmd = match[0]
    for (const { pattern, reason, severity } of DANGEROUS_PATTERNS) {
      if (pattern.test(subCmd)) {
        findings.push({ blocked: true, reason: `反引号命令替换注入: ${subCmd} 包含 ${reason}`, severity })
      }
    }
    if (/\b(curl|wget|fetch|nc|ncat|socat)\b/.test(subCmd)) {
      findings.push({ blocked: true, reason: `反引号命令替换中包含网络请求: ${subCmd}`, severity: 'high' })
    }
  }

  return findings
}

/**
 * 分段分析 — 检查跨管道段的 cd+git 组合
 */
function checkCrossSegmentCdGit(segments) {
  let hasCd = false
  let hasGit = false
  for (const segment of segments) {
    const trimmed = segment.trim()
    if (/^\bcd\s+/.test(trimmed) || /\&\&\s*cd\s+/.test(trimmed) || /\|\s*cd\s+/.test(trimmed)) {
      hasCd = true
    }
    if (/\bgit\s+/.test(trimmed)) {
      hasGit = true
    }
  }
  if (hasCd && hasGit) {
    return { blocked: true, reason: 'cd + git 组合命令：可能利用裸仓库 fsmonitor 绕过安全检查' }
  }
  return { blocked: false }
}

/**
 * 多 cd 命令检测
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
    return { blocked: true, reason: `一条命令中包含 ${cdCount} 次 cd，需要确认以避免混淆` }
  }
  return { blocked: false }
}

/**
 * 分割复合命令为管道段
 * v1.1 修复: 正确处理引号内的 |
 */
function splitPipeSegments(command) {
  const segments = []
  let current = ''
  let inSingle = false
  let inDouble = false
  let escaped = false

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]

    if (escaped) {
      current += ch
      escaped = false
      continue
    }

    if (ch === '\\') {
      escaped = true
      current += ch
      continue
    }

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle
      current += ch
      continue
    }

    if (ch === '"' && !inSingle) {
      inDouble = !inDouble
      current += ch
      continue
    }

    if (ch === '|' && !inSingle && !inDouble) {
      // 检查是否是 || (逻辑或)
      if (command[i + 1] === '|') {
        current += '||'
        i++ // 跳过下一个 |
        continue
      }
      segments.push(current.trim())
      current = ''
      continue
    }

    current += ch
  }

  if (current.trim()) {
    segments.push(current.trim())
  }

  return segments.filter(s => s.length > 0)
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

  // 2. 命令替换注入检测（v1.1 新增）
  const substitutionFindings = checkCommandSubstitution(command)
  for (const finding of substitutionFindings) {
    if (finding.blocked) {
      reasons.push(`[${finding.severity.toUpperCase()}] ${finding.reason}`)
      if (finding.severity === 'critical' || (finding.severity === 'high' && maxSeverity !== 'critical')) {
        maxSeverity = finding.severity
      }
    }
  }

  // 3. 管道段分析
  const segments = splitPipeSegments(command)
  if (segments.length > 1) {
    const cdGit = checkCrossSegmentCdGit(segments)
    if (cdGit.blocked) {
      reasons.push(`[HIGH] ${cdGit.reason}`)
      if (maxSeverity !== 'critical') maxSeverity = 'high'
    }
  }

  // 4. 多 cd 检测
  const multiCd = checkMultipleCd(segments)
  if (multiCd.blocked) {
    reasons.push(`[MEDIUM] ${multiCd.reason}`)
    if (maxSeverity === 'none') maxSeverity = 'medium'
  }

  // 5. 网络外泄检查 — curl/wget 到私有 IP
  const netMatch = command.match(/\b(curl|wget)\s+.*?(https?:\/\/[^\s&|;]+)/g)
  if (netMatch) {
    for (const match of netMatch) {
      const urlMatch = match.match(/(https?:\/\/[^\s&|;]+)/)
      if (urlMatch) {
        try {
          const parsed = new URL(urlMatch[1])
          const hostname = parsed.hostname
          // 完整的内网 IP 检查（含 127.x.x.x）
          if (/^(0\.|10\.|127\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(hostname)) {
            reasons.push(`[CRITICAL] curl/wget 到内网地址 ${hostname}，疑似数据外泄`)
            maxSeverity = 'critical'
          }
        } catch { /* 无效 URL 忽略 */ }
      }
    }
  }

  // 6. 重定向到敏感位置
  if (/>>?\s*\/(etc|boot|usr|proc|sys)\//.test(command)) {
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
