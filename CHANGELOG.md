# Changelog

All notable changes to this project will be documented in this file.

## [2.2.0] - 2026-05-22

### Added
- **GitTool**: GitHub PR 自动化管理工具
  - PR 查询：`list-prs`, `get-pr`
  - 自动审查：`review-pr`（代码质量、安全、测试、文档检查）
  - 智能合并：`merge-pr`（策略检查、 approvals、 CI、分支保护）
  - 评论与审批：`comment`, `approve`, `request-changes`
  - 批量操作：`auto-review-all`, `auto-merge-eligible`
  - 支持 LLM 智能分析（DeepSeek API）
  - 提供命令行测试脚本 `test-git-tool.mjs`

### Changed
- 工具注册表支持动态加载

### Fixed
- 修复 comment action 的 line → position 计算，支持行级评论
- 修复单元测试套件（14/14 通过）

---

## [1.2.0] - 2026-05-16

### Added
- 通讯通道模块（6 个适配器：Telegram, WeCom, Feishu, Discord, Slack, Webhook）
- cc-notify 守护进程（后台通知服务 + HTTP API + systemd）
- REPL 新增 `/channel` 命令

### Changed
- CLI 重写，支持 Unix socket 通信

---

## [1.1.0] - 2026-05-16

### Added
- 会话持久化增强（恢复 turnCount 和 costHistory）
- `/cost` 和 `/compact` REPL 命令

---

## [1.0.0] - 2026-05-16

### Added
- 初始发布
- 9 个内置工具（Bash, Read, Edit, Write, Glob, Grep, WebFetch, WebSearch, AskUser）
- 4 层安全防护（SSRF, Bash 命令, 路径, 权限）
- MCP 客户端支持
- 流式响应支持
- 成本追踪