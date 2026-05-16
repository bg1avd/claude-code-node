/**
 * 进程管理工具
 * 对应原版: src/utils/process.ts + src/utils/Shell.ts
 */
import { spawn, exec } from 'child_process'

/**
 * 执行命令并获取输出
 */
export function execCommand(command, options = {}) {
  const cwd = options.cwd || process.cwd()
  const timeout = options.timeout || 120_000
  const env = { ...process.env, ...options.env }

  return new Promise((resolve) => {
    const proc = exec(command, { cwd, timeout, env, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        exitCode: err ? (err.killed ? -1 : err.code || 1) : 0,
        stdout: stdout || '',
        stderr: stderr || '',
        killed: err?.killed || false,
      })
    })
  })
}

/**
 * 启动一个长期运行的进程（带实时输出流）
 */
export function spawnProcess(command, args = [], options = {}) {
  const cwd = options.cwd || process.cwd()
  const env = { ...process.env, ...options.env }
  const timeout = options.timeout

  const proc = spawn(command, args, {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: options.shell || false,
  })

  let stdout = ''
  let stderr = ''

  proc.stdout.on('data', (data) => {
    stdout += data.toString()
    options.onStdout?.(data.toString())
  })

  proc.stderr.on('data', (data) => {
    stderr += data.toString()
    options.onStderr?.(data.toString())
  })

  // 超时处理
  let timer = null
  if (timeout) {
    timer = setTimeout(() => {
      proc.kill('SIGTERM')
      setTimeout(() => { try { proc.kill('SIGKILL') } catch {} }, 5000)
    }, timeout)
  }

  const promise = new Promise((resolve) => {
    proc.on('close', (code) => {
      if (timer) clearTimeout(timer)
      resolve({
        ok: code === 0,
        exitCode: code || 0,
        stdout,
        stderr,
      })
    })

    proc.on('error', (err) => {
      if (timer) clearTimeout(timer)
      resolve({
        ok: false,
        exitCode: -1,
        stdout,
        stderr: err.message,
      })
    })
  })

  return { process: proc, promise }
}

/**
 * 检查命令是否可用
 */
export async function commandExists(cmd) {
  const checkCmd = process.platform === 'win32' ? `where ${cmd}` : `which ${cmd}`
  const result = await execCommand(checkCmd, { timeout: 5000 })
  return result.ok
}

/**
 * 向进程发送输入
 */
export function sendInput(proc, data) {
  return new Promise((resolve, reject) => {
    if (!proc.stdin?.writable) {
      return reject(new Error('Process stdin is not writable'))
    }
    proc.stdin.write(data, (err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}
