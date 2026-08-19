# CHANGELOG

## v2.7.4

## v2.7.4 (2026-08-19) — Telegram typing 心跳

### 🐛 修复
- **Telegram "正在输入"提示在长任务中途消失**：Telegram 的 typing 提示约 5 秒后自动消失，
  而 cc-node 处理耗时较长时只在开始时发送一次 `sendChatAction(typing)`。
  - 新增 **typing 心跳**：整轮处理期间每 4 秒重发一次 typing 动作，让"正在输入"持续显示
    直到全部输出完成（`tgThinkingEnd`）才停止。
  - 涉及 `src/core/cli.js`（主处理路径）与 `src/channel/notify-daemon.js`（cc-notify 路由路径，
    含代理/直连兼容），处理成功或出错时均停止心跳。


## Unreleased — Telegram typing 心跳（持续"正在输入"）

### 🐛 修复
- **Telegram "正在输入"提示在长任务中途消失**：Telegram 的 typing 提示约 5 秒后自动消失，
  而 cc-node 处理耗时较长（多轮思考 / 工具执行 / 读取文件）时，只在开始时发送一次
  `sendChatAction(typing)`，导致用户无法区分"还在工作"与"已完成/卡死"。
  - 新增 **typing 心跳**：整轮处理期间每 4 秒重发一次 typing 动作，让"正在输入"持续显示，
    直到全部输出完成（`tgThinkingEnd`）才停止，等待下一轮时提示消失。
  - 涉及：
    - `src/core/cli.js` — 主处理路径（REPL/socket 转发）新增 `tgStartTypingHeartbeat` / `tgStopTypingHeartbeat`
    - `src/channel/notify-daemon.js` — cc-notify 路由路径新增 `tgStartTypingHeartbeat`（含代理/直连兼容），
      处理成功或出错时均停止心跳

## v2.7.3 (2026-08-19) — NpmPublish squash 分叉修复

### 🐛 修复
- **NpmPublish 工具 git squash 分叉**：去掉 `git reset --soft` 回溯到旧 release 的逻辑
  （会吞掉 HEAD 之后已提交已推送的历史，导致 release 提交父基点错误、与远程分叉、
  push 报 non-fast-forward）。改为直接基于当前 HEAD 提交，天然不会分叉。
  - 涉及：`src/tools/npm-publish.js`

## v2.7.2 (2026-08-19) — AskUserQuestion Telegram 死锁修复

### 🐛 修复
- **AskUserQuestion 工具在 Telegram 通道下卡死引擎的死锁**：
  远程模式下不再走本地 CLI 阻塞（Promise 永不 resolve 导致 isRunning 永久为 true，
  后续消息全被判「引擎忙」丢弃）。新增 `onAskUser` 回调按来源分流：
  Telegram 模式推送问题到远程并 60 秒超时兜底，CLI 模式走本地交互。
  - 涉及：`src/tools/ask-user.js`、`src/core/query-engine.js`、`src/core/cli.js`

## v2.7.1 (2026-08-19) — REPL 多行输入 + Telegram offset 持久化

### 🎯 修复
- **根因**：readline `line` 事件遇到 `\n` 就提交当前行，多行文本被断句，且后续行在引擎忙时被丢弃。
- **新增 `src/core/multiline-input.js`**：keypress + raw mode 管理输入缓冲，
  Enter（`\r`）提交整段、文本换行（`\n`）折行，读取完整输入才处理。
  - 支持退格、可打印字符回显、上/下方向键历史、Ctrl+C
  - 处理 CRLF 提交后的残留 `\n`
  - 非 TTY（管道/重定向）回退到 readline line 事件
- **`src/core/cli.js`**：REPL 主循环改用多行输入器；权限确认 / `/models` / AskUserQuestion
  统一走 `ask()`，避免与 keypress 主循环互相干扰。
- **Telegram / socket 通道**：确认多行文本完整传递，无断句。
- **测试**：新增 `src/__tests__/multiline-input.test.js`（6 项）。

### 🎯 修复（2026-08-19）：终端回显乱跳 / 无回显
- **根因**：`render()` 在单行输入时也执行 `\x1b[1A`（上移一行），且多行时光标定位
  （`\x1b[1A / \x1b[2C / \x1b[1B / \x1b[2A` 组合）错误、行数跟踪未考虑终端自动换行与
  CJK 宽字符，导致屏幕乱跳、输入看似无回显。
- **修复**：重写 `render()` 光标管理：
  - 单行输入：只做 `\r`（回行首）+ `\x1b[J`（清屏）+ 重绘，**绝不上下移动光标**
  - 多行输入：先 `\x1b[nA` 精确上移到输入区首行，再清屏重绘
  - 新增 `renderedRows()` 按终端列数 + CJK 宽字符（全角=2列）精确计算占用屏幕行数
- **验证**：真实 TTY 下单行/多行/折行/退格/长行自动换行均稳定回显，光标不乱跳。

### 📌 行为变化
- CLI 交互输入多行文章时，按 **Enter** 一次性提交整段（含换行），不再被拆成多行/丢失后续行。
- 终端内如需折行，直接按 Enter 前输入内容中的换行（如粘贴）会正确保留。

