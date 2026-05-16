/**
 * Glob 工具 — 文件模式搜索
 * 对应原版: src/tools/GlobTool/
 */
import { readdir } from 'fs/promises'
import { resolve, join, isAbsolute } from 'path'
import { ToolDef } from '../types/index.js'

/**
 * 简单的 glob 模式匹配器
 * 支持 * (任意非/字符) 和 ** (任意路径)
 */
function globToRegex(pattern) {
  let regex = ''
  let i = 0
  while (i < pattern.length) {
    const ch = pattern[i]
    if (ch === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') {
        regex += '(?:.*/)?'
        i += 3
      } else {
        regex += '.*'
        i += 2
      }
    } else if (ch === '*') {
      regex += '[^/]*'
      i++
    } else if (ch === '?') {
      regex += '[^/]'
      i++
    } else if ('.+^${}()|[]\\'.includes(ch)) {
      regex += '\\' + ch
      i++
    } else {
      regex += ch
      i++
    }
  }
  return new RegExp('^' + regex + '$')
}

async function* walkDir(dir, ignoreDirs = []) {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        // 跳过常见的忽略目录
        if (ignoreDirs.includes(entry.name)) continue
        if (entry.name.startsWith('.') && entry.name !== '.claude') continue
        yield* walkDir(fullPath, ignoreDirs)
      } else if (entry.isFile()) {
        yield fullPath
      }
    }
  } catch {
    // 忽略权限错误等
  }
}

export const globTool = new ToolDef(
  'Glob',
  `Find files matching a glob pattern.
Usage:
- pattern supports * (any non-path chars) and ** (any path segment)
- path is the base directory to search from (default: cwd)
- Results are returned as a list of file paths`,
  {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'The glob pattern to match (e.g. "**/*.js", "src/**/*.ts")',
      },
      path: {
        type: 'string',
        description: 'The base directory to search from (default: cwd)',
      },
    },
    required: ['pattern'],
  },
  async (input, ctx) => {
    const baseDir = input.path
      ? (isAbsolute(input.path) ? input.path : resolve(ctx.cwd || process.cwd(), input.path))
      : (ctx.cwd || process.cwd())

    const pattern = input.pattern
    const regex = globToRegex(pattern)
    const ignoreDirs = ['node_modules', '.git', '__pycache__', '.svn', 'dist', 'build', '.next']

    const matches = []
    const MAX_RESULTS = 200

    for await (const filePath of walkDir(baseDir, ignoreDirs)) {
      const relativePath = filePath.slice(baseDir.length + 1)
      if (regex.test(relativePath) || regex.test(filePath)) {
        matches.push(filePath)
        if (matches.length >= MAX_RESULTS) {
          matches.push(`... (truncated at ${MAX_RESULTS} results)`)
          break
        }
      }
    }

    if (matches.length === 0) {
      return `[No files matching pattern: ${pattern} in ${baseDir}]`
    }

    return matches.join('\n')
  },
  'always-allow'
)
