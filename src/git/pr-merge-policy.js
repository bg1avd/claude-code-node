/**
 * PR 合并策略引擎
 * 根据项目的合并规则决定是否允许合并，以及如何合并
 */

import { GitHubAPI } from './github-api.js'

/**
 * 合并策略配置
 */
export const DEFAULT_MERGE_POLICY = {
  requiredApprovals: 1,           // 最少需要多少个 approve
  requireCI: true,                // 是否要求所有 CI 检查通过
  requireNoChangesRequested: true, // 是否要求无 changes_requested
  requireReview: true,            // 是否要求至少一个 review 且是 approve
  allowedMergeMethods: ['merge', 'squash', 'rebase'],
  defaultMergeMethod: 'merge',
  autoMergeLabels: ['auto-merge', 'ready-to-merge', 'automerge'], // 有这些标签则允许自动合并
  ignoreLabels: ['do-not-merge', 'wip', 'work-in-progress'], // 忽略这些标签
  bannedBranches: ['main', 'master', 'develop'], // 禁止合并到这些分支（可配置)
  checkProtectedBranch: true,      // 是否检查分支保护规则
  allowSelfApprove: false,         // 是否允许 PR 作者自己 approve
  maxReviewDays: 30,               // 审查时间上限（天）
  requireDescription: true,        // 是否要求 PR 描述不为空
  minDescriptionLength: 20,        // PR 描述最小长度
  requireLinkedIssue: false,       // 是否要求关联 issue
  blockOnConflicts: true           // 有冲突是否阻止合并
}

/**
 * PR 合并策略检查器
 */
export class PRMergePolicy {
  /**
   * @param {GitHubAPI} github
   * @param {Object} userPolicy - 用户自定义策略
   */
  constructor(github, userPolicy = {}) {
    this.github = github
    this.policy = { ...DEFAULT_MERGE_POLICY, ...userPolicy }
  }

  /**
   * 检查 PR 是否可合并
   * @param {number} prNumber
   * @returns {Promise<MergeCheckResult>}
   */
  async checkMergeable(prNumber) {
    const pr = await this.github.getPR(prNumber)
    const result = {
      prNumber,
      mergeable: true,
      checks: {},
      violations: [],
      warnings: [],
      metadata: {}
    }

    // 1. 基础检查
    await this.checkBasicState(pr, result)
    if (!result.mergeable) return result

    // 2. 审查状态检查
    await this.checkReviewStatus(pr, result)
    if (!result.mergeable) return result

    // 3. CI 状态检查
    if (this.policy.requireCI) {
      await this.checkCIStatus(pr, result)
      if (!result.mergeable) return result
    }

    // 4. 分支保护检查
    if (this.policy.checkProtectedBranch) {
      await this.checkBranchProtection(pr, result)
      if (!result.mergeable) return result
    }

    // 5. 自动合并标签检查
    await this.checkAutoMergeLabels(pr, result)

    // 6. 忽略标签检查
    await this.checkIgnoreLabels(pr, result)

    // 7. 合并冲突检查
    if (this.policy.blockOnConflicts) {
      const isMergeable = await this.github.isMergeable(prNumber)
      if (isMergeable === false) {
        result.violations.push({
          code: 'MERGE_CONFLICT',
          message: 'PR has merge conflicts that need to be resolved'
        })
        result.mergeable = false
      }
    }

    return result
  }

