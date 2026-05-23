# GitTool 设计文档

## 📋 需求分析

### 用户需求
1. "先实现gittool吧，这样可以自动处理pr了"
2. "我这个项目本身也要处理好pr"

### 核心功能定位
GitTool 是专门用于 **GitHub PR 自动化管理** 的工具，包括：
- PR 查看、审查、合并、关闭
- 自动代码质量检查
- CI/CD 状态监控
- 与 claude-code-node 现有的安全架构集成

---

## 🎯 功能规格

### 1. PR 查询与浏览

```javascript
GitTool.listPRs(options)
// options: { state, head, base, author, labels, limit }

GitTool.getPR(prNumber)
// 返回：PR 详情（标题、描述、diff、修改文件、状态、comment 数）
```

**用例**：
- 列出所有打开状态的 PR
- 查看特定分支的 PR
- 筛选特定作者的 PR
- 批量获取 PR 详情

### 2. PR 自动审查（AI-Powered Review）

```javascript
GitTool.reviewPR(prNumber, options)
// options: {
//   checks: ['code-quality', 'security', 'tests', 'docs'],
//   autoComment: true,
//   requestChanges: false
// }
```

**审查维度**：
- ✅ **代码质量**：风格、复杂度、重复代码
- ✅ **安全性**：SQL 注入、XSS、硬编码密钥、路径遍历
- ✅ **测试覆盖**：新代码是否有测试、现有测试是否通过
- ✅ **文档更新**：README、API 文档是否同步
- ✅ **性能影响**：数据库 N+1、内存泄漏风险
- ✅ **向后兼容**：是否破坏现有 API/接口

**输出**：
- 结构化审查报告
- 行级评论（在 diff 上标注问题）
- 总结性 Review Comment

### 3. PR 合并（智能决策）

```javascript
GitTool.mergePR(prNumber, options)
// options: {
//   method: 'merge' | 'squash' | 'rebase',
//   requireApproval: true,
//   requireCI: true,
//   requireReview: true,
//   autoMerge: false  // 满足条件自动合并
// }
```

**合并前检查**（可配置规则）：
- [ ] PR 状态：必须是 `open`
- [ ] Approvals：至少 N 个 approve（默认 1）
- [ ] CI 状态：所有检查通过
- [ ] Review 要求：无 `changes_requested`
- [ ] 分支保护：符合分支保护规则（如 required status checks）
- [ ] 文档完整：描述清晰、关联 issue
- [ ] 向后兼容：不破坏现有功能

**合并方式**：
- `merge`：标准合并（保留所有 commit，创建 merge commit）
- `squash`：压缩合并（所有 commit 合并为一个）
- `rebase`：变基合并（线性历史）

### 4. PR 评论与沟通

```javascript
GitTool.commentOnPR(prNumber, body, position?)  // 评论
GitTool.approvePR(prNumber, body?)              // Approve
GitTool.requestChanges(prNumber, body?)         // Request changes
GitTool.dismissReview(prNumber, reviewId)       // 撤回 review
```

### 5. 自动化工作流

```javascript
// 批量处理：审查所有待处理的 PR
GitTool.autoReviewAll({ label: 'needs-review' })

// 智能合并：满足条件自动合并
GitTool.autoMergeEligible({ label: 'auto-merge' })

// 定期检查：运行 cron 任务
// 每天 10:00：autoReviewAll
// 每小时：检查 CI 状态，通知失败的 PR
```

---

## 🔐 安全与权限

### 权限级别（基于原版 permission system）
1. `read`：查看 PR（默认 always-allow）
2. `comment`：发表评论（需要 confirm）
3. `approve`：批准 PR（高风险，需明确确认）
4. `merge`：合并 PR（极高风险，需 owner approval）
5. `delete-branch`：删除分支（中等风险）

### 安全检查
- 阻止删除受保护分支（如 main、master、develop）
- 合并前强制检查分支保护规则
- 审计日志记录所有操作

---

## 🏗️ 架构设计

### 文件结构
```
src/
├── tools/
│   ├── git-tool.js      ← 主入口
│   └── index.js         ← 注册
├── git/
│   ├── github-api.js    ← GitHub REST API 封装
│   ├── pr-query.js      ← PR 查询构建器
│   ├── pr-reviewer.js   ← AI 审查引擎
│   ├── pr-merge-policy.js  // 合并策略
│   ├── rules/
│   │   ├── code-quality.js
│   │   ├── security.js
│   │   ├── tests.js
│   │   └── docs.js
│   └── utils/
│       ├── diff-parser.js
│       └── comment-thread.js
└── mcp/  // 可选：通过 MCP 暴露给外部
```

### 依赖
- **HTTP**：原生 fetch (Node.js ≥ 18) 或 https 模块
- **Diff**：原生实现或轻量库（避免 heavy 依赖）
- **Git**：不需要本地 git，全部通过 GitHub API

### API 封装（GitHub REST API v3）
- Octokit 风格的封装，但自实现（避免依赖）
- Token 管理：`GITHUB_TOKEN` 环境变量
- 错误处理：4xx → 用户错误，5xx → 重试机制
- 速率限制：检测 X-RateLimit-* headers，自动 backoff

---

## 📦 工具注册

```javascript
// src/tools/git-tool.js
export default {
  name: 'GitTool',
  description: 'GitHub PR 自动化管理工具，支持查看、审查、合并 PR',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [
          'list-prs', 'get-pr', 'review-pr',
          'merge-pr', 'comment', 'approve',
          'request-changes', 'auto-review-all', 'auto-merge-eligible'
        ]
      },
      // ... 各 action 的参数
    },
    required: ['action']
  },
  async execute(params) {
    // 实现
  }
}
```

