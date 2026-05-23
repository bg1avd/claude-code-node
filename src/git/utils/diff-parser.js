/**
 * Diff 解析器 - 解析 GitHub unified diff format
 * 支持行级别定位，为 PR 评论提供 position
 */

/**
 * 解析 diff 字符串
 * @param {string} diff - 原始 diff 内容
 * @returns {Array<DiffHunk>} hunk 数组
 */
export function parseDiff(diff) {
  const hunks = []
  const lines = diff.split('\n')
  let currentHunk = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // Hunk header: @@ -oldStart,oldCount +newStart,newCount @@
    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
    if (hunkMatch) {
      if (currentHunk) {
        hunks.push(currentHunk)
      }
      currentHunk = {
        oldStart: parseInt(hunkMatch[1], 10),
        oldCount: parseInt(hunkMatch[2] || '1', 10),
        newStart: parseInt(hunkMatch[3], 10),
        newCount: parseInt(hunkMatch[4] || '1', 10),
        lines: [],
        headerLine: line
      }
      continue
    }

    if (currentHunk) {
      const diffLine = parseDiffLine(line, currentHunk)
      currentHunk.lines.push(diffLine)
    }
  }

  if (currentHunk) {
    hunks.push(currentHunk)
  }

  return hunks
}

/**
 * 解析单行 diff
 */
function parseDiffLine(line, hunk) {
  const type = line[0]
  const content = line.slice(1)

  // 计算行号
  let oldLineNum = null
  let newLineNum = null

  if (type === '+' && hunk.oldStart !== null) {
    newLineNum = hunk.newStart + (hunk.newLineCount || 0)
    hunk.newLineCount = (hunk.newLineCount || 0) + 1
  } else if (type === '-' && hunk.oldStart !== null) {
    oldLineNum = hunk.oldStart + (hunk.oldLineCount || 0)
    hunk.oldLineCount = (hunk.oldLineCount || 0) + 1
  } else if (type === ' ') {
    // context line
    const oldCount = hunk.oldLineCount || 0
    const newCount = hunk.newLineCount || 0
    oldLineNum = hunk.oldStart + oldCount
    newLineNum = hunk.newStart + newCount
    hunk.oldLineCount = oldCount + 1
    hunk.newLineCount = newCount + 1
  }

  return {
    type, // ' ' | '+' | '-'
    content,
    oldLineNum,
    newLineNum,
    raw: line
  }
}

/**
 * 在 diff 中查找文件对应的所有 hunk
 * @param {Array<DiffHunk>} hunks
 * @param {string} filePath - 文件路径
 * @returns {Array<DiffHunk>} 该文件的所有 hunk
 */
export function getHunksForFile(hunks, filePath) {
  // 实际 diff 中，每个文件的开头会有:
  // --- a/path/to/file
  // +++ b/path/to/file
  // 然后跟上多个 @@ headers
  // 简化版：我们假设调用者已经根据文件筛选了 hunks
  // 完整版需要扫描整个 diff 找到文件边界

  // 这里我们使用简化的方法：传入的 hunks 已经是该文件的所有 hunk
  return hunks
}

/**
 * 根据新文件行号计算在 diff 中的 position
 * GitHub API 的 position 是从文件 diff 开始处计数的行号（包含 hunk headers）
 *
 * @param {Array<DiffHunk>} hunks - 该文件的所有 hunk
 * @param {number} lineNum - 新文件中的行号
 * @returns {number} position (null if not found)
 */
export function getPositionInDiff(hunks, lineNum) {
  let position = 0

  for (const hunk of hunks) {
    // hunk header 占 1 行
    position += 1

    for (const line of hunk.lines) {
      position += 1

      const isLineMatch = (
        (line.type === '+' || line.type === ' ') &&
        line.newLineNum === lineNum
      )

      if (isLineMatch) {
        return position
      }
    }
  }

  return null // 该行不在 diff 中（可能是未修改的行）
}

/**
 * 构建 PR 评论的 payload
 * @param {string} body - 评论内容
 * @param {string} path - 文件路径
 * @param {number} position - diff position
 * @param {string} commitId - commit SHA（可选）
 */
export function buildCommentPayload(body, path, position, commitId = null) {
  const payload = {
    body,
    path,
    position
  }
  if (commitId) {
    payload.commit_id = commitId
  }
  return payload
}

/**
 * Diff Hunk 数据结构
 * @typedef {Object} DiffHunk
 * @property {number} oldStart
 * @property {number} oldCount
 * @property {number} newStart
 * @property {number} newCount
 * @property {string} headerLine
 * @property {Array<DiffLine>} lines
 */

