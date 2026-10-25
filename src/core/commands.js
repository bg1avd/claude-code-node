/**
 * commands.js — 命令的机器可读元信息
 *
 * 两个用途：
 * 1. **协议下发**（接入反馈 P2-1）：socket 的 `command_list` 返回这份清单，
 *    接入方（手机 App / Web）不用再去读源码里的 HELP_TEXT 抄一份，内核加
 *    命令也不必让所有客户端跟着发版。
 * 2. **忙时白名单**（接入反馈 P1）：内核正在跑回合时，哪些命令仍可执行。
 *
 * 为什么单独成文件：`cli.js` 是两千多行的主循环，命令元数据埋在里面的代价是
 * 想测一下清单就得把整个主循环拖进来。这里零依赖，测试可以直接 import。
 *
 * 与 `cli.js` 里 `switch (cmd)` 的一致性由 `src/__tests__/command-list.test.js`
 * 扫描源码校验：漏一条、多一条都会红。
 */

/**
 * @typedef {object} CommandSpec
 * @property {string}   cmd       形如 "/status"
 * @property {string}   desc      一句话说明（中文，UI 可直接显示）
 * @property {boolean} [needsArg] 是否必须带参数
 * @property {string[]} [options] 固定枚举值（UI 可做选择器）；空 = 自由输入
 * @property {boolean} [danger]   有破坏性/不可逆（清上下文、切项目、退出、放宽权限）
 * @property {boolean} [busySafe] 内核跑回合时仍允许执行
 * @property {boolean} [secret]   参数是敏感值（UI 应遮挡输入/回显）
 * @property {string[]} [aliases] 等价命令（如 /quit = /exit），UI 可一并展示
 */

/** @type {CommandSpec[]} */
export const COMMAND_SPEC = [
  // —— 只读 / 状态类：忙时也安全 ——
  { cmd: '/help', desc: '显示帮助（带参数看某条命令的详细说明）', needsArg: false, busySafe: true },
  { cmd: '/status', desc: '汇总当前全部运行状态', needsArg: false, busySafe: true },
  { cmd: '/session', desc: '当前会话信息', needsArg: false, busySafe: true },
  { cmd: '/sessions', desc: '列出所有已存会话', needsArg: false, busySafe: true },
  { cmd: '/cost', desc: 'API 费用与 token 统计', needsArg: false, busySafe: true },
  { cmd: '/api', desc: '当前 API 配置（base/key 脱敏/model）', needsArg: false, busySafe: true },
  { cmd: '/tools', desc: '列出可用工具', needsArg: false, busySafe: true },
  { cmd: '/config', desc: '查看配置（不带参数看全部）', needsArg: false, busySafe: true },
  { cmd: '/budget', desc: '查看 token 预算', needsArg: false, busySafe: true },
  { cmd: '/window', desc: '查看/设置上下文窗口', needsArg: false, options: ['auto', 'reset'], busySafe: true },
  { cmd: '/models', desc: '拉取当前接口的可选模型列表', needsArg: false, busySafe: true },
  { cmd: '/keys', desc: '按键绑定与终端能力（watch 进入诊断）', needsArg: false, options: ['watch'], busySafe: true },
  { cmd: '/stop', desc: '停止当前正在运行的 AI 工作', needsArg: false, busySafe: true },

  // —— 写操作：忙时拒绝（会改动上下文/配置，破坏正在跑的回合）——
  { cmd: '/model', desc: '切换模型（立即生效）', needsArg: true },
  { cmd: '/api-base', desc: '切换 API Base（仅本次会话）', needsArg: true },
  { cmd: '/api-key', desc: '切换 API Key（仅本次会话）', needsArg: true, secret: true },
  { cmd: '/thinking', desc: '思考深度/模式', needsArg: false, options: ['auto', 'off', 'on'] },
  { cmd: '/max-turns', desc: '工具循环轮数上限（0 = 不限）', needsArg: false },
  { cmd: '/resume', desc: '加载某个已存会话（可用 /sessions 里的序号）', needsArg: true },
  { cmd: '/dream', desc: '梦境（跨会话长期记忆）', needsArg: false, options: ['save', 'clear'] },
  { cmd: '/channel', desc: '通知渠道管理', needsArg: true, options: ['list', 'send', 'test'] },
  { cmd: '/schedule', desc: '定时任务管理', needsArg: false },
  { cmd: '/tick', desc: '立即执行一次调度器检查', needsArg: false },
  { cmd: '/compact', desc: '手动压缩上下文', needsArg: false, danger: true },
  { cmd: '/clear', desc: '清空当前对话（新建会话）', needsArg: false, danger: true },
  { cmd: '/cd', desc: '切换项目（软重启）', needsArg: true, danger: true },
  { cmd: '/allow', desc: '管理工具权限（放宽需谨慎）', needsArg: false, danger: true },
  { cmd: '/exit', desc: '退出 cc-node', needsArg: false, danger: true, aliases: ['/quit'] },
]

/** 生成协议用的清单（把默认值补齐，客户端不必判 undefined） */
export function buildCommandList() {
  return COMMAND_SPEC.map(s => ({
    cmd: s.cmd,
    desc: s.desc,
    needsArg: !!s.needsArg,
    options: Array.isArray(s.options) ? s.options : [],
    danger: !!s.danger,
    busySafe: !!s.busySafe,
    secret: !!s.secret,
    aliases: Array.isArray(s.aliases) ? s.aliases : [],
  }))
}

/**
 * 内核正在跑回合时允许执行的命令名（不含前导 `/`）。
 *
 * 白名单而不是黑名单：加一条新命令时默认"忙时拒绝"。忘记归类的代价只是
 * 这条命令要等一会儿，而不是把正在跑的回合搞坏。
 */
export const BUSY_SAFE_COMMANDS = new Set(
  COMMAND_SPEC.filter(s => s.busySafe).map(s => s.cmd.slice(1))
)
