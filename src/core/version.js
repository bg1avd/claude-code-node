/**
 * 版本号（单一来源）
 *
 * 从 package.json 读取，供 CLI banner、`--version`、Telegram `/status` 等复用。
 * 单独成模块是为了让 **运行中的进程也能被问到版本** —— 之前 Telegram `/status`
 * 完全不汇报版本，用户根本不知道自己连的是哪个版本（v3.6.14 补上）。
 */
import { readFileSync } from 'fs'

let VERSION = '0.0.0'
try {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
  VERSION = pkg.version || VERSION
} catch { /* 读取失败不阻断 */ }

export const CC_NODE_VERSION = VERSION

export default CC_NODE_VERSION
