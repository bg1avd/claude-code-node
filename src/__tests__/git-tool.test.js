/**
 * GitTool 单元测试
 */

import { test, describe } from 'node:test'
import assert from 'node:assert'

import { gitTool, createToolDef, GitTool } from '../tools/git-tool.js'
import { parseDiff, splitDiffByFile, getPositionInDiff } from '../git/utils/diff-parser.js'

// ============================================
// Diff Parser Tests
// ============================================
describe('Diff Parser', () => {
  const sampleDiff = `diff --git a/src/index.js b/src/index.js
--- a/src/index.js
+++ b/src/index.js
@@ -1,5 +1,5 @@
 function add(a, b) {
-  return a + b
+  return a + b + 0
 }
 module.exports = { add }
 `

  test('parseDiff should parse hunk headers', () => {
    const hunks = parseDiff(sampleDiff)
    assert.strictEqual(hunks.length, 1)
    assert.strictEqual(hunks[0].oldStart, 1)
    assert.strictEqual(hunks[0].newStart, 1)
  })

  test('splitDiffByFile should return file map with correct file', () => {
    const fileMap = splitDiffByFile(sampleDiff)
    assert.ok(fileMap.has('src/index.js'), 'Missing src/index.js in fileMap')
    const hunks = fileMap.get('src/index.js')
    assert.ok(Array.isArray(hunks))
    assert.ok(hunks.length >= 1, `Expected at least 1 hunk, got ${hunks.length}`)
  })

  test('getPositionInDiff should calculate position for added line', () => {
    const fileMap = splitDiffByFile(sampleDiff)
    const hunks = fileMap.get('src/index.js')

    // The line "  return a + b + 0" is at new line 2
    const position = getPositionInDiff(hunks, 2)
    assert.ok(position !== null, 'Position should not be null for existing line')
    assert.ok(position > 1, `Position ${position} should be > 1`)
  })
})

// ============================================
// GitTool ToolDef Tests
// ============================================
describe('GitTool ToolDef', () => {
  test('should have correct name', () => {
    assert.strictEqual(gitTool.name, 'GitTool')
  })

  test('should have description', () => {
    assert.ok(typeof gitTool.description === 'string' && gitTool.description.length > 10)
  })

  test('should have parameters schema', () => {
    const params = gitTool.parameters
    assert.strictEqual(params.type, 'object')
    assert.ok('action' in params.properties)
    assert.ok('prNumber' in params.properties)
  })

  test('should require action parameter', () => {
    const required = gitTool.parameters.required
    assert.ok(Array.isArray(required))
    assert.ok(required.includes('action'))
  })

  test('should support all expected actions', () => {
    const actions = gitTool.parameters.properties.action.enum
    const expected = [
      'list-prs', 'get-pr', 'review-pr', 'merge-pr',
      'comment', 'approve', 'request-changes',
      'check-mergeable', 'auto-review-all', 'auto-merge-eligible'
    ]
    expected.forEach(a => assert.ok(actions.includes(a), `Missing action: ${a}`))
  })

  test('should have high permission level', () => {
    assert.strictEqual(gitTool.permissionLevel, 'high')
  })

  test('should have handler function', () => {
    assert.ok(typeof gitTool.handler === 'function')
  })
})

// ============================================
// GitTool Factory Tests
// ============================================
describe('GitTool Factory', () => {
  test('createToolDef should return ToolDef instance with handler', () => {
    const toolDef = createToolDef({})
    assert.ok(toolDef instanceof Object)
    assert.ok(typeof toolDef.handler === 'function')
    assert.strictEqual(toolDef.name, 'GitTool')
  })

  test('GitTool class should be instantiable with config', () => {
    const instance = new GitTool({ owner: 'test', repo: 'test' })
    assert.ok(instance instanceof GitTool)
    assert.ok(typeof instance.execute === 'function')
  })
})

// ============================================
// Parameter Validation Tests
// ============================================
describe('Parameter Validation', () => {
  test('comment action should validate prNumber and body before GitHub init', async () => {
    // Pass dummy token to bypass GitHub token check early
    const tool = new GitTool({
      owner: 'test',
      repo: 'test',
      token: 'dummy'
    })

    await assert.rejects(
      tool.execute({ action: 'comment' }),
      /prNumber and body required/
    )
  })

  test('merge-pr action should validate prNumber', async () => {
    const tool = new GitTool({
      owner: 'test',
      repo: 'test',
      token: 'dummy'
    })

    await assert.rejects(
      tool.execute({ action: 'merge-pr' }),
      /prNumber required/
    )
  })
})