/**
 * Diff Line 数据结构
 * @typedef {Object} DiffLine
 * @property {string} type - ' ', '+', '-'
 * @property {string} content - 行内容
 * @property {number|null} oldLineNum
 * @property {number|null} newLineNum
 * @property {string} raw - 原始行
 */

/**
 * 将 diff 按文件分割
 * @param {string} diff
 * @returns {Map<string, Array<DiffHunk>}} 文件路径 → hunk 数组
 */
export function splitDiffByFile(diff) {
  const fileMap = new Map()
  const lines = diff.split('\n')

  let currentFile = null
  let currentHunk = null
  let fileStartLine = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // 检测文件边界
    // --- a/path/to/file
    // +++ b/path/to/file
    const oldFileMatch = line.match(/^--- a\/(.+)/)
    const newFileMatch = lines[i + 1]?.match(/^\+\+\+ b\/(.+)/)

    if (oldFileMatch && newFileMatch) {
      // 切换到新文件
      if (currentFile && currentHunk) {
        fileMap.get(currentFile).push(currentHunk)
      }

      // 新文件的路径（来自 b/ 侧）
      currentFile = newFileMatch[1]
      if (!fileMap.has(currentFile)) {
        fileMap.set(currentFile, [])
      }

      fileStartLine = i + 2 // 跳过 ---/+++ 行
      i++ // 跳过 +++ 行
      currentHunk = { file: currentFile, hunks: [], startLine: fileStartLine }
      continue
    }

    // Hunk header
    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
    if (hunkMatch && currentFile !== null) {
      // 保存上一个 hunk
      if (currentHunk && currentHunk.hunks.length > 0) {
        fileMap.get(currentFile).push(currentHunk)
      }

      // 开始新 hunk
      currentHunk = {
        oldStart: parseInt(hunkMatch[1], 10),
        oldCount: parseInt(hunkMatch[2] || '1', 10),
        newStart: parseInt(hunkMatch[3], 10),
        newCount: parseInt(hunkMatch[4] || '1', 10),
        lines: [],
        headerLine: line,
        file: currentFile,
        startLine: i
      }
      fileMap.get(currentFile).push(currentHunk)
      continue
    }

    // diff 内容行
    if (currentHunk) {
      const diffLine = parseDiffLine(line, currentHunk)
      currentHunk.lines.push(diffLine)
    }
  }

  // 保存最后一个 hunk
  if (currentHunk && currentHunk.lines.length > 0) {
    fileMap.get(currentFile)?.push(currentHunk)
  }

  return fileMap
}

/**
 * 验证文件路径是否存在
 * @param {Map<string, Array>} fileMap
 * @param {string} path
 */
export function fileExistsInDiff(fileMap, path) {
  return fileMap.has(path)
}

/**
 * 获取文件的所有 hunks（包含 empty hunks）
 */
export function getHunksForFileRaw(fileMap, filePath) {
  return fileMap.get(filePath) || []
}

/**
 * 统计文件修改情况
 * @param {Array} hunks
 * @returns {{ additions: number, deletions: number, changes: number }}
 */
export function countFileChanges(hunks) {
  let additions = 0
  let deletions = 0

  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.type === '+') additions++
      else if (line.type === '-') deletions++
    }
  }

  return {
    additions,
    deletions,
    changes: additions + deletions
  }
}

// 测试辅助函数：打印解析结果
export function debugPrintHunks(hunks) {
  for (const hunk of hunks) {
    console.log(`Hunk: @@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`)
    for (const line of hunk.lines) {
      const marker = line.type === ' ' ? ' ' : line.type
      console.log(`  ${marker} ${line.newLineNum || ''} | ${line.content}`)
    }
  }
}

/**
 * 实用函数：将行号映射为 GitHub API 的 position
 * 注意：position 是从 diff 文件开头计数的行号（包括 @@ headers）
 */
export function mapLineToPosition(diffText, filePath, lineNum) {
  const fileMap = splitDiffByFile(diffText)
  const hunks = getHunksForFileRaw(fileMap, filePath)
  return getPositionInDiff(hunks, lineNum)
}

/**
 * 实用函数：找出 diff 中新增的代码块的位置范围
 */
export function findAddedLines(hunks) {
  const ranges = []
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.type === '+' && line.newLineNum) {
        ranges.push({
          start: line.newLineNum,
          end: line.newLineNum,
          content: line.content
        })
      }
    }
  }
  return ranges
}