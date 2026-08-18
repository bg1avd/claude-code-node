/**
 * 共享路径常量 — cc-node 和 cc-notify 共用
 */
import { join } from 'path'
import { homedir } from 'os'
import { platform } from 'process'

const isWindows = platform === 'win32'

export const SOCK_DIR = join(homedir(), '.cc-node')
// Windows 不支持传统 Unix domain socket（会抛 EACCES），改用 named pipe。
// Unix socket: C:\Users\xxx\.cc-node\repl.sock  → 报错
// named pipe : \\.\pipe\cc-node                 → 正常
export const SOCK_PATH = isWindows ? '\\\\.\\pipe\\cc-node' : join(SOCK_DIR, 'repl.sock')
export const CC_NODE_PID = join(SOCK_DIR, 'cc-node.pid')
export const CC_NOTIFY_PID = join(SOCK_DIR, 'cc-notify.pid')
export const CC_NOTIFY_LOG = join(SOCK_DIR, 'cc-notify.log')
export const DEFAULT_HTTP_PORT = 3456
