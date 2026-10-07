/**
 * FileWrite 工具 — 写入/创建文件
 * 对应原版: src/tools/FileWriteTool/
 */
import { mkdir } from 'fs/promises'
import { resolve, isAbsolute, dirname } from 'path'
import { ToolDef } from '../types/index.js'
import { checkWritePathSafety } from '../security/path-guard.js'
import { withFileLock } from '../utils/file-lock.js'
import { atomicWriteFile } from '../utils/atomic-write.js'

export const fileWriteTool = new ToolDef(
  'Write',
  `Write content to a file. Creates the file if it doesn't exist, overwrites if it does.
Usage:
- file_path must be an absolute path
- content is the text to write
- Parent directories are created automatically
- This tool will OVERWRITE existing files - use Edit for partial changes`,
  {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'The absolute path to the file to write',
      },
      content: {
        type: 'string',
        description: 'The content to write to the file',
      },
    },
    required: ['file_path', 'content'],
  },
  async (input, ctx) => {
    let filePath = input.file_path
    if (!isAbsolute(filePath)) {
      filePath = resolve(ctx.cwd || process.cwd(), filePath)
    }

    // 写入路径安全检查
    const pathResult = checkWritePathSafety(filePath, { cwd: ctx.cwd || process.cwd() })
    if (!pathResult.safe) {
      return `[🚫 路径被安全策略阻止]\n${pathResult.reasons.join('\n')}`
    }

    try {
      // 自动创建父目录
      await mkdir(dirname(filePath), { recursive: true })
      // 串行化对「同一文件」的写入：防止同一轮里并行的 Edit/Write 互相踩踏（见 utils/file-lock.js）
      // 原子写（tmp+rename）：进程被强杀/断电也不会留下"截断的文件"（见 utils/atomic-write.js）
      await withFileLock(filePath, () => atomicWriteFile(filePath, input.content))

      const lines = input.content.split('\n').length
      const size = Buffer.byteLength(input.content, 'utf-8')
      return `Successfully wrote to ${filePath} (${lines} lines, ${size} bytes)`
    } catch (err) {
      return `[Error writing file: ${err.message}]`
    }
  },
  'ask'
)
