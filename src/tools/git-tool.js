/**
 * GitTool - GitHub PR 自动化管理工具
 * 符合 ToolDef 接口规范
 */

import { GitHubAPI, createGitHubAPI } from '../git/github-api.js'
import { PRReviewer } from '../git/pr-reviewer.js'
import { PRMergePolicy } from '../git/pr-merge-policy.js'
import { ToolDef } from '../types/index.js'

const TOOL_NAME = 'GitTool'
const TOOL_DESCRIPTION = `
GitHub PR 自动化管理工具。

前置条件:
- 设置 GITHUB_TOKEN 环境变量（有 repo 权限）
- 设置 GITHUB_OWNER 和 GITHUB_REPO（或在 ~/.claude-code/config.json 中配置）
- 可选：DEEPSEEK_API_KEY for LLM 智能分析

主要功能:
- 列出 PR（list-prs）
- 获取 PR 详情（get-pr）
- 自动审查（review-pr）：代码质量、安全、测试、文档
- 智能合并（merge-pr）：策略检查
- 评论、approve、request changes
- 批量操作（auto-review-all, auto-merge-eligible）
`

const TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: [
        'list-prs',
        'get-pr',
        'review-pr',
        'merge-pr',
        'auto-review-all',
        'comment',
        'approve',
        'request-changes',
        'check-mergeable',
        'auto-merge-eligible'
      ],
      description: '要执行的操作'
    },
    owner: { type: 'string', description: 'GitHub repository owner' },
    repo: { type: 'string', description: 'GitHub repository name' },
    prNumber: { type: 'number', description: 'PR number' },
    state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'PR state filter' },
    head: { type: 'string', description: 'Filter by head branch' },
    base: { type: 'string', description: 'Filter by base branch' },
    labels: { type: 'array', items: { type: 'string' }, description: 'Label filter' },
    limit: { type: 'number', description: 'Max PRs to fetch' },
    checks: {
      type: 'array',
      items: { type: 'string', enum: ['code-quality', 'security', 'tests', 'docs', 'complexity', 'duplication'] },
      description: '检查项列表'
    },
    analyzeLLM: { type: 'boolean', description: '是否使用 LLM 智能分析' },
    commentThreshold: { type: 'string', enum: ['INFO', 'WARNING', 'ERROR'], description: '评论阈值' },
    autoComment: { type: 'boolean', description: '是否自动发表审查评论' },
    method: { type: 'string', enum: ['merge', 'squash', 'rebase'], description: 'Merge method' },
    body: { type: 'string', description: 'Comment body' },
    label: { type: 'string', description: 'Label filter for batch operations' }
  },
  required: ['action']
}

/**
 * 内部 GitTool 类（无状态）
 */
class GitTool {
  constructor(config = {}) {
    this.config = config
    this.github = null
    this.reviewer = null
    this.mergePolicy = null
  }

  ensureGitHubClient(options = {}) {
    if (this.github) return

    const owner = options.owner || this.config.owner || this._readConfig('github.owner')
    const repo = options.repo || this.config.repo || this._readConfig('github.repo')

    if (!owner || !repo) {
      throw new Error('GitHub owner and repo required. Set in config or pass as parameters.')
    }

    this.github = createGitHubAPI({
      token: process.env.GITHUB_TOKEN,
      owner,
      repo,
      baseUrl: this.config.baseUrl
    })

    const policyConfig = this.config.mergePolicy || {}
    this.reviewer = new PRReviewer(this.github, this.config.reviewRules, {
      enableLLM: this.config.enableLLM,
      apiConfig: this.config.llm
    })
    this.mergePolicy = new PRMergePolicy(this.github, policyConfig)
  }

  async execute(params) {
    const { action } = params
    switch (action) {
      case 'list-prs': return this.listPRs(params)
      case 'get-pr': return this.getPR(params)
      case 'review-pr': return this.reviewPR(params)
      case 'merge-pr': return this.mergePR(params)
      case 'auto-review-all': return this.autoReviewAll(params)
      case 'comment': return this.comment(params)
      case 'approve': return this.approve(params)
      case 'request-changes': return this.requestChanges(params)
      case 'check-mergeable': return this.checkMergeable(params)
      case 'auto-merge-eligible': return this.autoMergeEligible(params)
      default: throw new Error(`Unknown action: ${action}`)
    }
  }

  async listPRs({ state = 'open', head, base, labels, limit = 50 }) {
    this.ensureGitHubClient()
    if (labels && !Array.isArray(labels)) {
      throw new Error('labels must be an array of strings')
    }
    const query = { state, per_page: Math.min(limit, 100) }
    if (head) query.head = head
    if (base) query.base = base
    if (labels?.length) query.labels = labels.join(',')
    const prs = await this.github.listPRs(query)
    const prList = Array.isArray(prs) ? prs : []
    return {
      count: prList.length,
      prs: prList.map(pr => ({
        number: pr.number,
        title: pr.title,
        state: pr.state,
        user: pr.user?.login,
        head: pr.head?.ref,
        base: pr.base?.ref,
        createdAt: pr.created_at,
        updatedAt: pr.updated_at,
        comments: pr.comments,
        labels: pr.labels?.map(l => l.name) || []
      }))
    }
  }