  /**
   * 执行合并（已通过检查）
   * @param {number} prNumber
   * @param {Object} options - 合并选项
   * @returns {Promise<MergeResult>}
   */
  async merge(prNumber, options = {}) {
    const checkResult = await this.checkMergeable(prNumber)
    if (!checkResult.mergeable) {
      throw new Error(`Cannot merge PR ${prNumber}: ${checkResult.violations.map(v => v.message).join('; ')}`)
    }

    const pr = await this.github.getPR(prNumber)
    const mergeMethod = options.method || this.policy.defaultMergeMethod

    if (!this.policy.allowedMergeMethods.includes(mergeMethod)) {
      throw new Error(`Merge method '${mergeMethod}' not allowed. Allowed: ${this.policy.allowedMergeMethods.join(', ')}`)
    }

    try {
      const result = await this.github.mergePR(prNumber, {
        mergeMethod,
        commitTitle: options.commitTitle || pr.title,
        commitMessage: options.commitMessage || pr.body
      })

      return {
        prNumber,
        merged: true,
        method: mergeMethod,
        message: result?.message || 'Merged successfully',
        sha: result?.sha || null
      }
    } catch (error) {
      if (error.status === 405) {
        throw new Error(`Merge blocked by branch protection rules: ${error.message}`)
      }
      throw error
    }
  }

  // ============ 检查器 ============

  async checkBasicState(pr, result) {
    result.metadata.prTitle = pr.title
    result.metadata.prBody = pr.body
    result.metadata.baseBranch = pr.base.ref
    result.metadata.headBranch = pr.head.ref
    result.metadata.state = pr.state

    // 关闭的 PR 无法合并
    if (pr.state !== 'open') {
      result.violations.push({
        code: 'PR_CLOSED',
        message: `PR is ${pr.state}, cannot merge`
      })
      result.mergeable = false
      return
    }

    // 检查目标分支 — bannedBranches 只限制合并操作，不影响审查
    // 但如果明确禁止，给出警告而非阻止
    if (this.policy.bannedBranches.includes(pr.base.ref)) {
      result.warnings.push({
        code: 'BANNED_TARGET_BRANCH',
        message: `Merge to '${pr.base.ref}' is not allowed. Set bannedBranches: [] to override.`
      })
      // 不 set mergeable = false，只警告
    }

    // 检查 PR 描述
    if (this.policy.requireDescription && (!pr.body || pr.body.trim().length < this.policy.minDescriptionLength)) {
      result.violations.push({
        code: 'SHORT_DESCRIPTION',
        message: `PR description too short (min ${this.policy.minDescriptionLength} chars)`
      })
      result.mergeable = false
    }
  }

  async checkReviewStatus(pr, result) {
    const reviews = await this.github.listReviews(pr.number)
    result.metadata.reviews = reviews

    // 计数：approved / changes_requested / commented
    const approvedReviews = reviews.filter(r => r.state === 'APPROVED')
    const changesRequestedReviews = reviews.filter(r => r.state === 'CHANGES_REQUESTED')
    const commentedReviews = reviews.filter(r => r.state === 'COMMENTED')

    result.checks.approvals = approvedReviews.length
    result.checks.changesRequested = changesRequestedReviews.length
    result.checks.reviews = reviews.length

    // 检查 changes_requested
    if (this.policy.requireNoChangesRequested && changesRequestedReviews.length > 0) {
      result.violations.push({
        code: 'CHANGES_REQUESTED',
        message: `${changesRequestedReviews.length} review(s) requested changes`
      })
      result.mergeable = false
      return
    }

    // 检查 approvals 数量
    if (approvedReviews.length < this.policy.requiredApprovals) {
      result.violations.push({
        code: 'INSUFFICIENT_APPROVALS',
        message: `Need ${this.policy.requiredApprovals} approval(s), have ${approvedReviews.length}`
      })
      result.mergeable = false
      return
    }

    // 检查是否自 approve（如果禁止）
    if (!this.policy.allowSelfApprove && pr?.user?.login) {
      const selfApproved = approvedReviews.some(r => r.user?.login === pr.user.login)
      if (selfApproved) {
        result.warnings.push({
          code: 'SELF_APPROVE',
          message: 'PR author self-approved (allowSelfApprove is false)'
        })
      }
    }
  }

