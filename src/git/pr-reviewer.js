/**
 * PR 自动审查引擎
 * 结合规则检查 + LLM 智能评估
 */

import { parseDiff, splitDiffByFile, countFileChanges } from './utils/diff-parser.js'
import { GitHubAPI } from './github-api.js'
import { callLLM, buildPRReviewPrompt } from './llm-assistant.js'

/**
 * PR 审查器
 */
export class PRReviewer {
  /**
   * @param {GitHubAPI} github - GitHub API 实例
   * @param {Object} rules - 审查规则配置
   */
  constructor(github, rules = {}, options = {}) {
    this.github = github
    this.rules = {
      checks: {
        codeQuality: true,
        security: true,
        tests: true,
        docs: true,
        complexity: true,
        duplication: true
      },
      ...rules
    }
    this.apiConfig = options.apiConfig || {}
    this.enableLLM = options.enableLLM !== false
  }

  /**
   * 审查 PR
   * @param {number} prNumber
   * @param {Object} options - 审查选项
   * @returns {Promise<ReviewResult>}
   */
  async reviewPR(prNumber, options = {}) {
    const {
      analyzeLLM = true,  // 是否使用 LLM 智能分析
      commentThreshold = 'WARNING' // 'INFO' | 'WARNING' | 'ERROR'
    } = options

    // 1. 获取 PR 数据
    const pr = await this.github.getPR(prNumber)
    const diff = await this.github.getPRDiff(prNumber)
    const files = await this.github.getPRFiles(prNumber)

    // 2. 解析 diff
    const fileMap = splitDiffByFile(diff)
    const allHunks = parseDiff(diff)

    // 3. 运行规则检查
    const findings = await this.runAllChecks(pr, files, diff, fileMap)

    // 4. LLM 智能分析（可选）
    let llmSummary = null
    if (analyzeLLM && this.enableLLM && findings.length > 0) {
      llmSummary = await this.llmAnalysis(pr, findings, diff)
    } else if (findings.length === 0) {
      llmSummary = { summary: '✅ No issues found', riskLevel: 'LOW', recommendations: ['PR looks good to merge'] }
    }

    // 5. 生成审查报告
    const report = this.generateReviewReport(pr, findings, llmSummary)

    // 6. 准备评论列表（根据 threshold 过滤）
    const comments = findings
      .filter(f => this.shouldComment(f, commentThreshold))
      .map(f => this.buildReviewComment(f))

    return {
      prNumber,
      prTitle: pr.title,
      prBody: pr.body,
      findings,
      summary: report,
      llmSummary,
      comments,
      meta: {
        totalFiles: files.length,
        totalLinesChanged: files.reduce((sum, f) => sum + f.additions + f.deletions, 0),
        reviewedAt: new Date().toISOString()
      }
    }
  }

  /**
   * 执行所有检查
   */
  async runAllChecks(pr, files, diff, fileMap) {
    const findings = []

    // 并行运行所有检查器
    const checks = []

    if (this.rules.checks.codeQuality) {
      checks.push(this.checkCodeQuality(files, fileMap))
    }
    if (this.rules.checks.security) {
      checks.push(this.checkSecurity(files, fileMap))
    }
    if (this.rules.checks.tests) {
      checks.push(this.checkTests(files, fileMap))
    }
    if (this.rules.checks.docs) {
      checks.push(this.checkDocs(pr, files, fileMap))
    }
    if (this.rules.checks.complexity) {
      checks.push(this.checkComplexity(files, fileMap))
    }
    if (this.rules.checks.duplication) {
      checks.push(this.checkDuplication(files, fileMap))
    }

    const results = await Promise.all(checks)
    findings.push(...results.flat())

    return findings
  }

  // ============ 检查器实现 ============