### 🎯 修复（2026-08-19）：Alt+Enter / Ctrl+Enter 换行不可用 + 回答重复显示双层
- **问题 1（换行不可用）**：部分终端把 Alt+Enter 拆成独立的 `ESC` 事件和 `Enter` 事件，
  或发送 CSI 序列 `\x1b[13~`，旧逻辑无法识别 → Alt+Enter 不折行；
  Ctrl+Enter 在多数终端发送的仍是 `\r`（与普通 Enter 无法区分），按下即被当作提交。
- **修复**（`src/core/multiline-input.js`）：增强多行折行键识别：
  - 新增 **独立 ESC 事件跟踪**：`ESC` 后紧跟 `Enter` 视为 Alt+Enter → 折行（400ms 超时防误判）
  - 新增 **CSI 序列 `\x1b[13~`**（部分终端 Ctrl/Alt+Enter）→ 折行
  - 保留原有 `meta+Enter` / `Ctrl+J`（`\n`）折行
- **问题 2（回答两次 / 双层显示）**：`onDelta` 已实时流式输出回答，结束后又
  `console.log(result.response)` 重复打印一遍 → 屏幕出现同一回答两次。
- **修复**（`src/core/cli.js` + `src/core/query-engine.js`）：新增 `engine.lastStreamed` 标志，
  流式正文已被输出时不再重复打印完整 response（REPL 与 one-shot 模式均生效）。
  仅当 noStream / 流式失败 / 无流式回调时才打印完整 response。
- **测试**：新增「独立 ESC 事件 + Enter 折行」「CSI `\x1b[13~` 折行」两项，共 12 项全过。

### 🎯 修复（多行键入不可用 / Ctrl+Enter 误提交）
- **问题**：真实终端按下 Enter 发送的是 `\r`，而旧逻辑把 `\r` 一律当作「提交」，
  `\n`（文本换行）分支几乎不会触发 → 输入第一行就提交，**根本无法多行输入**；
  用户按 Ctrl+Enter 想继续输入也被当作提交，AI 立即回复。
- **修复**（`src/core/multiline-input.js`）：重写 Enter 处理，支持多行折行键：
  - Enter（`\r`）→ 仍为提交（单行输入体验不变）
  - **Ctrl+Enter** / **Alt+Enter（Esc+Enter）** / **Ctrl+J** → 折行（多行输入）
  - ⚠️ 注意：多数终端 Ctrl+Enter 发送的仍是 `\r`，无法与 Enter 区分；
    **跨终端可靠的多行换行键是 Alt+Enter（Esc+Enter）**。
- **测试**：新增「Alt+Enter 折行 + Enter 提交」与「普通 Enter 仍提交」两项，共 10 项全过。

### 🎯 修复（2026-08-19）：Telegram /quit 死循环 — 持久化 getUpdates offset
- **问题**：`lastUpdateId` 仅存内存、重启即归 0。`/quit` 用 `process.exit(0)` 强杀进程，
  来不及提交下一次 `getUpdates(offset)` 确认消费 → `/quit` 消息永远留在 Telegram 服务端缓冲，
  下次启动从 offset 0 重放并再次退出，形成 **cc-node 永远无法启动的死循环**。
- **修复**（`src/channel/tg-listener.js`）：
  - `_poll()` 中 offset 前进时**立即持久化**到 `~/.cc-node/tg-offset.json`，构造时恢复。
    即使进程被强杀，重启也从正确位置继续，不再重放旧消息。
  - 新增 `flushOffset()`：主动用 `getUpdates(offset=lastUpdateId+1)` 确认已消费的更新，
    在 `/quit` / `/exit` 命令处理里 `process.exit` 前调用，作为双重保险。

## v2.6.1 (2026-08-04) — 发布到 npm (Staged Publishing 实盘)

> 目标版本 `2.6.0` 因被自身 staged 占位 + 强制 2FA 封锁无法发布；改用 **v2.6.1** 直接发布成功。

### 🚀 发布记录
- **版本号**：`@raolin2025/claude-code-node@2.6.1`
- **发布方式**：bypass-2FA GAT token + 手动构造请求（`npm-auth-type: bearer`），绕过 npm CLI 默认 otplease 强制 2FA
- **registry 现状**：`latest: 2.6.1`，dist-tag 正确，tarball 60 个文件，已正确签名
- **bin**：`cc-node`、`cc-notify`

### 📌 关键经验（后续发布参考）
1. **Staged Publishing 认证规则**（`npm help stage` 官方确认）：
   | Token 类型 | `npm stage publish` | `npm publish` |
   |---|---|---|
   | GAT with bypass | 可 stage | **可 publish**（若包允许） |
   | GAT without bypass | 可 stage | 需 2FA OTP |
   | Session token | 可 stage | 需 2FA OTP |
