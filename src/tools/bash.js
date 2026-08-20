/**
 * Bash 工具 — 执行 shell 命令（跨平台）
 * 对应原版: src/tools/BashTool/
 *
 * 跨平台：通过 src/utils/shell.js 探测层自动选择可用 shell。
 *  - Linux/macOS        → /bin/bash（或 SHELL）
 *  - Windows (Git Bash) → Git Bash（bash 语义）
 *  - Windows (WSL)      → wsl bash（bash 语义）
 *  - Windows (PS)       → PowerShell
 *  - Windows (cmd)      → cmd.exe 兜底
 */
import { spawn } from 'child_process'
import { ToolDef } from '../types/index.js'
import { checkBashSafety } from '../security/bash-guard.js'
import { detectShell, getShellDescription } from '../utils/shell.js'

// 启动时探测一次并缓存
const shellCfg = detectShell()

/**
 * 动态生成工具描述，告知 LLM 当前平台的 shell 语义，
 * 避免模型在 Windows 上写出 Linux 命令导致失败。
 */
function buildDescription() {
  const envHint = getShellDescription()
  return `Execute a shell command. The command will run in a shell subprocess.

${envHint}

Usage:
- Provide the command as the value of the 'command' key (use the syntax matching the current shell above)
- Optionally specify a working directory with 'cwd'
- Optionally set a timeout in seconds with 'timeout' (default 120)
- The output will be returned as stdout+stderr combined
- If the command exits with non-zero, the result will be marked as an error`
}

export const bashTool = new ToolDef(
  'Bash',
  buildDescription(),
  {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: `The command to execute (${shellCfg.name} / ${shellCfg.kind} syntax)`,
      },
      cwd: {
        type: 'string',
        description: 'Working directory for the command (default: process.cwd())',
      },
      timeout: {
        type: 'number',
        description: 'Timeout in seconds (default: 120)',
      },
      env: {
        type: 'object',
        description: 'Additional environment variables',
        additionalProperties: { type: 'string' },
      },
    },
    required: ['command'],
  },
  async (input, ctx) => {
    const command = input.command
    const cwd = input.cwd || ctx.cwd || process.cwd()
    const timeoutSec = input.timeout || 120
    const extraEnv = input.env || {}

    // 安全检查（bash-guard 同时覆盖 bash 与 PowerShell 危险命令）
    const safetyResult = checkBashSafety(command)
    if (!safetyResult.allowed) {
      return `[🚫 命令被安全策略阻止]\n${safetyResult.reasons.join('\n')}\n\n如果确认需要执行，请使用 /allow Bash 命令`
    }

    // 每次执行时重新探测（幂等），用缓存的 shell 配置
    const cfg = detectShell()
    const shell = cfg.shell
    const shellArgs = [...cfg.args, command]

    return new Promise((resolve, reject) => {
      const proc = spawn(shell, shellArgs, {
        cwd,
        env: { ...process.env, ...extraEnv },
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''

      proc.stdout.on('data', (data) => {
        stdout += data.toString()
      })

      proc.stderr.on('data', (data) => {
        stderr += data.toString()
      })

      const timer = setTimeout(() => {
        proc.kill('SIGTERM')
        // 给进程 5 秒优雅退出
        setTimeout(() => {
          try { proc.kill('SIGKILL') } catch {}
        }, 5000)
        resolve(`[Timeout after ${timeoutSec}s]\n${stdout}${stderr ? '\n--- stderr ---\n' + stderr : ''}`)
      }, timeoutSec * 1000)

      proc.on('close', (code) => {
        clearTimeout(timer)
        const output = stdout + (stderr ? '\n--- stderr ---\n' + stderr : '')
        if (code === 0) {
          resolve(output || '(no output)')
        } else {
          resolve(`[Exit code: ${code}]\n${output}`)
        }
      })

      proc.on('error', (err) => {
        clearTimeout(timer)
        resolve(`[Error: ${err.message}]`)
      })

      // 关闭 stdin
      proc.stdin.end()
    })
  },
  'ask'
)
