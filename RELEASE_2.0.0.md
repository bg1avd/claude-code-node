# 🚀 cc-node v2.0.0 发布报告

**发布日期**: 2026-05-16  
**版本类型**: 🔴 重大安全更新 (Breaking Changes)  
**发布渠道**: 
- GitHub: https://github.com/bg1avd/claude-code-node/releases/tag/v2.0.0
- npm: https://www.npmjs.com/package/@raolin2025/claude-code-node/v/2.0.0

---

## 📦 安装升级

```bash
# 全局安装
npm install -g @raolin2025/claude-code-node@2.0.0

# 或更新现有安装
npm update -g @raolin202025/claude-code-node

# 直接使用 npx
npx @raolin2025/claude-code-node@2.0.0
```

---

## 🔴 高危安全修复

### H6 - HTTP API 认证机制（防止远程命令注入）
**问题**: notify-daemon 的 HTTP API 端点无认证，任何可访问网络的用户都能执行命令  
**修复**: 
- 添加 API Key 认证（`CC_NOTIFY_API_KEY` 环境变量）
- API Key 自动生成并保存到 `.claude-code/notify-api-key.txt`
- 支持 `X-API-Key` header 或 `?api_key=xxx` 查询参数
- `/status` 端点保持免认证（用于健康检查）

**影响**: ⚠️ **Breaking Change** - 所有 HTTP API 调用现在需要携带 API Key

### H5 - ask 模式权限控制（防止安全策略失效）
**问题**: ask 模式直接返回 `allowed: true`，权限系统完全失效  
**修复**: 
- ask 模式现在返回 `allowed: false, requiresConfirmation: true`
- 调用方需要实现确认逻辑（弹出对话框或等待用户确认）

**影响**: ⚠️ **Breaking Change** - 调用方需要处理 `requiresConfirmation` 标志

### H3 - DNS Rebinding 防护（防止 SSRF 绕过）
**问题**: DNS 检查在 fetch 之前进行，攻击者可更改 DNS 记录绕过检查  
**修复**: 
- 在 `query-engine.js` 的 fetch 调用前添加 `checkHostSafety` 检查
- 导出 `safeDnsLookup` 和 `createSafeFetch` 工具函数

**影响**: 增强 SSRF 防护，防止 TOCTOU 竞态攻击

### H4 - IPv6 链路本地完整检测
**问题**: `fe80::/10` 范围检测不完整（只检测了 `fe8` 前缀）  
**修复**: 
- 使用数值比较：`firstByte >= 0xfe80 && firstByte <= 0xfebf`
- 覆盖完整范围 `fe80::` 到 `febf::`

**影响**: 完善 IPv6 SSRF 防护

### H7 - Unix Socket 权限加固
**问题**: Socket 文件权限未显式设置  
**修复**: 
- Socket 文件权限设为 `0o600`（仅所有者可读写）
- 阻止其他用户连接

**影响**: 增强本地安全性

---

## 📋 中低危问题（待修复）

### 🟡 M1 - cli.js tokenBudget ReferenceError
### 🟡 M2 - channel/index.js 未定义的类
### 🟡 M4 - session.js 会话 ID 可预测
### 🟡 M6 - path-guard.js 符号链接未解析
### 🟡 M8 - mcp/client.js 缺少请求超时
### 🟡 M9 - notify-daemon.js PID 文件竞态

---

## ⚠️ 破坏性变更

### 1. HTTP API 需要 API Key 认证

**升级前**:
```bash
curl http://localhost:3456/chat -X POST -d '{"text":"hello"}'
```

**升级后**:
```bash
# 方式 1: X-API-Key header
curl -H "X-API-Key: $(cat .claude-code/notify-api-key.txt)" \
  http://localhost:3456/chat -X POST -d '{"text":"hello"}'

# 方式 2: 查询参数
curl "http://localhost:3456/chat?api_key=$(cat .claude-code/notify-api-key.txt)" \
  -X POST -d '{"text":"hello"}'
```

### 2. ask 模式返回变化

**升级前**:
```js
{ allowed: true, securityCheck: {...} }
```

**升级后**:
```js
{
  allowed: false,
  requiresConfirmation: true,
  reason: 'ask 模式需要用户确认',
  securityCheck: {...}
}
```

**调用方需要**:
1. 检查 `requiresConfirmation` 标志
2. 弹出确认对话框或等待用户确认
3. 用户确认后，再次调用 `check()` 或允许执行

---

## 📊 安全审计

完整的安全审计报告和修复详情，请参阅：
- [SECURITY_FIXES.md](./SECURITY_FIXES.md) - 详细修复报告
- [GitHub Issues](https://github.com/bg1avd/claude-code-node/issues) - 问题追踪

---

## 🙏 致谢

感谢审核团队发现并报告这些安全问题。cc-node 致力于提供安全、可靠的 AI 编程助手体验。

---

## 📞 支持

- 问题反馈：https://github.com/bg1avd/claude-code-node/issues
- 讨论区：https://github.com/bg1avd/claude-code-node/discussions
- 文档：https://github.com/bg1avd/claude-code-node#readme

---

*发布完成时间：2026-05-16*  
*发布者：@raolin2025*  
*版本：2.0.0*
