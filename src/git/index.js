/**
 * Git 模块统一导出
 */

export { GitHubAPI, createGitHubAPI, GitHubError, GitHubRateLimitError } from './github-api.js'
export { PRReviewer } from './pr-reviewer.js'
export { PRMergePolicy, DEFAULT_MERGE_POLICY, findEligiblePRs, isPRMergeable } from './pr-merge-policy.js'

// Diff 解析工具
export {
  parseDiff,
  splitDiffByFile,
  getPositionInDiff,
  buildCommentPayload,
  getHunksForFileRaw,
  fileExistsInDiff,
  countFileChanges,
  mapLineToPosition,
  findAddedLines,
  debugPrintHunks
} from './utils/diff-parser.js'

// LLM 助手
export { callLLM, buildPRReviewPrompt } from './llm-assistant.js'

/**
 * 快速创建 GitTool
 */
import { gitTool } from '../tools/git-tool.js'

export function createGitTool(config = {}) {
  // 这里返回的是一个配置对象，实际 ToolDef 已注册
  return {
    config,
    tool: gitTool
  }
}