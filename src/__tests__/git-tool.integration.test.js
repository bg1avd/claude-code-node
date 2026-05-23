/**
 * GitTool 集成测试
 * 测试工具在真实环境中的集成情况
 */

import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert'

// 模拟 GitHub API 响应
function mockGitHubAPI() {
  return {
    token: 'mock-token',
    owner: 'test-owner',
    repo: 'test-repo',
    baseUrl: 'https://api.github.com',
    request: async (endpoint, options = {}) => {
      if (endpoint.includes('/pulls')) {
        return [{ number: 1, title: 'Test PR', state: 'open', user: { login: 'tester' } }]
      }
      if (endpoint.includes('/pulls/1')) {
        return {
          number: 1,
          title: 'Test PR',
          body: 'Test',
          user: { login: 'tester' },
          head: { ref: 'feature', sha: 'abc123' },
          base: { ref: 'main' },
          mergeable: true,
          changed_files: 1,
          additions: 1,
          deletions: 0,
          labels: []
        }
      }
      return {}
    }
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
    // 注入 mock 的 GitHub API
    tool.github = mockGitHubAPI()
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
