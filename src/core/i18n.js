/**
 * i18n — Telegram 通道提示信息中英文切换
 *
 * 语言判定规则（用户配置）：
 *   config 顶层 language 键有中文标识（zh / 中文 / chinese / cn）→ 中文
 *   Telegram 消息 from.language_code 以 zh 开头 → 中文
 *   【任意一个有中文 → 中文；都没有 → 英文】
 *
 * 使用方式：
 *   - 启动时 cli.js 调 setConfigLanguage(config.get('language'))，再
 *     setLanguage(detectLanguage({ configLang })) 决定 TG 菜单等启动期文本
 *   - 每条 Telegram 消息入口调 applyMessageLanguage(msg.from.language_code)
 *     （cfg 有中文或该用户 TG 语言是中文 → 中文，否则英文）
 *   - 文本处调 t('key', { param }) 取当前语言文案，支持 {name} 插值；
 *     键缺失先回退英文，仍缺回退 key 本身
 */

const DICT = {
  // ==================== English ====================
  en: {
    // —— TG 菜单（setMyCommands，输入框提示）——
    'tg.menu.ping': '🏓 Check service status',
    'tg.menu.status': '📊 View cc-node status',
    'tg.menu.run': '💻 Run a shell command (e.g. /run ls -la)',
    'tg.menu.notify': '📢 Broadcast a notification',
    'tg.menu.cancel': '🚫 Cancel current operation',
    'tg.menu.help': '❓ Show help',
    'tg.menu.model': '🤖 Switch model (e.g. /model gpt-4o)',
    'tg.menu.models': '📋 List available models',
    'tg.menu.window': '🧠 View/set context window (e.g. /window 128k)',
    'tg.menu.budget': '💰 View token budget usage',
    'tg.menu.compact': '🗜️ Compact context manually',
    'tg.menu.clear': '🧹 Clear the conversation',
    'tg.menu.session': '🗂️ Show session info',
    'tg.menu.sessions': '📂 List all sessions',
    'tg.menu.resume': '↩️ Resume a session (/resume <id>)',
    'tg.menu.config': '⚙️ View config (/config model)',
    'tg.menu.cost': '💲 View API cost',
    'tg.menu.channel': '🔔 Manage notification channels',
    'tg.menu.cd': '📁 Change working directory',
    'tg.menu.tools': '🛠️ List available tools',
    'tg.menu.dream': '💭 View/search dream memory (/dream <topic>, /dream clear)',
    'tg.menu.stop': '⏹️ Stop the current AI task',
    'tg.menu.allow': '🔓 Manage tool permissions',

    // —— /status ——
    'tg.status.title': '📊 *cc-notify status*',
    'tg.status.uptime': '• Uptime: {n}s',
    'tg.status.channels': '• Channels: {n}',
    'tg.status.nodeRunning': '• cc-node: ✅ Running',
    'tg.status.nodeStopped': '• cc-node: ❌ Not running',
    'tg.status.none': 'none',

    // —— /run /notify /cancel ——
    'tg.run.usage': '⚠️ Usage: /run <shell command>\ne.g. /run ls -la\nOr just send a plain message for the AI to handle',
    'tg.run.failed': '❌ Command failed:\n{msg}',
    'tg.notify.usage': '⚠️ Usage: /notify <message>',
    'tg.notify.failed': '❌ Notify failed: {msg}',
    'tg.cancel.done': '🚫 Current operation cancelled',

    // —— 帮助 ——
    'tg.help.intro1': 'Control your AI coding assistant remotely via Telegram.',
    'tg.help.intro2': 'Send a message → the AI handles it; send a / command → runs the action.',
    'tg.help.sysTitle': '*🔧 System commands*',
    'tg.help.sys.ping': '• `/ping` — Check service status',
    'tg.help.sys.status': '• `/status` — Show detailed status',
    'tg.help.sys.run': '• `/run <cmd>` — Execute a shell command directly',
    'tg.help.sys.notify': '• `/notify <msg>` — Broadcast a notification to all channels',
    'tg.help.sys.cancel': '• `/cancel` — Cancel current operation',
    'tg.help.aiTitle': '*🤖 AI coding commands* (forwarded to cc-node)',
    'tg.help.ai.model': '• `/model NAME` — Switch model (e.g. /model gpt-4o)',
    'tg.help.ai.models': '• `/models` — List available models',
    'tg.help.ai.window': '• `/window [N]` — View/set context window (/window 128k, /window auto)',
    'tg.help.ai.budget': '• `/budget` — View token budget usage',
    'tg.help.ai.compact': '• `/compact` — Compact context manually',
    'tg.help.ai.clear': '• `/clear` — Clear the conversation',
    'tg.help.ai.session': '• `/session` — Show session info',
    'tg.help.ai.sessions': '• `/sessions` — List all sessions',
    'tg.help.ai.resume': '• `/resume <id>` — Resume a saved session',
    'tg.help.ai.config': '• `/config KEY` — View config (e.g. /config model)',
    'tg.help.ai.cost': '• `/cost` — View API cost',
    'tg.help.ai.channel': '• `/channel` — Manage notification channels',
    'tg.help.ai.cd': '• `/cd PATH` — Change working directory',
    'tg.help.ai.tools': '• `/tools` — List available tools',
    'tg.help.ai.stop': '• `/stop` — Stop the current AI task',
    'tg.help.ai.allow': '• `/allow` — Manage tool permissions',
    'tg.help.plainTitle': '*Plain messages*',
    'tg.help.plain.text': 'Send text directly → forwarded to the AI',
    'tg.help.plain.image': 'Images supported (sent to the AI as attachments)',
    'tg.help.tip': '💡 Use `/help <command>` for details on any command.',

    // —— cli.js 经 sendTelegram 发出的提示 ——
    'tg.confirm.invalidReply': '⚠️ Please reply y (allow once) / n (deny) / a (allow all this session)',
    'tg.model.switched': '✅ Model switched → {model}',
    'tg.busy': '⏳ Engine is busy with another task, please wait or send /stop to cancel it.',
    'tg.toolConfirm.prompt': '⚠️ Tool permission required\nTool: {tool}\nInput: {snippet}\n\nReply:\ny = allow once\nn = deny\na = allow all this session',
    'tg.askUser.prompt': '❓ {question}\n\nPlease reply with your answer directly.',
    'tg.askUser.waiting': '(Asked the user, waiting for reply): {question}',
    'tg.thinking': '🧠 Thinking…',
  },

  // ==================== 中文 ====================
  zh: {
    'tg.menu.ping': '🏓 检查服务状态',
    'tg.menu.status': '📊 查看 cc-node 状态',
    'tg.menu.run': '💻 执行 shell 命令（如 /run ls -la）',
    'tg.menu.notify': '📢 广播通知消息',
    'tg.menu.cancel': '🚫 取消当前操作',
    'tg.menu.help': '❓ 查看帮助',
    'tg.menu.model': '🤖 切换模型（如 /model gpt-4o）',
    'tg.menu.models': '📋 列出可用模型',
    'tg.menu.window': '🧠 查看/设置上下文窗口（如 /window 128k）',
    'tg.menu.budget': '💰 查看 token 预算使用',
    'tg.menu.compact': '🗜️ 手动压缩上下文',
    'tg.menu.clear': '🧹 清空当前对话',
    'tg.menu.session': '🗂️ 查看会话信息',
    'tg.menu.sessions': '📂 列出所有会话',
    'tg.menu.resume': '↩️ 恢复会话（/resume <id>）',
    'tg.menu.config': '⚙️ 查看配置（/config model）',
    'tg.menu.cost': '💲 查看 API 费用',
    'tg.menu.channel': '🔔 管理通知通道',
    'tg.menu.cd': '📁 切换工作目录',
    'tg.menu.tools': '🛠️ 列出可用工具',
    'tg.menu.dream': '💭 查看/检索梦境记忆（/dream <方向>，/dream clear）',
    'tg.menu.stop': '⏹️ 停止当前 AI 任务',
    'tg.menu.allow': '🔓 工具权限管理',

    'tg.status.title': '📊 *cc-notify 状态*',
    'tg.status.uptime': '• 运行时间: {n}s',
    'tg.status.channels': '• 通道: {n}',
    'tg.status.nodeRunning': '• cc-node: ✅ 运行中',
    'tg.status.nodeStopped': '• cc-node: ❌ 未运行',
    'tg.status.none': '无',

    'tg.run.usage': '⚠️ 用法: /run <shell命令>\n例如: /run ls -la\n或者发普通消息让 AI 处理',
    'tg.run.failed': '❌ 命令执行失败:\n{msg}',
    'tg.notify.usage': '⚠️ 用法: /notify <消息内容>',
    'tg.notify.failed': '❌ 通知失败: {msg}',
    'tg.cancel.done': '🚫 已取消当前操作',

    'tg.help.intro1': '通过 Telegram 远程操控 AI 编程助手。',
    'tg.help.intro2': '直接发消息 → AI 处理；发 / 开头命令 → 执行对应操作。',
    'tg.help.sysTitle': '*🔧 系统命令*',
    'tg.help.sys.ping': '• `/ping` — 检查服务状态',
    'tg.help.sys.status': '• `/status` — 查看详细状态',
    'tg.help.sys.run': '• `/run <cmd>` — 直接执行 shell 命令',
    'tg.help.sys.notify': '• `/notify <msg>` — 广播通知到所有通道',
    'tg.help.sys.cancel': '• `/cancel` — 取消当前操作',
    'tg.help.aiTitle': '*🤖 AI 编程命令*（转发给 cc-node 处理）',
    'tg.help.ai.model': '• `/model NAME` — 切换模型（如 /model gpt-4o）',
    'tg.help.ai.models': '• `/models` — 列出可用模型',
    'tg.help.ai.window': '• `/window [N]` — 查看/设置上下文窗口（/window 128k、/window auto）',
    'tg.help.ai.budget': '• `/budget` — 查看 token 预算使用',
    'tg.help.ai.compact': '• `/compact` — 手动压缩上下文',
    'tg.help.ai.clear': '• `/clear` — 清空当前对话',
    'tg.help.ai.session': '• `/session` — 查看会话信息',
    'tg.help.ai.sessions': '• `/sessions` — 列出所有会话',
    'tg.help.ai.resume': '• `/resume <id>` — 恢复历史会话',
    'tg.help.ai.config': '• `/config KEY` — 查看配置（如 /config model）',
    'tg.help.ai.cost': '• `/cost` — 查看 API 费用',
    'tg.help.ai.channel': '• `/channel` — 管理通知通道',
    'tg.help.ai.cd': '• `/cd PATH` — 切换工作目录',
    'tg.help.ai.tools': '• `/tools` — 列出可用工具',
    'tg.help.ai.stop': '• `/stop` — 停止当前 AI 任务',
    'tg.help.ai.allow': '• `/allow` — 工具权限管理',
    'tg.help.plainTitle': '*普通消息*',
    'tg.help.plain.text': '直接发送文字 → 自动发给 AI 处理',
    'tg.help.plain.image': '支持发送图片（发送给 AI 作为附件）',
    'tg.help.tip': '💡 任意 `/help <命令>` 查看某个命令的详细用法。',

    'tg.confirm.invalidReply': '⚠️ 请回复 y（允许一次）/ n（拒绝）/ a（本会话全部允许）',
    'tg.model.switched': '✅ 已切换模型 → {model}',
    'tg.busy': '⏳ 引擎正在处理其他任务，请稍候或输入 /stop 停止当前任务。',
    'tg.toolConfirm.prompt': '⚠️  需要工具权限\n工具: {tool}\n输入: {snippet}\n\n请回复：\ny = 允许一次\nn = 拒绝\na = 本会话全部允许',
    'tg.askUser.prompt': '❓ {question}\n\n请直接回复你的回答。',
    'tg.askUser.waiting': '（已向用户提问，等待回复）: {question}',
    'tg.thinking': '🧠 思考中…',
  },
}

