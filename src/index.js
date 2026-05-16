#!/usr/bin/env node

/**
 * Claude Code — Node.js Edition
 * 入口文件
 */

import { main } from './core/cli.js'

main().catch((err) => {
  console.error('Fatal error:', err.message)
  process.exit(1)
})
