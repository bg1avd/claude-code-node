/**
 * GitTool 集成测试
 * 测试工具在真实环境中的集成情况
 */

import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert'

// 模拟 GitHub API 客户端
// 注意：GitTool 内部调用的是「高层方法」（listPRs/getPR/getPRFiles/...），
// 而非低层 request()，因此 mock 必须提供这些方法，否则报 is not a function。
function mockGitHubAPI() {
  const pr = {
    number: 1,
    title: 'Test PR',
    body: 'Test',
    state: 'open',
    user: { login: 'tester' },
    head: { ref: 'feature', sha: 'abc123' },
    base: { ref: 'main' },
    mergeable: true,
    changed_files: 1,
    additions: 1,
    deletions: 0,
    labels: [],
    comments: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z'
  }
  return {
    token: 'mock-token',
    owner: 'test-owner',
    repo: 'test-repo',
    baseUrl: 'https://api.github.com',
    request: async () => ({}),
    listPRs: async () => [pr],
    getPR: async () => pr,
    getPRFiles: async () => [{ filename: 'src/a.js', additions: 1, deletions: 0 }],
    getPRDiff: async () => '',
    listReviews: async () => [{ user: { login: 'tester' }, state: 'APPROVED' }],
    isMergeable: async () => true,
    createReview: async () => ({ id: 1 }),
    createComment: async () => ({ id: 1 }),
    approvePR: async () => ({ id: 1 }),
    requestChanges: async () => ({ id: 1 })
  }
}

// 导入 GitTool 类
import { GitTool } from '../tools/git-tool.js'

describe('GitTool Integration', () => {
  let tool

  beforeEach(() => {
    // 创建 GitTool 实例，使用 mock 配置
    tool = new GitTool({
      owner: 'test-owner',
      repo: 'test-repo',
      token: 'mock-token'
    })
    // 注入 mock 的 GitHub API + 合并策略/审查器
    // （ensureGitHubClient 见到 this.github 已存在会提前 return，不会自行构造它们的依赖）
    tool.github = mockGitHubAPI()
    tool.mergePolicy = {
      checkMergeable: async (prNumber) => ({
        prNumber,
        mergeable: true,
        checks: {},
        violations: [],
        warnings: [],
        metadata: {}
      })
    }
    tool.reviewer = { reviewPR: async () => ({ findings: [], comments: [] }) }
  })

  test('should list PRs', async () => {
    const result = await tool.execute({ action: 'list-prs', limit: 10 })
    assert.ok(result.count >= 0)
    assert.ok(Array.isArray(result.prs))
  })

  test('should get PR details', async () => {
    const result = await tool.execute({ action: 'get-pr', prNumber: 1 })
    assert.strictEqual(result.number, 1)
    assert.ok(result.title.length > 0)
  })

  test('should check mergeable', async () => {
    const result = await tool.execute({ action: 'check-mergeable', prNumber: 1 })
    assert.ok('mergeable' in result)
    assert.ok('checks' in result)
    assert.ok('violations' in result)
  })

  test('should validate parameters before execution', async () => {
    await assert.rejects(
      tool.execute({ action: 'list-prs', state: 'invalid' }),
      /Invalid enum value/
    )
  })

  test('should handle unknown action', async () => {
    await assert.rejects(
      tool.execute({ action: 'unknown-action' }),
      /Unknown action/
    )
  })
})
