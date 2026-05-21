# 🚀 cc-node v2.1.0 发布报告

**发布日期**: 2026-05-21  
**版本类型**: 🔵 功能更新 + Bug 修复  
**发布渠道**: 
- GitHub: https://github.com/bg1avd/claude-code-node/releases/tag/v2.1.0
- npm: https://www.npmjs.com/package/@raolin2025/claude-code-node/v/2.1.0

---

## 📦 安装升级

```bash
npm update -g @raolin2025/claude-code-node
# 或
npx @raolin2025/claude-code-node@2.1.0
```

---

## ✨ 新功能

### 1. 工具并行执行
LLM 同时调用多个工具时（如读取多个文件、并发搜索），现在并行执行，显著减少等待时间。

### 2. ask 模式确认交互
ask 权限模式现在正常工作：工具调用时会弹出确认提示，用户可选择允许或拒绝。

```bash
cc-node -p ask
# 工具调用时显示：
# ⚠️  Allow tool "Bash"?
#    Input: {"command": "ls -la"}
#    (y/N) y
```

### 3. /allow 命令
新增 `/allow [tool]` 命令，可在会话中临时允许某个工具：
```
> /allow Bash
✅ Tool "Bash" allowed for this session
```

### 4. 请求重试加入 jitter 退避
API 重试从线性等待改为指数退避 + 随机 jitter，防止多客户端同时重试造成惊群效应。

### 5. 流式费用追踪
流式响应的 token 费用现在正确记录到 CostTracker，不再遗漏。

---

## 🐛 Bug 修复

### 1. ask 模式形同虚设（H5 修复不完整）
**问题**: v2.0.0 的 H5 修复把 ask 模式变成了 deny 模式——所有工具调用都被拒绝，用户无法确认  
**修复**: 
- 新增 `onConfirmTool` 回调机制，readline 提示用户确认
- 用户确认后工具正常执行，拒绝后返回错误信息

### 2. 一次性模式 + ask 权限 = 所有工具被拒绝
**问题**: 一次性运行 (`cc-node "ls"`) 时没设 onConfirmTool 回调，ask 模式下所有工具被拒  
**修复**: 一次性模式下自动批准工具调用（用户已明确表达意图）

### 3. 并行执行结果缺少 toolName
**问题**: 重构为并行后，被拒绝的工具结果缺少 toolName 字段  
**修复**: 错误结果也正确设置 toolName

### 4. 会话恢复丢失 tool 消息
**问题**: `--resume` 恢复会话时只恢复了 user/assistant 消息，tool 消息和 tool_calls 元数据丢失，导致 API 上下文断裂  
**修复**: 完整恢复所有角色，含 tool_calls 和 tool_call_id

### 5. 流式响应费用未记录
**问题**: 流式响应结束时返回了 usage 数据但从未调用 costTracker.recordUsage()  
**修复**: 流式和非流式路径现在都正确记录费用

### 6. 死代码 _parseResponse
**问题**: 类方法 `_parseResponse` 定义但从未被调用，且内引用不存在的 `result.usage`  
**修复**: 删除死代码

### 7. 引擎状态未持久化
**问题**: REPL 模式下每次对话后不保存引擎状态（turnCount、费用历史），`--resume` 后无法恢复  
**修复**: REPL 和 socket 路径都正确持久化引擎状态

### 8. _formatContent(null) 返回 "null" 字符串
**问题**: `_formatContent(null)` 走到 `String(null)` 返回 `"null"` 而不是空字符串  
**修复**: 增加 null/undefined 守卫，返回空字符串

### 9. Google Search 调试遗留
**问题**: `web-search.js` 中使用 `key=***` 占位符（看起来像遗留调试代码），实际变量正确传递  
**修复**: 更新 User-Agent 从硬编码 `1.0` 到动态版本号 `2.1.0`

---

## 🔧 架构改进

### 两阶段工具执行
```
阶段1（串行）: 安全检查 → ask 确认 → 工具查找
阶段2（并行）: Promise.all 并行执行互不依赖的工具
```

### Jitter 退避算法
```js
retryDelay(baseMs, attempt) {
  const ms = baseMs * Math.pow(2, attempt - 1)
  const jitter = ms * (0.5 + Math.random() * 0.5) // 50%-100%
  return Math.round(jitter)
}
```

### 完整消息恢复
`--resume` 现在恢复所有消息角色和元数据，保证 API 上下文连续性。

---

## 📊 变更统计

```
7 文件修改 · 148 行新增 · 78 行删除
src/core/query-engine.js    — 核心引擎重构（并行 + jitter）
src/core/cli.js             — ask 模式 + /allow + 会话持久化
src/tools/web-fetch.js      — 动态 User-Agent
src/core/session.js         — 安全修复（预存）
src/security/path-guard.js  — 安全修复（预存）
src/mcp/client.js           — 超时保护（预存）
src/channel/notify-daemon.js— API 认证（预存）
```

---

## 📞 支持

- 问题反馈：https://github.com/bg1avd/claude-code-node/issues
- 文档：https://github.com/bg1avd/claude-code-node#readme

---

*发布完成时间：2026-05-21*  
*版本：2.1.0*