2. **approve / reject staged 包均强制 2FA OTP**，任何 token（含 bypass）都无法绕过；`--otp` 是命令行唯一途径。
3. **npm CLI 默认可能走错认证方式**，导致无 bypass 的 session token 在 publish 时被 403 / 要求 OTP。
4. **手动构造请求 + `npm-auth-type: bearer` + bypass token 可成功直接 publish**，无需 OTP。
5. **版本号被 staged 占位后无法 publish 同版本**（409 "Cannot publish over previously staged version"）；需清掉 staged（OTP）或用新版本号。

### ⚠️ 遗留事项
- 暂存区仍残留 **staged `@raolin2025/claude-code-node@2.6.0`**（stageId `3d0a9431-62bc-43d0-9ae1-86461aa9d968`）与 **`@raolin2025/nedb-promise@0.0.1-probe`**（stageId `4f134a41-c44a-4808-8324-bdb0c5480747`），因 reject/approve 均需 OTP，待后续清理。

## (待发布) — 自建本地 LLM 服务支持
> commit `1560dfc`

### 🎯 新增
- **支持自建本地 LLM 服务（Ollama / llama.cpp / vLLM 等），无需 apiKey**
  - 自动识别 apiBase 指向本地/内网（localhost、回环、RFC1918 私有段、`.local` 域名）的服务
  - 此类服务缺省 apiKey 也能正常调用，不再强制 `Bearer undefined` 头
  - REPL `/models` 命令在自建服务下跳过 API key 检查，正常拉取列表
  - 未指定模型时启动自动拉取服务端 `/models` 列表交互选择
- 新增 `src/utils/llm-server.js`（isLocalLlmServer / isLocalHostname / buildAuthHeaders）
- 新增 `src/__tests__/llm-server.test.js` 单元测试（35 项）

### 📓 文档
- README 更新 Ollama / 自建服务使用说明
- 新增 `KNOWN_ISSUES.md`（技术债务记录，含 REPL 多行输入取舍、git-tool 集成测试失败）

### ⚠️ 已知事项
- REPL 多行输入（Ctrl+Enter 折行）与 readline 回显稳定性存在取舍，
  详见 `KNOWN_ISSUES.md` #1。

## v2.6.0 (2025-07-23) — 多行输入支持

### 🎯 新增
- **多行输入支持** — 终端交互时支持折行输入
  - Enter → 提交输入
  - Ctrl+Enter → 折行（换行继续输入）
- **自定义输入处理器** — 使用 keypress 事件完全重写 REPL 输入处理
  - TTY 模式：keypress 事件驱动，支持 Ctrl+Enter 折行、退格、Ctrl+C
  - 非 TTY 模式：回退到 readline line 事件，兼容管道/重定向输入

### 🔧 修复
- 修复无法在终端中折行的问题
- 修复管道模式下输入处理的兼容性

## v2.4.0 (2026-05-29) — 远程编程增强版

### 🎯 新增
- **QQ Bot 远端编程** — 通过 QQ Bot API v2 实现远程操控
  - 认证: appId + clientSecret → access_token (自动续期)
  - 发送: `/v2/users/{openid}/messages` (C2C) 和 `/v2/groups/{group_openid}/messages` (群)
  - 接收: WebSocket (wss://api.sgroup.qq.com/websocket/) 长连接
  - 零外部依赖，纯 fetch + WebSocket
  - 参考: qqbot-standalone (独立、零依赖的 QQ Bot 模块)
- **qqbot-listener.js** — 完整的独立 QQ Bot 模块（发送 + WebSocket 监听）
- **QQBotChannel 适配器** — 基于 QQ Bot API v2 的通用发送适配器

### 🔧 增强
- **增强版 Telegram 监听器 (tg-listener.js)**
  - 速率限制（30 msg/s 单聊, 20 msg/min 群组）
  - MarkdownV2 安全编码，HTML 降级策略
  - 自动分段发送（4000 字符限制）
  - 回调查询（内联键盘按钮）支持
  - 文件/图片接收
  - 多轮对话状态管理
  - 自动设置 Bot 命令菜单
- **增强版通道管理器 (channel/index.js)**
  - QQBotChannel 适配器
  - TelegramChannel 增强：HTTPS 安全编码、分片发送
  - 更好的速率限制和错误处理
- **增强版 notify-daemon.js**
  - 统一消息处理器（Telegram + QQ Bot + HTTP API 共享同一路由）
  - 长回复自动分段
  - 处理中提示（typing 动作）
  - API Key 自动持久化
- **更新 cc-notify.service** — 添加 QQ Bot 环境变量模板

### 📓 文档
- README 添加 QQ Bot 远端编程章节
- README 更新 cc-notify v2.0 特性和命令
- README 更新 HTTP API 文档（添加 API Key 认证示例）

### 文件清单
```
src/channel/
├── index.js          ← 更新: +QQBotChannel, +TelegramChannel增强
├── tg-listener.js    ← 新增: 增强版 Telegram 长轮询监听器
├── qqbot-listener.js ← 新增: QQ Bot WebSocket 监听器
└── notify-daemon.js  ← 更新: 集成双通道监听器
cc-notify.service     ← 更新: +QQ Bot 环境变量
```

## v2.3.6 (2026-05-23)
- v2.3.0 GitTool 完整合并（PR 审查、合并策略、LLM 辅助）
- 版本号保持同步
