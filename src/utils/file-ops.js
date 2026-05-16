/**
 * 文件操作工具
 * 对应原版: src/utils/file.ts + src/utils/fsOperations.ts
 */
import { readFile, writeFile, stat, mkdir, rm, rename, copyFile } from 'fs/promises'
import { resolve, dirname, basename, isAbsolute } from 'path'
import { existsSync } from 'fs'

/**
 * 安全读取文件（带大小限制）
 */
export async function safeReadFile(filePath, options = {}) {
  const maxBytes = options.maxBytes || 256 * 1024 // 256KB
  const absPath = resolvePath(filePath, options.cwd)

  try {
    const fileStat = await stat(absPath)
    if (fileStat.size > maxBytes) {
      return { ok: false, error: `File too large: ${fileStat.size} bytes (limit: ${maxBytes})` }
    }
    const content = await readFile(absPath, 'utf-8')
    return { ok: true, content, size: fileStat.size, mtime: fileStat.mtimeMs }
  } catch (err) {
    return { ok: false, error: err.message, code: err.code }
  }
}

/**
 * 安全写入文件（自动创建目录）
 */
export async function safeWriteFile(filePath, content, options = {}) {
  const absPath = resolvePath(filePath, options.cwd)

  try {
    await mkdir(dirname(absPath), { recursive: true })
    await writeFile(absPath, content, 'utf-8')
    return { ok: true, path: absPath, size: Buffer.byteLength(content, 'utf-8') }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

/**
 * 精确文本替换编辑
 */
export async function editFile(filePath, edits, options = {}) {
  const absPath = resolvePath(filePath, options.cwd)

  try {
    const content = await readFile(absPath, 'utf-8')
    let newContent = content

    for (const edit of Array.isArray(edits) ? edits : [edits]) {
      const { oldText, newText, replaceAll = false } = edit

      if (!newContent.includes(oldText)) {
        return { ok: false, error: `oldText not found in ${absPath}` }
      }

      const count = newContent.split(oldText).length - 1
      if (count > 1 && !replaceAll) {
        return { ok: false, error: `oldText appears ${count} times. Use replaceAll=true or provide more context.` }
      }

      if (replaceAll) {
        newContent = newContent.split(oldText).join(newText)
      } else {
        const idx = newContent.indexOf(oldText)
        newContent = newContent.slice(0, idx) + newText + newContent.slice(idx + oldText.length)
      }
    }

    await writeFile(absPath, newContent, 'utf-8')
    return { ok: true, path: absPath }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

/**
 * 检查文件/目录是否存在
 */
export async function pathExists(filePath) {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

/**
 * 递归删除
 */
export async function removeRecursive(filePath) {
  try {
    await rm(filePath, { recursive: true, force: true })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

/**
 * 获取文件修改时间
 */
export async function getMtime(filePath) {
  try {
    const s = await stat(filePath)
    return s.mtimeMs
  } catch {
    return null
  }
}

/**
 * 解析路径（支持相对路径）
 */
function resolvePath(filePath, cwd) {
  if (isAbsolute(filePath)) return filePath
  return resolve(cwd || process.cwd(), filePath)
}

export { resolvePath as resolvePath }