let currentLang = 'en'
let configLangValue = '' // config 顶层 language 原始值（'' = 未配置，纯自动）

/** config 的 language 键是否带中文标识（zh / 中文 / chinese / cn） */
export function detectLanguage({ configLang = '', tgLanguageCode = '' } = {}) {
  const cfg = String(configLang || '').toLowerCase()
  if (/zh|中文|chinese|cn/.test(cfg)) return 'zh'
  // Telegram from.language_code：'zh-hans-cn' / 'zh_TW' / 'en' / 'ja' …
  const tg = String(tgLanguageCode || '').toLowerCase()
  if (tg.startsWith('zh')) return 'zh'
  return 'en'
}

/** 保存 config 的 language 基准值（启动时调用一次） */
export function setConfigLanguage(lang) {
  configLangValue = String(lang || '')
}

/** 设置当前语言（仅 'zh'/'en' 有效） */
export function setLanguage(lang) {
  if (DICT[lang]) currentLang = lang
}

export function getLanguage() {
  return currentLang
}

/**
 * 每条 Telegram 消息入口调用：按「config 有中文 OR 该用户 TG 语言是中文 → 中文」
 * 重新判定语言。CLI 启动期（无消息）文本用 setLanguage(detectLanguage({configLang}))。
 */
export function applyMessageLanguage(tgLanguageCode) {
  setLanguage(detectLanguage({ configLang: configLangValue, tgLanguageCode }))
}

/**
 * 取当前语言的文案。
 * @param {string} key — 字典键
 * @param {object} [params] — {name} 插值参数
 */
export function t(key, params = {}) {
  let s = DICT[currentLang]?.[key] ?? DICT.en[key] ?? key
  for (const [k, v] of Object.entries(params)) {
    s = s.split(`{${k}}`).join(String(v))
  }
  return s
}