---

## 🧪 测试计划

### Unit Tests
- ✅ GitHub API 封装正确生成 URL + headers
- ✅ 权限检查：禁止删除保护分支
- ✅ 合并策略： Approvals/CI 检查逻辑

### Integration Tests（需要真实 GitHub repo）
- ✅ 列出 PR → 验证正确返回
- ✅ 审查 PR → 在测试 repo 创建 review comment
- ✅ 合并 PR → 在测试 repo 执行合并

### Mock Server
使用 `nock` 或自建 mock API：
- 模拟 GitHub API 响应
- 模拟速率限制
- 模拟错误场景（403, 404, 422）

---

## 🚀 发布计划

### v1.0.0 核心功能
- [x] PR 查询（list, get）
- [x] 基础审查（代码质量、安全扫描）
- [x] 安全合并（规则检查 + 批准）
- [x] 评论与 approve
- [x] 权限系统集成
- [ ] 文档（README 用法示例）
- [ ] 单元测试（覆盖率 > 80%）

### v1.1.0 自动化
- [ ] autoReviewAll（批量审查）
- [ ] autoMergeEligible（智能合并）
- [ ] 标签自动管理（添加 `needs-review`, `approved`）
- [ ] 定期检查提醒（cron 集成）

### v1.2.0 高级审查
- [ ] 集成 MCP 工具：调用 linter (ESLint)、formatter (Prettier)
- [ ] 性能分析：检测 N+1 查询、内存泄漏
- [ ] 向后兼容性检查：API 变更影响分析

---

## 📝 详细实现清单

### Day 1-2: GitHub API 封装
- [ ] `src/git/github-api.js`
  - 构造函数：`new GitHubAPI({ token, owner, repo, baseUrl })`
  - 方法：`getPRs(filter)`, `getPR(number)`, `getDiff(number)`
  - 方法：`createComment(number, body, position?)`
  - 方法：`approvePR(number)`, `requestChanges(number)`, `mergePR(number, options)`
  - 分页处理：Link header 解析
  - 错误处理：throw `GitHubError` 包含 status, message

### Day 3-4: Diff 解析与评论定位
- [ ] `src/git/utils/diff-parser.js`
  - 输入：diff 字符串（unified format）
  - 输出：`[{ oldLine, newLine, content, hunkHeader }]`
  - 方法：`getLinePosition(prNumber, file, line)` → position (在 diff 中的位置)
- [ ] `src/git/utils/comment-thread.js`
  - 构建 review comment payload（in-reply-to + position）

### Day 5-6: PR 审查引擎
- [ ] `src/git/pr-reviewer.js`
  - `constructor(repoContext)`：加载项目规则（.claude-code/pr-rules.json）
  - `reviewPR(prNumber, options)`：主入口
    - 调用 GitHub API 获取 diff
    - 调用各规则检查器（并行）
    - 调用 LLM 评估总体质量（可选）
    - 生成报告 + 行级评论
  - `_runCodeQualityCheck(diff)`
  - `_runSecurityCheck(diff)`
  - `_runTestsCheck(diff)` → 检查测试文件命名、覆盖率变化
  - `_runDocsCheck(diff)` → 检查文档更新

### Day 7: 合并策略
- [ ] `src/git/pr-merge-policy.js`
  - `canMerge(prNumber)`：执行所有检查
    - approvals >= required
    - CI status checks: success
    - no changes requested
    - branch protection rules satisfied
  - `merge(prNumber, method)`：执行合并

### Day 8: 工具注册
- [ ] `src/tools/git-tool.js`：实现 execute 方法，路由到各个功能
- [ ] `src/tools/index.js`：register('git-tool', GitTool)
- [ ] 更新 `tools.config.json`：设置权限级别（`merge` → 'high')

### Day 9: 测试
- [ ] 单元测试：github-api, diff-parser, pr-merge-policy
- [ ] Mock API 测试：模拟 GitHub webhook 回调
- [ ] 集成测试：在测试 repo 跑通完整流程

### Day 10: 文档与发布
- [ ] README 使用示例（5 个典型场景）
- [ ] 配置文件示例（`.claude-code/pr-rules.json`）
- [ ] CHANGELOG
- [ ] 发布 v1.0.0 到 npm + GitHub

---

## 💡 示例配置

### `.claude-code/pr-rules.json`
```json
{
  "requiredApprovals": 1,
  "requireCI": true,
  "autoMergeLabels": ["auto-merge", "ready-to-merge"],
  "securityChecks": ["hardcoded-secrets", "sql-injection", "path-traversal"],
  "codeQualityChecks": ["complexity", "duplication", "todo-comments"],
  "reviewRules": {
    "ignoreWarnings": true,
    "requireTests": true,
    "requireDocs": false,
    "maxFiles": 50
  }
}
```

---

## 🔗 与 OpenClaw 集成

考虑到 claude-code-node 主要用于 OpenClaw ecosystem：
- **GitTool 也可以作为 OpenClaw Skill**：复制到 `skills/git-tool/`
- **通知集成**：使用 cc-node 的 channel 系统发送 PR 通知
- **Cron 集成**：通过 OpenClaw Heartbeat 定期运行 `autoReviewAll`

---

## 🎯 下一步行动

1. ✅ 设计文档完成（本文件）
2. 实现 GitHub API 封装
3. 实现 Diff 解析
4. 实现审查引擎
5. 实现合并策略
6. 集成到工具系统
7. 测试 + 文档
8. 发布

---

*设计时间：2026-05-22*
*负责人：Claude Code Node Team*