  /**
   * 代码质量检查
   */
  async checkCodeQuality(files, fileMap) {
    const findings = []
    const patterns = {
      'console.log': { severity: 'WARNING', message: 'Remove console.log before merging' },
      'debugger': { severity: 'ERROR', message: 'Remove debugger statements' },
      'FIXME': { severity: 'INFO', message: 'FIXME comment found' },
      'TODO': { severity: 'INFO', message: 'TODO comment found' },
      'XXX': { severity: 'WARNING', message: 'XXX comment indicates incomplete code' },
      'var ': { severity: 'WARNING', message: 'Consider using const/let instead of var' },
      '===': { severity: 'WARNING', message: 'Strict equality === is fine, but consider type-safe comparison' } // false positive demo
    }

    for (const [filePath, hunks] of fileMap.entries()) {
      const isCodeFile = this.isCodeFile(filePath)
      if (!isCodeFile) continue

      const changes = countFileChanges(hunks)
      if (changes.changes === 0) continue

      for (const hunk of hunks) {
        for (const line of hunk.lines) {
          if (line.type !== '+') continue // 只检查新增的代码

          const content = line.content
          for (const [pattern, info] of Object.entries(patterns)) {
            if (content.includes(pattern)) {
              findings.push({
                type: 'code-quality',
                severity: info.severity,
                file: filePath,
                line: line.newLineNum,
                column: 0,
                message: `${info.message} (line: ${content.trim()})`,
                snippet: content.trim(),
                rule: pattern
              })
            }
          }
        }
      }
    }

    return findings
  }

  /**
   * 安全检查（关键漏洞检测）
   */
  async checkSecurity(files, fileMap) {
    const findings = []
    const securityPatterns = {
      // 硬编码密钥
      'password': { severity: 'ERROR', message: 'Potential hardcoded password' },
      'secret': { severity: 'ERROR', message: 'Potential hardcoded secret' },
      'api_key': { severity: 'ERROR', message: 'Potential API key' },
      'token': { severity: 'WARNING', message: 'Potential token hardcoded' },
      // SQL 注入风险
      'SELECT .* FROM': { severity: 'ERROR', message: 'Possible SQL injection if string concatenation' },
      'eval(': { severity: 'CRITICAL', message: 'eval() is dangerous' },
      // 路径遍历
      '../': { severity: 'WARNING', message: 'Path traversal risk' },
      '__dirname': { severity: 'WARNING', message: 'Check path construction safety' },
      // XSS
      'innerHTML': { severity: 'WARNING', message: 'Potential XSS when using innerHTML' },
      'document.write': { severity: 'ERROR', message: 'Avoid document.write' }
    }

    for (const [filePath, hunks] of fileMap.entries()) {
      const isCodeFile = this.isCodeFile(filePath)
      if (!isCodeFile) continue

      for (const hunk of hunks) {
        for (const line of hunk.lines) {
          if (line.type !== '+') continue

          const content = line.content.toLowerCase()
          for (const [pattern, info] of Object.entries(securityPatterns)) {
            const regex = new RegExp(pattern, 'i')
            if (regex.test(content)) {
              findings.push({
                type: 'security',
                severity: info.severity,
                file: filePath,
                line: line.newLineNum,
                message: info.message,
                snippet: line.content.trim(),
                rule: pattern
              })
            }
          }
        }
      }
    }

    return findings
  }

  /**
   * 测试覆盖率检查
   */
  async checkTests(files, fileMap) {
    const findings = []

    // 检查是否有新增代码但缺少对应测试
    const modifiedFiles = new Set()
    const testFiles = new Set()

    for (const [filePath] of fileMap.entries()) {
      modifiedFiles.add(filePath)
      if (this.isTestFile(filePath)) {
        testFiles.add(filePath)
      }
    }

    // 统计未覆盖的修改文件
    for (const file of modifiedFiles) {
      if (this.isTestFile(file)) continue

      const hasCorrespondingTest = this.findTestFile(file, Array.from(testFiles))
      if (!hasCorrespondingTest) {
        const changes = countFileChanges(fileMap.get(file) || [])
        if (changes.additions > 5) { // 只提示较明显的修改
          findings.push({
            type: 'tests',
            severity: 'WARNING',
            file,
            line: null,
            message: `New/modified code but missing test file for ${this.getFileName(file)}`,
            rule: 'missing-test'
          })
        }
      }
    }

    return findings
  }

