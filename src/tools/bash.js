/**
 * Bash 工具 — 执行 shell 命令
 * 对应原版: src/tools/BashTool/
 */
import { spawn } from 'child_process'
import { ToolDef } from '../types/index.js'
import { checkBashSafety } from '../security/bash-guard.js'

export const bashTool = new ToolDef(
  'Bash',
  `Execute a bash command. The command will run in a shell subprocess.
Usage:
- Provide the command as the value of the 'command' key
- Optionally specify a working directory with 'cwd'
- Optionally set a timeout in seconds with 'timeout' (default 120)
- The output will be returned as stdout+stderr combined
- If the command exits with non-zero, the result will be marked as an error`,
  {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The bash command to execute',
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

    // 安全检查
    const safetyResult = checkBashSafety(command)
    if (!safetyResult.allowed) {
      return `[🚫 命令被安全策略阻止]\n${safetyResult.reasons.join('\n')}\n\n如果确认需要执行，请使用 /allow Bash 命令`
    }

    return new Promise((resolve, reject) => {
      const shell = process.env.SHELL || '/bin/bash'
      const proc = spawn(shell, ['-c', command], {
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
