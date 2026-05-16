/**
 * FileEdit 工具 — 精确文本替换编辑文件
 * 对应原版: src/tools/FileEditTool/
 */
import { readFile, writeFile } from 'fs/promises'
import { resolve, isAbsolute } from 'path'
import { ToolDef } from '../types/index.js'
import { checkWritePathSafety } from '../security/path-guard.js'

export const fileEditTool = new ToolDef(
  'Edit',
  `Perform exact string replacements in a file.
Usage:
- file_path must be an absolute path
- old_string must match EXACTLY (including whitespace/indentation)
- new_string is the replacement text
- Use replace_all=true to replace all occurrences (default: false)
- The tool will fail if old_string is not found or appears multiple times without replace_all`,
  {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'The absolute path to the file to modify',
      },
      old_string: {
        type: 'string',
        description: 'The text to replace',
      },
      new_string: {
        type: 'string',
        description: 'The text to replace it with (must be different from old_string)',
      },
      replace_all: {
        type: 'boolean',
        description: 'Replace all occurrences of old_string (default false)',
        default: false,
      },
    },
    required: ['file_path', 'old_string', 'new_string'],
  },
  async (input, ctx) => {
    let filePath = input.file_path
    if (!isAbsolute(filePath)) {
      filePath = resolve(ctx.cwd || process.cwd(), filePath)
    }

    const { old_string, new_string, replace_all = false } = input

    // 写入路径安全检查
    const pathResult = checkWritePathSafety(filePath, { cwd: ctx.cwd || process.cwd() })
    if (!pathResult.safe) {
      return `[🚫 路径被安全策略阻止]\n${pathResult.reasons.join('\n')}`
    }

    if (old_string === new_string) {
      return '[Error: old_string and new_string are identical. No change needed.]'
    }

    try {
      const content = await readFile(filePath, 'utf-8')

      // 检查 old_string 是否存在
      if (!content.includes(old_string)) {
        // 尝试提供有用的错误信息
        const lines = content.split('\n')
        const snippet = old_string.split('\n')[0].slice(0, 80)
        const suggestions = []
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(snippet) || lines[i].trim() === snippet.trim()) {
            suggestions.push(`  Line ${i + 1}: ${lines[i].slice(0, 80)}`)
          }
        }
        let msg = `[Error: old_string not found in ${filePath}]`
        if (suggestions.length > 0) {
          msg += `\nPossible matches:\n${suggestions.join('\n')}`
        }
        return msg
      }

      // 检查多次出现
      const count = content.split(old_string).length - 1
      if (count > 1 && !replace_all) {
        return `[Error: old_string appears ${count} times in the file. Use replace_all=true to replace all occurrences, or provide more context to make the match unique.]`
      }

      // 执行替换
      let newContent
      if (replace_all) {
        newContent = content.split(old_string).join(new_string)
      } else {
        const idx = content.indexOf(old_string)
        newContent = content.slice(0, idx) + new_string + content.slice(idx + old_string.length)
      }

      await writeFile(filePath, newContent, 'utf-8')

      // 计算变更行数
      const oldLines = old_string.split('\n').length
      const newLines = new_string.split('\n').length
      const diff = newLines - oldLines

      return `Successfully edited ${filePath} (${count > 1 ? count + ' occurrences' : '1 occurrence'} replaced, ${diff >= 0 ? '+' : ''}${diff} lines)`
    } catch (err) {
      if (err.code === 'ENOENT') {
        return `[Error: File not found: ${filePath}]`
      }
      return `[Error editing file: ${err.message}]`
    }
  },
  'ask'
)
