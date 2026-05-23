/**
 * GitTool 测试脚本
 * 用法:
 *   GITHUB_TOKEN=*** GITHUB_OWNER=owner GITHUB_REPO=repo node test-git-tool.js <action> [prNumber]
 *
 * 示例:
 *   node test-git-tool.js list
 *   node test-git-tool.js review 123
 *   node test-git-tool.js check-mergeable 123
 */

import { createGitTool } from './src/tools/git-tool.js'

async function main() {
  const [action, prNumberStr] = process.argv.slice(2)
  if (!action) {
    console.log(`
Usage: GITHUB_TOKEN=*** GITHUB_OWNER=owner GITHUB_REPO=repo node test-git-tool.js <action> [prNumber]

Actions:
  list                              List open PRs
  get <prNumber>                    Get PR details
  review <prNumber>                 Review PR (auto-analysis)
  review-llm <prNumber>             Review with LLM analysis
  check-mergeable <prNumber>        Check if PR can be merged
  list-eligible                     List auto-merge eligible PRs
  comment <prNumber> "<body>"       Add general comment
  approve <prNumber> [body]         Approve PR
  request-changes <prNumber> [body] Request changes
`)
    return
  }

  const prNumber = prNumberStr ? parseInt(prNumberStr, 10) : null
  if (!prNumber && ['get', 'review', 'review-llm', 'check-mergeable', 'comment', 'approve', 'request-changes'].includes(action)) {
    console.error('Error: prNumber required for this action')
    process.exit(1)
  }

  try {
    const gitTool = createGitTool({
      // 从环境变量获取 owner/repo
      owner: process.env.GITHUB_OWNER,
      repo: process.env.GITHUB_REPO,
      // 启用 LLM
      enableLLM: !!process.env.DEEPSEEK_API_KEY,
      llm: {
        apiKey: process.env.DEEPSEEK_API_KEY,
        apiBase: process.env.DEEPSEEK_API_BASE || 'https://api.deepseek.com/v1',
        model: process.env.DEEPSEEK_MODEL || 'deepseek-chat'
      },
      // 审查规则
      reviewRules: {
        checks: {
          codeQuality: true,
          security: true,
          tests: true,
          docs: true
        }
      }
    })

    switch (action) {
      case 'list':
        const list = await gitTool.execute({ action: 'list-prs', limit: 10 })
        console.log(`Found ${list.count} open PRs:`)
        for (const pr of list.prs) {
          console.log(`  #${pr.number} ${pr.title} (@${pr.user}) [${pr.head} → ${pr.base}]`)
        }
        break

      case 'get':
        const get = await gitTool.execute({ action: 'get-pr', prNumber })
        console.log(`PR #${get.number}: ${get.title}`)
        console.log(`Author: @${get.user} | ${get.additions}+ ${get.deletions}- | ${get.changedFiles} files`)
        console.log(`Base: ${get.base} | Head: ${get.head}`)
        console.log(`Mergeable: ${get.mergeable}`)
        break

      case 'review':
        const review = await gitTool.execute({ action: 'review-pr', prNumber, analyzeLLM: false, autoComment: false })
        console.log(`Review completed: ${review.findings.length} findings`)
        console.log(`Overall: ${review.summary.overall}`)
        console.log(`Risk level: ${review.llmSummary?.riskLevel || 'N/A'}`)
        for (const f of review.findings) {
          console.log(`  [${f.severity}] ${f.file}:${f.line || '-'} ${f.message}`)
        }
        break

      case 'review-llm':
        const reviewLLM = await gitTool.execute({ action: 'review-pr', prNumber, analyzeLLM: true, autoComment: false })
        console.log('LLM Review:')
        console.log(reviewLLM.llmSummary?.summary || 'No LLM summary')
        console.log('\\nFindings: ' + reviewLLM.findings.length + ' issues')
        break

      case 'check-mergeable':
        const check = await gitTool.execute({ action: 'check-mergeable', prNumber })
        console.log(`PR #${check.prNumber} mergeable: ${check.mergeable}`)
        if (!check.mergeable) {
          console.log('Violations:')
          for (const v of check.violations) {
            console.log(`  - [${v.code}] ${v.message}`)
          }
        } else {
          console.log('Checks passed:')
          for (const [key, value] of Object.entries(check.checks)) {
            if (value === true) console.log(`  ✓ ${key}`)
          }
        }
        break

      case 'list-eligible':
        const eligible = await gitTool.execute({ action: 'auto-merge-eligible', label: 'auto-merge' })
        console.log(`Found ${eligible.eligible} eligible PRs out of ${eligible.total}`)
        for (const item of eligible.items) {
          console.log(`  #${item.number} ${item.title}`)
          if (item.violations.length > 0) {
            console.log(`     Blocked: ${item.violations[0].message}`)
          }
        }
        break

      case 'comment':
        const commentBody = process.argv[3]
        if (!commentBody) {
          console.error('Error: comment body required')
          process.exit(1)
        }
        await gitTool.execute({ action: 'comment', prNumber, body: commentBody })
        console.log('Comment posted')
        break

      case 'approve':
        const approveBody = process.argv[3] || 'Approved'
        await gitTool.execute({ action: 'approve', prNumber, body: approveBody })
        console.log('PR approved')
        break

      case 'request-changes':
        const rcBody = process.argv[3] || 'Changes requested'
        await gitTool.execute({ action: 'request-changes', prNumber, body: rcBody })
        console.log('Changes requested')
        break

      default:
        console.error(`Unknown action: ${action}`)
        process.exit(1)
    }
  } catch (error) {
    console.error(`Error: ${error.message}`)
    if (error.status) console.error(`HTTP ${error.status}`)
    process.exit(1)
  }
}

main()