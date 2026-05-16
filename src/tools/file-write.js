/**
 * FileWrite 工具 — 写入/创建文件
 * 对应原版: src/tools/FileWriteTool/
 */
import { writeFile, mkdir } from 'fs/promises'
import { resolve, isAbsolute, dirname } from 'path'
import { ToolDef } from '../types/index.js'
import { checkWritePathSafety } from '../security/path-guard.js'

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
      await writeFile(filePath, input.content, 'utf-8')

      const lines = input.content.split('\n').length
      const size = Buffer.byteLength(input.content, 'utf-8')
      return `Successfully wrote to ${filePath} (${lines} lines, ${size} bytes)`
    } catch (err) {
      return `[Error writing file: ${err.message}]`
    }
  },
  'ask'
)
