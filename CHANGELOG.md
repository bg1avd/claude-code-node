# CHANGELOG

## v2.8.4 (未发布) — Telegram 帮助信息与命令菜单补全

### ✨ 改进
- **Telegram `/help` 帮助补全** `src/channel/tg-listener.js`：
  - 原帮助只列出 6 个系统命令（ping/status/run/notify/cancel），未展示第二层 cc-node
    能处理的大量 AI 编程命令。
  - 现分两栏展示：**系统命令**（本进程处理）+ **AI 编程命令**（转发给 cc-node），
    共 26 个命令：/model、/models、/window、/budget、/compact、/clear、/session、
    /sessions、/resume、/config、/cost、/channel、/cd、/tools、/stop、/allow 等。
- **Telegram 命令菜单补全**：`setMyCommands` 从 6 个扩充到 22 个，
  Telegram 输入框 `/` 提示现在覆盖全部可用命令。
- **`/help <cmd>` 支持**：带参数时转发给 cc-node，输出该命令的详细用法（DETAILED_HELP）。

### 🧪 测试
- tg-listener-flush 测试通过，无回归。

## v2.8.3 (2026-08-24) — WebFetch 安全抓取管道 + Jina Reader 兜底

### ✨ 新特性
- **WebFetch 安全管道** `src/security/fetch-guard.js`（移植自 safe-jina-fetch 设计）：
  - 协议白名单：仅 http/https，拒绝 file://、ftp://、data: 等。
  - 连接级 SSRF 防护：注入 `lookup` 钩子，TCP 连接时对全部解析地址逐一校验（防 DNS rebinding），
    并对 IP 字面量前置校验（Node 对 IP 不走 DNS lookup，此前存在绕过漏洞，已修复）。
  - 重定向逐跳校验：默认最多 5 跳，每跳重新校验协议 + SSRF（防 302 → 内网绕过）。
  - 响应大小上限 10MB、超时 30s、强制 SSL（证书错误直接拒绝）。
- **敏感数据自动脱敏** `src/security/redact.js`：API Key / Bearer / AWS Key / 私钥 /
  OpenAI `sk-` / Slack token 等命中即替换为 `[REDACTED:类型]` 并告警。
- **Jina Reader 兜底** `src/tools/web-fetch-providers.js`：
  - 直连失败（403/反爬/网络错误/超时）时自动经 `r.jina.ai` 清洗后返回 Markdown。
  - 直连 200 但正文 < 200 字符（疑似 JS 挑战页）也触发兜底（对齐 DESIGN.md §8 增强）。
  - 新增 `extractMode` 参数：`auto`（默认）/ `direct`（强制直连）/ `jina`（强制 Jina）。
  - Jina 凭据三选一：环境变量 `JINA_API_KEY` > 配置 `web.fetch.jinaApiKey` > 匿名。

### 🔧 内部
- `src/tools/web-fetch.js` 全面重构：改用 `safeFetchWithRedirects`（替代裸 fetch）、内容脱敏、
  直连优先 + Jina 兜底。
- `src/core/query-engine.js`：`QueryEngineConfig` 新增 `configStore` 字段，供工具读取配置。
- `src/core/config.js`：新增 `web.fetch.*` 配置项（maxChars/maxBytes/timeoutMs/maxRedirects/jinaApiKey）。
- 新增 `src/__tests__/web-fetch-guard.test.js`（21 个测试：协议/SSRF/重定向/脱敏/Jina）。

## v2.8.2 (2026-08-24) — 上下文窗口自动感知 + 手动指定

### ✨ 新特性
- **上下文窗口感知** `src/core/context-window.js`：自动探测所用模型真实上下文窗口，
  替代原先固定的 100 万/20 万默认预算，让自动压缩真正按"模型窗口"触发。
  - 窗口来源优先级：**手动指定 > API 探测 > 内置模型表 > 安全兜底(64K)**。
  - 内置常见模型上下文表（DeepSeek/OpenAI/Claude/Qwen/GLM/Kimi/本地开源）。
  - 从 `GET /models` 响应中提取窗口（兼容 vLLM `context_length`、Ollama `model_info` 等）。
  - 探测结果**不落盘**，每次启动重新探测；手动指定才持久化（方案 A）。
- **新增 `/window` 命令**：查看/手动指定当前上下文窗口。
  - `/window` — 显示当前窗口 + 来源 + 用量。
  - `/window 128k` / `/window 64k` / `/window 1m` — 手动指定（支持 K/M 后缀，持久化到 config）。
  - `/window auto` — 清除手动指定，回到自动探测；`/window reset` — 清除并立即重探测。
- **`/model` 切换联动**：切换模型后自动重新探测上下文窗口（非手动指定时）。
- **`/budget` 增强**：追加显示当前上下文窗口、来源与 80% 触发阈值。

