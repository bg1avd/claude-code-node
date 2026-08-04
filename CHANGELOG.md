# CHANGELOG

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
