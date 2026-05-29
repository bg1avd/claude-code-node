# CHANGELOG

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
