/**
 * FileRead 工具 — 读取文件
 * 对应原版: src/tools/FileReadTool/
 */
import { readFile, stat } from 'fs/promises'
import { resolve, isAbsolute } from 'path'
import { ToolDef } from '../types/index.js'
import { checkPathSafety } from '../security/path-guard.js'

const MAX_LINES = 2000
const MAX_SIZE_BYTES = 256 * 1024 // 256KB

export const fileReadTool = new ToolDef(
  'Read',
  `Read a file from the local filesystem.
Usage:
- The file_path must be an absolute path
- Optionally specify offset (1-based line number) and limit
- Results use cat -n format with line numbers
- Supports text files, images (PNG/JPG/GIF/WebP), and PDFs`,
  {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'The absolute path to the file to read',
      },
      offset: {
        type: 'number',
        description: 'Line number to start reading from (1-based)',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of lines to read',
      },
    },
    required: ['file_path'],
  },
  async (input, ctx) => {
    let filePath = input.file_path
    if (!isAbsolute(filePath)) {
      filePath = resolve(ctx.cwd || process.cwd(), filePath)
    }

    // 路径安全检查
    const pathResult = checkPathSafety(filePath, { cwd: ctx.cwd || process.cwd() })
    if (!pathResult.safe) {
      return `[🚫 路径被安全策略阻止]\n${pathResult.reasons.join('\n')}`
    }

    try {
      const fileStat = await stat(filePath)

      // 检查文件大小
      if (fileStat.size > MAX_SIZE_BYTES && !input.offset && !input.limit) {
        return `[File too large: ${fileStat.size} bytes > ${MAX_SIZE_BYTES} limit. Use offset/limit to read portions.]`
      }

      // 图片文件检测
      const ext = filePath.split('.').pop().toLowerCase()
      const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp']
      if (imageExts.includes(ext)) {
        const buf = await readFile(filePath)
        const base64 = buf.toString('base64')
        const mime = ext === 'svg' ? 'image/svg+xml' : `image/${ext === 'jpg' ? 'jpeg' : ext}`
        return `[Image: ${filePath} (${(fileStat.size / 1024).toFixed(1)}KB)] data:${mime};base64,${base64.slice(0, 100)}...`
      }

      // 文本文件
      const content = await readFile(filePath, 'utf-8')
      const lines = content.split('\n')

      const offset = input.offset ? Math.max(1, input.offset) - 1 : 0
      const limit = input.limit || MAX_LINES
      const sliced = lines.slice(offset, offset + limit)

      // cat -n 格式
      const numbered = sliced
        .map((line, i) => {
          const lineNum = String(offset + i + 1).padStart(6, ' ')
          return `${lineNum}\t${line}`
        })
        .join('\n')

      const totalLines = lines.length
      const readLines = sliced.length
      let result = numbered

      if (offset > 0 || readLines < totalLines) {
        result += `\n\n[${readLines} of ${totalLines} lines shown (lines ${offset + 1}-${offset + readLines})]`
      }

      return result
    } catch (err) {
      if (err.code === 'ENOENT') {
        return `[File not found: ${filePath}]`
      }
      if (err.code === 'EISDIR') {
        return `[Path is a directory, not a file: ${filePath}. Use Bash with ls to list directory contents.]`
      }
      return `[Error reading file: ${err.message}]`
    }
  },
  'always-allow'
)