### 🛡️ 健壮性
- **发送前硬校验兜底** `src/core/query-engine.js`：`_runToolLoop` 每次发送前用
  `estimateMessages` 估算，若超窗先压缩再发，作为"上下文永不溢出"的最终保险。
- **`TokenBudget.setWindow()`**：运行时更新窗口上限，立即反映到 `usagePercent`。

### 🔧 内部
- `src/core/token-budget.js`：新增 `windowSource` 属性与 `setWindow()` 方法。
- `src/core/index.js`：导出 context-window 模块。

## v2.8.1 (2026-08-20) — 全新机械臂机器人头标

### 🎨 界面
- **替换 CLI 启动头标图案** `src/core/headpiece.js`：从简单 "CC" 蓝块 + "NODE" 绿块，
  升级为机械臂机器人图案（CC 机械眼睛蓝渐变 + N O D E 身体 + 黄色工具箱）。
- **修复新图案右边缘不齐**：图案上 5 行（眼睛部分）宽度不足 20 列，在 `renderHeadpiece`
  中新增逐行右填充对齐逻辑，统一补齐到 20 列，保证右边缘对齐。
- **保持接口兼容**：`renderHeadpiece({ colWidth })` → `{ lines, height, width }` 不变，
  CLI 3 栏 banner 用 `robotLines.length` 动态适配行数（8 行 → 10 行自动适配，无需改 cli.js）。

## v2.8.0 (2026-08-20) — Bash 工具跨平台（Windows shell 探测 + PowerShell 安全检测）

### ✨ 新特性
- **Shell 探测抽象层** `src/utils/shell.js`：启动时自动探测当前平台可用的 shell 并缓存。
  - **Linux/macOS** → `/bin/bash`（尊重 `SHELL` 环境变量，支持 zsh）。
  - **Windows** 按优先级探测：`Git Bash` → `WSL bash` → `PowerShell`（pwsh 优先）→ `cmd.exe` 兜底。
  - 提供 `detectShell()`（幂等缓存）、`getShellDescription()`（LLM 可读环境描述）、`isUnixShell()`。
- **Bash 工具描述动态化**：`src/tools/bash.js` 不再固定声明 "bash" 语义，而是根据探测结果
  生成 description，明确告知模型当前是 `Bash / WSL Bash / PowerShell / cmd`，并提示对应语法
  （如 PowerShell 用 `Get-ChildItem` 而非 `ls`），避免 Windows 上写出 Linux 命令导致失败。

### 🛡️ 安全增强
- **PowerShell / cmd 危险命令检测** `src/security/bash-guard.js`（v1.2）：
  - 拦截 `Remove-Item -Recurse -Force`、`rm -recurse -force` 递归强制删除、删除盘符根目录。
  - 拦截 `Invoke-Expression`（含 `iex` 简写）下载并执行、`Format-Volume` / `format c:` 格式化磁盘。
  - 拦截 `Add-LocalGroupMember` 提权、`New-LocalUser` 建户、凭据导出（`ConvertFrom-SecureString`）等。
  - bash 与 PowerShell 两套规则同时生效，无论用户写哪种语法均受保护。

### 🧪 测试
- 新增 `src/__tests__/shell.test.js`：探测层 9 个用例（平台判定、SHELL 尊重、cmd 兜底、幂等缓存）。
- 新增 `src/__tests__/bash-guard-crossplatform.test.js`：PowerShell 拦截 + 放行 + bash 回归共 10 个用例。
- 新增测试全部通过；未改动 git-tool 等既有逻辑。

## v2.7.9 (2026-08-20) — 修复 NpmPublish 发布工具 EISDIR bug

### 🐛 修复
- **NpmPublish `publish` 一键发布偶发 `EISDIR: illegal operation on a directory, read`**：
  工具用正则 `/"filename":"([^"]+)"/` 解析 `npm pack --json` 输出，但 npm 实际输出
  为 `"filename": "xxx.tgz"`（**冒号后有空格**），正则匹配不到 → `join(cwd, '')` 得到
  **目录本身** → 后续 `readFileSync` 触发 EISDIR，发布失败。
  - **改用 JSON 解析**：新增可导出 `parsePackJson()`，用 `JSON.parse` 提取 `filename`，
    彻底消除正则空白依赖；无法解析时明确报错而非生成目录路径。
  - 新增回归测试：`src/__tests__/npm-publish.test.js` 覆盖带空格输出、缺 filename、非法 JSON。
  - 涉及：`src/tools/npm-publish.js`。

## v2.7.8 (2026-08-20) — Telegram 退出 409 竞态加固