  async checkCIStatus(pr, result) {
    try {
      const prSha = pr.head?.sha
      if (!prSha) throw new Error('PR has no head commit SHA')
      const status = await this.github.getCombinedStatus(prSha)
      result.metadata.ciStatus = status

      if (!status) {
        result.warnings.push({
          code: 'CI_UNAVAILABLE',
          message: 'Unable to fetch CI status'
        })
        return
      }

      if (status.state !== 'success') {
        const failingContexts = (status.statuses || []).filter(s => s.state !== 'success' && s.state !== 'pending')
        if (failingContexts.length > 0) {
          result.violations.push({
            code: 'CI_FAILED',
            message: `CI checks failing: ${failingContexts.map(c => c.context).join(', ')}`,
            details: failingContexts
          })
          result.mergeable = false
        }
      } else {
        result.checks.ciPassed = true
        result.checks.ciContexts = (status.statuses || []).map(s => s.context)
      }
    } catch (error) {
      result.warnings.push({
        code: 'CI_FAILED',
        message: `CI check unavailable: ${error.message}`
      })
      // 不阻止合并，只告警
    }
  }

  async checkBranchProtection(pr, result) {
    try {
      const protection = await this.github.request(
        `/repos/${this.github.owner}/${this.github.repo}/branches/${pr.base.ref}/protection`
      )

      result.metadata.branchProtection = protection

      // 检查 required_pull_request_reviews
      if (protection.required_pull_request_reviews) {
        const req = protection.required_pull_request_reviews
        if (req.required_approving_review_count > result.checks.approvals) {
          result.violations.push({
            code: 'BRANCH_PROTECTION_APPROVALS',
            message: `Branch requires ${req.required_approving_review_count} approvals`
          })
          result.mergeable = false
        }
      }

      // 检查 required_status_checks
      if (protection.required_status_checks?.contexts?.length > 0) {
        const requiredContexts = protection.required_status_checks.contexts
        const ciContexts = result.checks.ciContexts || []
        const missing = requiredContexts.filter(c => !ciContexts.includes(c))
        if (missing.length > 0) {
          result.violations.push({
            code: 'MISSING_REQUIRED_CHECKS',
            message: `Missing required status checks: ${missing.join(', ')}`
          })
          result.mergeable = false
        }
      }
    } catch (error) {
      if (error.status === 404) {
        // 无分支保护规则，继续
        result.metadata.branchProtection = null
      } else {
        throw error
      }
    }
  }

  async checkAutoMergeLabels(pr, result) {
    const labels = pr.labels?.map(l => l.name) || []
    const hasAutoMerge = labels.some(l => this.policy.autoMergeLabels.includes(l))

    if (hasAutoMerge) {
      result.checks.autoMergeLabel = true
      // 不自动合并，只是标记 Eligible
      result.metadata.autoMergeEligible = true
    }
  }

  async checkIgnoreLabels(pr, result) {
    const labels = pr.labels?.map(l => l.name) || []
    const hasIgnore = labels.some(l => this.policy.ignoreLabels.includes(l))

    if (hasIgnore) {
      result.warnings.push({
        code: 'IGNORED_LABEL',
        message: 'PR has ignore label, consider not merging automatically'
      })
    }
  }
}

/**
 * 快速检查：PR 是否可合并（简化版）
 */
export async function isPRMergeable(github, prNumber, policy = {}) {
  const checker = new PRMergePolicy(github, policy)
  const result = await checker.checkMergeable(prNumber)
  return result.mergeable
}

/**
 * 批量检查：找出所有待处理可自动合并的 PR
 */
export async function findEligiblePRs(github, options = {}) {
  const { label, limit = 50 } = options
  if (!github || typeof github.listPRs !== 'function') {
    throw new Error('Invalid GitHub API instance')
  }
  const prs = await github.listPRs({ state: 'open', per_page: limit })
  const checker = new PRMergePolicy(github)

  const eligible = []
  for (const pr of (prs || [])) {
    if (label && !pr.labels?.some(l => l.name === label)) {
      continue
    }

    try {
      const result = await checker.checkMergeable(pr.number)
      if (result.mergeable && result.metadata.autoMergeEligible) {
        eligible.push({ pr, check: result })
      }
    } catch (error) {
      console.error(`Error checking PR ${pr.number}:`, error.message)
    }
  }

  return eligible
}