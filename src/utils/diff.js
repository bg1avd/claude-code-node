/**
 * 文本差异计算 — 简单 LCS 算法
 * 对应原版: src/utils/diff.ts
 */

/**
 * 计算两个文本之间的 unified diff
 */
export function unifiedDiff(oldText, newText, filePath = 'file') {
  const oldLines = oldText.split('\n')
  const newLines = newText.split('\n')
  const hunks = computeHunks(oldLines, newLines)

  if (hunks.length === 0) return ''

  const header = `--- a/${filePath}\n+++ b/${filePath}\n`
  const body = hunks.map(h => formatHunk(h, oldLines, newLines)).join('\n')

  return header + body
}

/**
 * 计算差异区域
 */
function computeHunks(oldLines, newLines) {
  const lcs = computeLCS(oldLines, newLines)
  const edits = extractEdits(oldLines, newLines, lcs)

  // 合并相邻的编辑区域
  const hunks = []
  let currentHunk = null

  for (const edit of edits) {
    if (!currentHunk || edit.oldStart - currentHunk.oldEnd > 3) {
      if (currentHunk) hunks.push(currentHunk)
      currentHunk = {
        oldStart: Math.max(0, edit.oldStart - 3),
        oldEnd: edit.oldEnd + 3,
        newStart: Math.max(0, edit.newStart - 3),
        newEnd: edit.newEnd + 3,
        edits: [edit],
      }
    } else {
      currentHunk.oldEnd = edit.oldEnd + 3
      currentHunk.newEnd = edit.newEnd + 3
      currentHunk.edits.push(edit)
    }
  }
  if (currentHunk) hunks.push(currentHunk)

  return hunks
}

/**
 * 简单 LCS 动态规划
 */
function computeLCS(a, b) {
  const m = a.length
  const n = b.length
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1])
      }
    }
  }

  // 回溯
  const result = []
  let i = m, j = n
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      result.unshift({ type: 'equal', oldIdx: i - 1, newIdx: j - 1 })
      i--; j--
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i--
    } else {
      j--
    }
  }

  return result
}

/**
 * 从 LCS 提取编辑操作
 */
function extractEdits(oldLines, newLines, lcs) {
  const edits = []
  let oldIdx = 0, newIdx = 0

  for (const match of lcs) {
    if (match.oldIdx > oldIdx || match.newIdx > newIdx) {
      edits.push({
        oldStart: oldIdx,
        oldEnd: match.oldIdx,
        newStart: newIdx,
        newEnd: match.newIdx,
        type: 'change',
      })
    }
    oldIdx = match.oldIdx + 1
    newIdx = match.newIdx + 1
  }

  // 末尾
  if (oldIdx < oldLines.length || newIdx < newLines.length) {
    edits.push({
      oldStart: oldIdx,
      oldEnd: oldLines.length,
      newStart: newIdx,
      newEnd: newLines.length,
      type: 'change',
    })
  }

  return edits
}

/**
 * 格式化一个 hunk
 */
function formatHunk(hunk, oldLines, newLines) {
  const oldStart = hunk.oldStart + 1
  const oldCount = Math.min(hunk.oldEnd, oldLines.length) - hunk.oldStart
  const newStart = hunk.newStart + 1
  const newCount = Math.min(hunk.newEnd, newLines.length) - hunk.newStart

  let output = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n`

  for (let i = hunk.oldStart; i < Math.min(hunk.oldEnd, oldLines.length); i++) {
    const isEdit = hunk.edits.some(e => i >= e.oldStart && i < e.oldEnd)
    output += isEdit ? `-${oldLines[i]}\n` : ` ${oldLines[i]}\n`
  }

  for (let i = hunk.newStart; i < Math.min(hunk.newEnd, newLines.length); i++) {
    const isEdit = hunk.edits.some(e => i >= e.newStart && i < e.newEnd)
    if (isEdit) output += `+${newLines[i]}\n`
  }

  return output
}

/**
 * 简单的字符级 diff（用于行内差异）
 */
export function inlineDiff(oldStr, newStr) {
  if (oldStr === newStr) return oldStr

  const commonPrefix = commonPrefixLength(oldStr, newStr)
  const commonSuffix = commonSuffixLength(
    oldStr.slice(commonPrefix),
    newStr.slice(commonPrefix)
  )

  const removed = oldStr.slice(commonPrefix, oldStr.length - commonSuffix)
  const added = newStr.slice(commonPrefix, newStr.length - commonSuffix)

  let result = oldStr.slice(0, commonPrefix)
  if (removed) result += `[-${removed}-]`
  if (added) result += `{+${added}+}`
  result += oldStr.slice(oldStr.length - commonSuffix)

  return result
}

function commonPrefixLength(a, b) {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return i
}

function commonSuffixLength(a, b) {
  let i = 0
  while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i++
  return i
}