  /**
   * 文档检查
   */
  async checkDocs(pr, files, fileMap) {
    const findings = []

    // 检查 PR 描述是否足够详细
    if (!pr.body || pr.body.trim().length < 50) {
      findings.push({
        type: 'docs',
        severity: 'INFO',
        file: null,
        line: null,
        message: 'PR description is brief; consider adding more context (purpose, testing steps, breaking changes)',
        rule: 'pr-description'
      })
    }

    // 检查 API 变更是否更新文档
    const hasAPIFiles = Array.from(fileMap.keys()).some(p => p.includes('src/') || p.includes('lib/'))
    const hasDocsFiles = Array.from(fileMap.keys()).some(p => p.includes('docs/') || p.includes('README'))

    if (hasAPIFiles && !hasDocsFiles) {
      findings.push({
        type: 'docs',
        severity: 'WARNING',
        file: null,
        line: null,
        message: 'Code changes detected but no documentation updates found',
        rule: 'missing-docs'
      })
    }

    return findings
  }

  /**
   * 复杂度检查（简易版：检查大函数）
   */
  async checkComplexity(files, fileMap) {
    const findings = []
    const complexityThreshold = 50 // 行数阈值

    for (const [filePath, hunks] of fileMap.entries()) {
      const isCodeFile = this.isCodeFile(filePath)
      if (!isCodeFile) continue

      // 简单统计：统计新增的连续行
      for (const hunk of hunks) {
        let addedBlockStart = null
        let addedBlockLines = 0

        for (const line of hunk.lines) {
          if (line.type === '+') {
            if (addedBlockStart === null) {
              addedBlockStart = line.newLineNum
            }
            addedBlockLines++
          } else {
            if (addedBlockLines > 0 && addedBlockLines >= complexityThreshold) {
              findings.push({
                type: 'complexity',
                severity: 'WARNING',
                file: filePath,
                line: addedBlockStart,
                message: `Large addition (${addedBlockLines} lines) may indicate complex logic`,
                rule: 'large-block'
              })
            }
            addedBlockStart = null
            addedBlockLines = 0
          }
        }
      }
    }

    return findings
  }

  /**
   * 重复代码检查（简易版：检测重复行）
   */
  async checkDuplication(files, fileMap) {
    const findings = []
    const addedLines = []

    // 收集所有新增行
    for (const [filePath, hunks] of fileMap.entries()) {
      const isCodeFile = this.isCodeFile(filePath)
      if (!isCodeFile) continue

      for (const hunk of hunks) {
        for (const line of hunk.lines) {
          if (line.type === '+') {
            addedLines.push({
              file: filePath,
              line: line.newLineNum,
              content: line.content.trim()
            })
          }
        }
      }
    }

    // 检查重复行（简单 O(n^2) 检查，适合增量数量）
    const duplicates = new Set()
    for (let i = 0; i < addedLines.length; i++) {
      for (let j = i + 1; j < addedLines.length; j++) {
        if (addedLines[i].content === addedLines[j].content &&
            addedLines[i].content.length > 20 && // 忽略短行
            !duplicates.has(i) && !duplicates.has(j)) {
          findings.push({
            type: 'duplication',
            severity: 'WARNING',
            file: addedLines[i].file,
            line: addedLines[i].line,
            message: 'Potential duplicate code found in another location',
            rule: 'duplicate-lines',
            duplicateLocation: `${addedLines[j].file}:${addedLines[j].line}`
          })
          duplicates.add(i)
          duplicates.add(j)
        }
      }
    }

    return findings
  }

  // ============ LLM 智能分析 ============

  /**
   * 使用 LLM 进行整体评估
   */
  async llmAnalysis(pr, findings, diff) {
    try {
      const prompt = buildPRReviewPrompt(pr, diff, findings)
      const response = await callLLM(
        'You are an expert code reviewer. Provide concise, actionable feedback.',
        prompt,
        this.apiConfig
      )

      // 解析 LLM 输出（简化：直接返回文本）
      return {
        summary: response,
        riskLevel: this._inferRiskLevel(response),
        recommendations: this._extractRecommendations(response)
      }
    } catch (error) {
      console.error('LLM analysis failed:', error)
      // 降级到规则统计
      return this._fallbackAnalysis(findings)
    }
  }

