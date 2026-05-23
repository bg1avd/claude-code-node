/**
 * 测试 comment 方法的 line → position 转换
 */

import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { parseDiff, splitDiffByFile, getPositionInDiff, getHunksForFileRaw } from './src/git/utils/diff-parser.js'

const sampleDiff = `diff --git a/src/index.js b/src/index.js
--- a/src/index.js
+++ b/src/index.js
@@ -1,5 +1,5 @@
 function hello() {
-  console.log('Hello')
+  console.log('Hello World')
   return 1
 }
`

// Test diff parser
console.log('Testing diff-parser...\n')

const fileMap = splitDiffByFile(sampleDiff)
console.log('File map keys:', Array.from(fileMap.keys()))

const hunks = getHunksForFileRaw(fileMap, 'src/index.js')
console.log('Hunks for src/index.js:', hunks.length)

// Test position calculation
// The line "  console.log('Hello World')" is at new line 2 in the file
// But we need to count from the diff start to get the position
const position = getPositionInDiff(hunks, 2)
console.log('Position for line 2 in src/index.js:', position)

if (position === null || position <= 0) {
  console.error('❌ Position calculation failed')
  process.exit(1)
}

console.log('\n✅ All diff-parser tests passed')
console.log('Position value looks reasonable (expected > 1):', position)
