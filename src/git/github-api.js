/**
 * GitHub REST API 封装（零外部依赖）
 * 使用原生 fetch (Node.js ≥ 18)
 */

export class GitHubAPI {
  /**
   * @param {Object} config
   * @param {string} config.token - GitHub Personal Access Token
   * @param {string} config.owner - Repository owner
   * @param {string} config.repo - Repository name
   * @param {string} [config.baseUrl] - API base URL (for enterprise)
   */
  constructor(config) {
    this.token = config.token || process.env.GITHUB_TOKEN
    this.owner = config.owner
    this.repo = config.repo
    this.baseUrl = config.baseUrl || 'https://api.github.com'
    this.apiVersion = '2022-11-28' // GitHub API version

    if (!this.token) {
      throw new Error('GitHub token required (set GITHUB_TOKEN or pass token param)')
    }
    if (!this.owner || !this.repo) {
      throw new Error('GitHub repository owner and repo required')
    }
  }

  /**
   * 发送请求到 GitHub API
   */
  async request(endpoint, options = {}) {
    const url = `${this.baseUrl}${endpoint}`
    const headers = {
      'Authorization': `Bearer ${this.token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': this.apiVersion,
      ...options.headers
    }

    // 速率限制检查
    const shouldRetry = this._shouldRetryAfter(options)
    if (shouldRetry.retry) {
      await this._delay(shouldRetry.after)
    }

    const response = await fetch(url, {
      ...options,
      headers
    })

    // 更新速率限制信息
    this._updateRateLimitInfo(response)

    // 处理错误
    if (!response.ok) {
      const error = await this._parseError(response)
      if (response.status === 403 && this._isRateLimited(response)) {
        throw new GitHubRateLimitError(error.message, response)
      }
      throw new GitHubError(error.message, response.status, error.documentation_url)
    }

    // 204 No Content
    if (response.status === 204) {
      return null
    }

    return await response.json()
  }

  /**
   * GET 请求
   */
  async get(endpoint, params = {}) {
    const fullUrl = `${this.baseUrl}${endpoint}`
    const queryParts = []
    Object.keys(params).forEach(key => {
      if (params[key] !== undefined && params[key] !== null) {
        queryParts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(params[key]))}`)
      }
    })
    const queryString = queryParts.length > 0 ? `?${queryParts.join('&')}` : ''

    return this.request(`${endpoint}${queryString}`, { method: 'GET' })
  }

  /**
   * POST 请求
   */
  async post(endpoint, body) {
    return this.request(endpoint, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' }
    })
  }

  /**
   * PUT 请求
   */
  async put(endpoint, body) {
    return this.request(endpoint, {
      method: 'PUT',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' }
    })
  }

  /**
   * PATCH 请求
   */
  async patch(endpoint, body) {
    return this.request(endpoint, {
      method: 'PATCH',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' }
    })
  }

  /**
   * DELETE 请求
   */
  async delete(endpoint) {
    return this.request(endpoint, { method: 'DELETE' })
  }

  // ============ Pull Requests API ============

  /**
   * 列出 PRs
   * GET /repos/{owner}/{repo}/pulls
   */
  async listPRs(params = {}) {
    // 默认只获取 open 状态的 PR
    const defaultParams = { state: 'open', per_page: 100 }
    const query = { ...defaultParams, ...params }
    return this.get(`/repos/${this.owner}/${this.repo}/pulls`, query)
  }

  /**
   * 获取单个 PR
   * GET /repos/{owner}/{repo}/pulls/{pr_number}
   */
  async getPR(prNumber) {
    return this.get(`/repos/${this.owner}/${this.repo}/pulls/${prNumber}`)
  }

  /**
   * 获取 PR 的 diff
   * GET /repos/{owner}/{repo}/pulls/{pr_number}/files
   */
  async getPRFiles(prNumber) {
    return this.get(`/repos/${this.owner}/${this.repo}/pulls/${prNumber}/files`)
  }

  /**
   * 获取 PR 提交的 diff (未压缩)
   */
  async getPRDiff(prNumber) {
    const endpoint = `/repos/${this.owner}/${this.repo}/pulls/${prNumber}`
    // 使用统一的 request 方法，但走 diff 类型的 Accept
    // 单独 fetch diff，因为需要 text() 而非 json()
    const diffUrl = `${this.baseUrl}/repos/${this.owner}/${this.repo}/pulls/${prNumber}.diff`
    const diffResponse = await fetch(diffUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Accept': 'application/vnd.github.v3.diff'
      }
    })

    if (!diffResponse.ok) {
      const errMsg = `Failed to fetch PR diff: ${diffResponse.status} ${diffResponse.statusText}`
      throw new GitHubError(errMsg, diffResponse.status)
    }

    return await diffResponse.text()
  }

  /**
   * 创建 PR 评论
   * POST /repos/{owner}/{repo}/pulls/{pr_number}/reviews
   */
  async createReview(prNumber, body, event = 'COMMENT', comments = []) {
    return this.post(`/repos/${this.owner}/${this.repo}/pulls/${prNumber}/reviews`, {
      body,
      event, // 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES'
      comments // [{ path, position, body }]
    })
  }

  /**
   * 在 PR diff 的特定行添加评论
   * POST /repos/{owner}/{repo}/pulls/{pr_number}/comments
   */
  async createComment(prNumber, body, { path, position, commitId }) {
    return this.post(`/repos/${this.owner}/${this.repo}/pulls/${prNumber}/comments`, {
      body,
      path,
      position,
      commit_id: commitId
    })
  }

  /**
   * 更新 PR 评论（回复）
   * PATCH /repos/{owner}/{repo}/pulls/comments/{comment_id}
   */
  async updateComment(commentId, body) {
    return this.patch(`/repos/${this.owner}/${this.repo}/pulls/comments/${commentId}`, { body })
  }

  /**
   * 删除 PR 评论
   * DELETE /repos/{owner}/{repo}/pulls/comments/{comment_id}
   */
  async deleteComment(commentId) {
    return this.delete(`/repos/${this.owner}/${this.repo}/pulls/comments/${commentId}`)
  }

  /**
   * 获取 PR 的评论线程
   * GET /repos/{owner}/{repo}/pulls/{pr_number}/comments
   */
  async listPRComments(prNumber) {
    return this.get(`/repos/${this.owner}/${this.repo}/pulls/${prNumber}/comments`)
  }

  /**
   * Approve PR
   */
  async approvePR(prNumber, body) {
    return this.createReview(prNumber, body || 'Approved', 'APPROVE')
  }

  /**
   * Request changes on PR
   */
  async requestChanges(prNumber, body) {
    return this.createReview(prNumber, body || 'Changes requested', 'REQUEST_CHANGES')
  }

  /**
   * 合并 PR
   * POST /repos/{owner}/{repo}/pulls/{pr_number}/merge
   */
  async mergePR(prNumber, options = {}) {
    const { commitTitle, commitMessage, mergeMethod = 'merge' } = options
    return this.post(`/repos/${this.owner}/${this.repo}/pulls/${prNumber}/merge`, {
      commit_title: commitTitle,
      commit_message: commitMessage,
      merge_method: mergeMethod // 'merge' | 'squash' | 'rebase'
    })
  }

  /**
   * 检查 PR 是否可合并
   * GET /repos/{owner}/{repo}/pulls/{pr_number}/mergeable
   */
  async isMergeable(prNumber) {
    const pr = await this.getPR(prNumber)
    // GitHub 返回 null 表示还在计算中，不视为不可合并
    return pr.mergeable !== false
  }

  /**
   * 获取 PR 的状态检查（CI checks）
   * GET /repos/{owner}/{repo}/commits/{commit_sha}/status
   */
  /**
   * 获取 PR 的合并状态（combine status）
   * GET /repos/{owner}/{repo}/commits/{commit_sha}/status
   */
  async getCombinedStatus(commitSha) {
    if (!commitSha) {
      throw new Error('commitSha is required for getCombinedStatus')
    }
    return this.get(`/repos/${this.owner}/${this.repo}/commits/${commitSha}/status`)
  }

  /**
   * 列出 PR 的审查评论（reviews）
   * GET /repos/{owner}/{repo}/pulls/{pr_number}/reviews
   */
  async listReviews(prNumber) {
    return this.get(`/repos/${this.owner}/${this.repo}/pulls/${prNumber}/reviews`)
  }

  // ============ 辅助方法 ============

  _updateRateLimitInfo(response) {
    this.rateLimitRemaining = parseInt(response.headers.get('X-RateLimit-Remaining'), 10)
    this.rateLimitReset = parseInt(response.headers.get('X-RateLimit-Reset'), 10) // Unix timestamp
    this.rateLimitLimit = parseInt(response.headers.get('X-RateLimit-Limit'), 10)
  }

  _isRateLimited(response) {
    return response.status === 403 && response.headers.get('X-RateLimit-Remaining') === '0'
  }

  _shouldRetryAfter(options) {
    if (options._retryCount && options._retryCount > 3) {
      return { retry: false }
    }
    if (this.rateLimitRemaining === 0 && this.rateLimitReset) {
      const now = Math.floor(Date.now() / 1000)
      const waitSeconds = Math.max(this.rateLimitReset - now + 1, 1)
      return { retry: true, after: waitSeconds * 1000 }
    }
    return { retry: false }
  }

  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  async _parseError(response) {
    let message = `${response.status} ${response.statusText}`
    let documentationUrl = null
    try {
      const data = await response.json()
      message = data.message || message
      documentationUrl = data.documentation_url || null
    } catch {
      // ignore parse error, keep fallback message
    }
    return { message, documentation_url: documentationUrl }
  }
}

/**
 * GitHub API 错误
 */
export class GitHubError extends Error {
  constructor(message, status, documentationUrl = null) {
    super(message)
    this.name = 'GitHubError'
    this.status = status
    this.documentationUrl = documentationUrl
  }
}

/**
 * 速率限制错误
 */
export class GitHubRateLimitError extends GitHubError {
  constructor(message, response) {
    super(message, response.status)
    this.name = 'GitHubRateLimitError'
    this.resetAt = parseInt(response.headers.get('X-RateLimit-Reset'), 10)
  }
}

/**
 * 创建 GitHub API 实例的工厂函数
 */
export function createGitHubAPI(options) {
  return new GitHubAPI(options)
}