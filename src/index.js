#!/usr/bin/env node

/**
 * Claude Code — Node.js Edition
 * 入口文件
 *
 * 子命令：
 *   cc-node            启动内核 + 终端视图（默认）
 *   cc-node attach     把当前终端接到**已经运行的**那个内核上（同一份上下文）
 */

const sub = process.argv[2]

if (sub === 'attach') {
  // 动态导入：attach 是纯客户端，不加载内核（不读配置、不建引擎、不碰 MCP）
  const { runAttach } = await import('./core/attach-client.js')
  await runAttach(process.argv.slice(3))
} else {
  const { main } = await import('./core/cli.js')
  await main().catch((err) => {
    console.error('Fatal error:', err.message)
    process.exit(1)
  })
}