  _inferRiskLevel(text) {
    const lower = text.toLowerCase()
    if (lower.includes('reject') || lower.includes('critical')) return 'HIGH'
    if (lower.includes('needs work') || lower.includes('issues')) return 'MEDIUM'
    return 'LOW'
  }

  _extractRecommendations(text) {
    const lines = text.split('\n')
    const recs = []
    for (const line of lines) {
      if (line.match(/^\s*[-*•] /i) || line.includes('Recommendation') || line.includes('建议')) {
        recs.push(line.trim())
      }
    }
    return recs.length > 0 ? recs : ['See LLM analysis for details']
  }

  _fallbackAnalysis(findings) {
    const severityCount = { CRITICAL: 0, ERROR: 0, WARNING: 0, INFO: 0 }
    for (const f of findings) {
      severityCount[f.severity] = (severityCount[f.severity] || 0) + 1
    }
    const total = findings.length
    const riskLevel = total > 20 ? 'HIGH' : total > 10 ? 'MEDIUM' : 'LOW'
    return {
      summary: `PR 审查完成：发现 ${total} 个问题（CRITICAL: ${severityCount.CRITICAL}, ERROR: ${severityCount.ERROR}, WARNING: ${severityCount.WARNING}, INFO: ${severityCount.INFO})`,
      riskLevel,
      recommendations: total > 0
        ? ['建议修复 CRITICAL 和 ERROR 级别问题', '注意安全问题', '补充测试用例']
        : ['PR 质量良好，可以合并']
    }
  }

  // ============ 辅助方法 ============

  shouldComment(finding, threshold) {
    const severityOrder = { CRITICAL: 4, ERROR: 3, WARNING: 2, INFO: 1 }
    const thresholdOrder = { ERROR: 3, WARNING: 2, INFO: 1 }
    return severityOrder[finding.severity] >= thresholdOrder[threshold]
  }

  buildReviewComment(finding) {
    const emoji = this.getSeverityEmoji(finding.severity)
    const body = `${emoji} **${finding.severity}** - ${finding.message}`

    return {
      body,
      path: finding.file,
      line: finding.line, // 保留原始行号，外层调用方决定是否转 position
    }
  }

  getSeverityEmoji(severity) {
    switch (severity) {
      case 'CRITICAL': return '🔴'
      case 'ERROR': return '🚫'
      case 'WARNING': return '⚠️'
      case 'INFO': return 'ℹ️'
      default: return '📝'
    }
  }

  generateReviewReport(pr, findings, llmSummary) {
    const severityCount = { CRITICAL: 0, ERROR: 0, WARNING: 0, INFO: 0 }
    for (const f of findings) {
      severityCount[f.severity] = (severityCount[f.severity] || 0) + 1
    }

    const total = findings.length
    const blockers = severityCount.CRITICAL + severityCount.ERROR

    return {
      overall: llmSummary?.riskLevel || (blockers > 0 ? 'NEEDS_WORK' : 'CLEAN'),
      totalFindings: total,
      severityCount,
      blockers,
      summary: llmSummary?.summary || `Review completed: ${total} issues found (${blockers} blocking)`,
      recommendations: total > 0
        ? ['Fix CRITICAL/ERROR issues before merging', 'Address WARNING items', 'Consider INFO suggestions']
        : ['PR looks good to merge']
    }
  }

  isCodeFile(filePath) {
    const codeExt = ['.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.go', '.rs', '.c', '.cpp', '.h', '.hpp']
    return codeExt.some(ext => filePath.endsWith(ext))
  }

  isTestFile(filePath) {
    const testPatterns = ['test', 'spec', '__tests__', '.test.', '.spec.']
    return testPatterns.some(p => filePath.includes(p))
  }

  getFileName(filePath) {
    return filePath.split('/').pop()
  }

  findTestFile(sourceFile, testFiles) {
    const name = this.getFileName(sourceFile)
    // 简单的命名约定：xxx.js → xxx.test.js / xxx.spec.js / test/xxx.test.js
    const patterns = [
      `test/${name}.test.js`,
      `test/${name}.spec.js`,
      `${name}.test.js`,
      `${name}.spec.js`,
      `__tests__/${name}.js`
    ]
    return patterns.some(p => testFiles.includes(p))
  }
}