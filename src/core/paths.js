/**
 * 共享路径常量 — cc-node 和 cc-notify 共用
 */
import { join } from 'path'
import { homedir } from 'os'

export const SOCK_DIR = join(homedir(), '.cc-node')
export const SOCK_PATH = join(SOCK_DIR, 'repl.sock')
export const CC_NODE_PID = join(SOCK_DIR, 'cc-node.pid')
export const CC_NOTIFY_PID = join(SOCK_DIR, 'cc-notify.pid')
export const CC_NOTIFY_LOG = join(SOCK_DIR, 'cc-notify.log')
export const DEFAULT_HTTP_PORT = 3456