### 🐛 修复
- **Telegram `/quit` 退出时偶发 `HTTP 409 Conflict`**：Telegram Bot API 规定同一 bot token
  同一时刻只允许一个 `getUpdates` 长轮询。`/quit` 前 `flushOffset()` 会再发一个 `getUpdates`
  确认消费，若与 `_poll` 循环中仍在挂起的长轮询（timeout:30s）并发，Telegram 会拒绝并返回
  `409 Conflict`（"terminated by other getUpdates request"）。
  - **排他锁机制**：`flushOffset()` 先通过 `AbortController` 取消当前挂起的 `_poll` 长轮询、
    等待其完全让出连接，再独占发起自己的 `getUpdates`（`timeout:0` 立即返回），彻底消除 409 竞态。
  - **`_poll` 让位**：检测到 flush 持有排他锁时不再发起新请求，等待锁释放后继续轮询；
    被 abort 中断视为预期操作，静默处理不告警。
  - **代理路径支持 abort**：`fetchViaSocks5` 增加对 `AbortSignal` 的监听，abort 时销毁 socket，
    使挂起的长轮询立即以 `AbortError` 结束（而非等 60s HTTP 超时）。
  - 涉及：`src/channel/tg-listener.js`、`src/channel/tg-proxy.js`，新增测试
    `src/__tests__/tg-listener-flush.test.js`。

## v2.7.7 (2026-08-19) — AskUserQuestion 改为异步发问（取消 pending 挂起结构）

### 🎯 重构
- **AskUserQuestion 不再"挂起等待"导致会话发呆/卡死**：原先远程提问用 `onAskUser` 返回
  挂起 Promise + 全局 `pendingAskUser` 标志来等待回答，引擎在等待期间 `isRunning=true`
  锁死会话；一旦 pending 状态异常，用户回答会被"引擎忙"拒绝，会话陷入发呆，只能 /stop 恢复。
  - **改为异步发问**：Telegram 通道可用时，发问题到 Telegram 后**立即返回**
    `(已向用户提问，等待回复): <问题>`（不挂起 Promise、不锁死引擎），引擎结束本轮后
    会话完全可用；用户后续回复作为**正常消息**进入引擎，由下一轮把回复当作回答。
  - **取消 pending 结构**：移除 `pendingAskUser` / `cancelAskUser` 全局标志及其在
    `processInputLine` / `/stop` 中的挂起逻辑。
  - **不限制来源**：回答不再用 `source === 'telegram'` 排除，任意来源消息都能被正常处理。
  - CLI 本地模式仍走同步终端交互（`inputCtrl.ask`）。
  - 涉及：`src/core/cli.js`

## v2.7.6 (2026-08-19) — AskUserQuestion 超时吞回答修复

### 🐛 修复
- **AskUserQuestion 60 秒超时吞掉用户回答**：远程提问等待用户回答时，原先设了 60 秒超时，
  超时后 `pendingAskUser` 被清空，用户稍晚的回答到达时不被识别为回答，反而被当成新消息
  撞上"引擎忙"被"⏳ 引擎正在处理其他任务"拒绝——用户明明回答了却"没反应"。
  - **移除超时**：AskUserQuestion 一直等待用户回答，不再自行结束（等待期间用户回复任意文本
    即作为回答接住）。
  - **新增 `/stop` 取消**：用户可用 `/stop` 取消当前提问（resolve 取消标记），避免永久挂起死锁；
    提问提示中明确标注"发 /stop 可取消本次提问"。
  - 涉及：`src/core/cli.js`（`onAskUser` 移除超时、新增 `cancelAskUser`；`processInputLine`
    等待期间接住回答；`/stop` 命令取消提问）

## v2.7.5 (2026-08-19) — "🧠 思考中…"周期性重置

### 🐛 修复
- **"🧠 思考中…"消息无限膨胀，无法判断 AI 是否仍在工作**：此前该消息会被持续
  `editMessage` 原地增长成一个大块，用户看不出它是"还在干活"还是"已完成/卡死"。
  - 新增 **周期性重置**：处理期间每隔 5 秒删掉旧的"🧠 思考中…"消息并重发一条新的，
    让用户每隔几秒看到一次明确的"🧠 思考中…"活动信号；思考内容完整保留。
  - 涉及：`src/core/cli.js`（`tgThinkingFlush` 新增 `TG_THINKING_RESET_MS` 重置逻辑）

## v2.7.4 (2026-08-19) — Telegram typing 心跳

### 🐛 修复
- **Telegram "正在输入"提示在长任务中途消失**：Telegram 的 typing 提示约 5 秒后自动消失，
  而 cc-node 处理耗时较长时只在开始时发送一次 `sendChatAction(typing)`。
  - 新增 **typing 心跳**：整轮处理期间每 4 秒重发一次 typing 动作，让"正在输入"持续显示
    直到全部输出完成（`tgThinkingEnd`）才停止。
  - 涉及 `src/core/cli.js`（主处理路径）与 `src/channel/notify-daemon.js`（cc-notify 路由路径，
    含代理/直连兼容），处理成功或出错时均停止心跳。

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
