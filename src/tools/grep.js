/**
 * Grep 工具 — 内容搜索
 * 对应原版: src/tools/GrepTool/
 * 优先使用 ripgrep (rg)，回退到 grep，最后用纯 JS 实现
 */
import { spawn } from 'child_process'
import { resolve, isAbsolute } from 'path'
import { ToolDef } from '../types/index.js'

async function grepWithRg(pattern, path, options = {}) {
  const args = ['--line-number', '--color=never']
  if (options.ignore_case) args.push('-i')
  if (options.file_pattern) args.push('--glob', options.file_pattern)
  if (options.context_lines) args.push('-C', String(options.context_lines))
  args.push(pattern, path)

  return new Promise((resolve, reject) => {
    const proc = spawn('rg', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', d => stdout += d)
    proc.stderr.on('data', d => stderr += d)
    proc.on('close', (code) => {
      // rg exit 1 = no matches, 2 = error
      if (code === 0 || code === 1) resolve(stdout)
      else resolve(`[ripgrep error: ${stderr}]`)
    })
    proc.on('error', () => resolve(null)) // rg not found
    proc.stdin.end()
  })
}

async function grepWithGrep(pattern, path, options = {}) {
  const args = ['-rn', '--color=never']
  if (options.ignore_case) args.push('-i')
  if (options.file_pattern) args.push('--include', options.file_pattern)
  if (options.context_lines) args.push('-C', String(options.context_lines))
  args.push(pattern, path)

  return new Promise((resolve, reject) => {
    const proc = spawn('grep', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', d => stdout += d)
    proc.stderr.on('data', d => stderr += d)
    proc.on('close', (code) => {
      if (code === 0 || code === 1) resolve(stdout)
      else resolve(`[grep error: ${stderr}]`)
    })
    proc.on('error', () => resolve(null))
    proc.stdin.end()
  })
}

export const grepTool = new ToolDef(
  'Grep',
  `Search file contents with a regex pattern.
Usage:
- pattern is a regular expression (RE2 syntax for rg, BRE/ERE for grep)
- path is the directory to search in (default: cwd)
- Use ignore_case for case-insensitive search
- Use file_pattern to filter by filename (e.g. "*.js")
- Results show file:line:content format`,
  {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'The regular expression pattern to search for',
      },
      path: {
        type: 'string',
        description: 'The directory to search in (default: cwd)',
      },
      ignore_case: {
        type: 'boolean',
        description: 'Case-insensitive search (default: false)',
      },
      file_pattern: {
        type: 'string',
        description: 'File name pattern filter (e.g. "*.js", "*.{ts,tsx}")',
      },
      context_lines: {
        type: 'number',
        description: 'Number of context lines before/after match',
      },
    },
    required: ['pattern'],
  },
  async (input, ctx) => {
    const searchPath = input.path
      ? (isAbsolute(input.path) ? input.path : resolve(ctx.cwd || process.cwd(), input.path))
      : (ctx.cwd || process.cwd())

    // 尝试 rg → grep → 纯 JS
    let result = await grepWithRg(input.pattern, searchPath, input)
    if (result === null) {
      result = await grepWithGrep(input.pattern, searchPath, input)
    }
    if (result === null) {
      result = `[Neither ripgrep nor grep found. Install rg for best performance.]`
    }

    // 截断过长输出
    const MAX_OUTPUT = 50000
    if (result.length > MAX_OUTPUT) {
      result = result.slice(0, MAX_OUTPUT) + `\n\n[... truncated at ${MAX_OUTPUT} chars]`
    }

    if (!result.trim()) {
      return `[No matches for pattern: ${input.pattern} in ${searchPath}]`
    }

    return result
  },
  'always-allow'
)