  async getPR({ prNumber }) {
    this.ensureGitHubClient()
    const pr = await this.github.getPR(prNumber)
    const files = await this.github.getPRFiles(prNumber)
    const reviews = await this.github.listReviews(prNumber)
    return {
      number: pr.number,
      title: pr.title,
      body: pr.body,
      user: pr.user?.login,
      head: pr.head?.ref,
      base: pr.base?.ref,
      mergeable: pr.mergeable,
      changedFiles: pr.changed_files,
      additions: pr.additions,
      deletions: pr.deletions,
      files: files.map(f => ({ filename: f.filename, additions: f.additions, deletions: f.deletions })),
      reviews: reviews.map(r => ({ user: r.user?.login, state: r.state }))
    }
  }

  async reviewPR({ prNumber, checks, analyzeLLM = true, commentThreshold = 'WARNING', autoComment = false }) {
    this.ensureGitHubClient()
    const reviewRules = {}
    if (checks) {
      reviewRules.checks = {}
      checks.forEach(c => reviewRules.checks[c] = true)
    }
    const reviewer = new PRReviewer(this.github, reviewRules, {
      enableLLM: this.config.enableLLM,
      apiConfig: this.config.llm
    })
    const result = await reviewer.reviewPR(prNumber, { analyzeLLM, commentThreshold })
    if (autoComment && result.comments.length > 0) {
      const pr = await this.github.getPR(prNumber)
      const summary = result.comments.find(c => !c.position)
      if (summary) {
        await this.github.createReview(prNumber, summary.body)
      }
    }
    return result
  }

  async mergePR({ prNumber, method }) {
    if (!prNumber) throw new Error('prNumber required')
    this.ensureGitHubClient()
    return await this.mergePolicy.merge(prNumber, { method })
  }

  async autoReviewAll({ labelFilter, limit = 50 }) {
    this.ensureGitHubClient()
    const prs = await this.github.listPRs({ state: 'open', per_page: limit })
    const results = []
    const prList = Array.isArray(prs) ? prs : []
    for (const pr of prList) {
      if (labelFilter && !pr.labels?.some(l => l.name === labelFilter)) continue
      try {
        const review = await this.reviewer.reviewPR(pr.number, { commentThreshold: 'WARNING' })
        results.push({ prNumber: pr.number, title: pr.title, findings: review.findings.length, status: 'reviewed' })
      } catch (e) {
        results.push({ prNumber: pr.number, title: pr.title, status: 'error', error: e.message })
      }
    }
    return { total: prList.length, reviewed: results.filter(r => r.status === 'reviewed').length, errors: results.filter(r => r.status === 'error'), details: results }
  }

  async comment({ prNumber, body, path, line }) {
    if (!prNumber || !body) throw new Error('prNumber and body required')
    this.ensureGitHubClient()

    if (path && line) {
      // Get PR diff, parse and find the position for the specific line
      const pr = await this.github.getPR(prNumber)
      const diffText = await this.github.getPRDiff(prNumber)

      // Import diff parser dynamically (ESM)
      const { splitDiffByFile, getPositionInDiff, getHunksForFileRaw } = await import('../git/utils/diff-parser.js')

      const fileMap = splitDiffByFile(diffText)
      const hunks = getHunksForFileRaw(fileMap, path)

      if (!hunks || hunks.length === 0) {
        throw new Error('File ' + path + ' not found in PR diff')
      }

      const position = getPositionInDiff(hunks, line)
      if (position === null) {
        throw new Error('Line ' + line + ' not found in diff for ' + path)
      }

      // Use latest commit SHA as commit_id
      const commitId = pr.head?.sha || null

      return await this.github.createComment(prNumber, body, { path, position, commitId })
    }

    return await this.github.createReview(prNumber, body)
  }

  async approve({ prNumber, body }) {
    this.ensureGitHubClient()
    if (!prNumber) throw new Error('prNumber required')
    return await this.github.approvePR(prNumber, body || 'Approved')
  }

  async requestChanges({ prNumber, body }) {
    this.ensureGitHubClient()
    if (!prNumber) throw new Error('prNumber required')
    return await this.github.requestChanges(prNumber, body || 'Changes requested')
  }

  async checkMergeable({ prNumber }) {
    this.ensureGitHubClient()
    return await this.mergePolicy.checkMergeable(prNumber)
  }

  async autoMergeEligible({ label = 'auto-merge', limit = 50 }) {
    this.ensureGitHubClient()
    const prs = await this.github.listPRs({ state: 'open', per_page: limit, labels: label })
    const eligible = []
    const prList = Array.isArray(prs) ? prs : []
    for (const pr of prList) {
      try {
        const check = await this.mergePolicy.checkMergeable(pr.number)
        if (check.mergeable) eligible.push({ pr, check })
      } catch (e) {
        console.error(`Check failed for PR ${pr.number}:`, e.message)
      }
    }
    return { label, total: prList.length, eligible: eligible.length, items: eligible.map(e => ({ number: e.pr.number, title: e.pr.title })) }
  }

  _readConfig(path) {
    try {
      const configPath = `${process.env.HOME}/.claude-code/config.json`
      const data = require('fs').readFileSync(configPath, 'utf-8')
      const config = JSON.parse(data)
      return path.split('.').reduce((obj, key) => obj?.[key], config)
    } catch { return null }
  }
}

/**
 * ToolDef 工厂函数
 */
function createToolDef(config = {}) {
  const tool = new GitTool(config)
  return new ToolDef(TOOL_NAME, TOOL_DESCRIPTION, TOOL_PARAMETERS, (input, ctx) => tool.execute(input), 'high')
}

/**
 * 导出 ToolDef 实例
 */
export const gitTool = createToolDef()

export { GitTool, createToolDef }
export default gitTool