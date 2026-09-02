# CHANGELOG

## v2.8.27

## [2.8.27] - 2026-09-02

### ✨ 新增
- **多模态图片支持**：Telegram / 外部通道发送的图片会自动下载并转为 base64 data URL，传给模型 API 实现图像理解
- 纯图片消息（无文字）自动补充默认提示「请描述这张图片的内容」，避免空输入
- 图片下载走服务端中转，不泄露 Telegram bot token，安全且通用

### 🔧 细节
- 支持 photo 类型及 png/jpg/gif/webp/bmp 等常见图片格式
- 下载超时 15s，单张失败自动跳过，不阻断主流程
- stdio 服务端同步支持 images 参数透传


## v2.8.26

## v2.8.26 — small-model 模式根治本地服务 500（清空 LLM 缓存 + 合并 system）

### 🐛 修复
- **根治"工作几轮后报 500"**（llama.cpp `System message must be at the beginning`）：
  真正根因是 LLM 端（llama.cpp 等自建服务）KV/prompt 缓存无限叠加被塞满，即便 cc-node
  compact 后 context 变小，LLM 端旧的大 context 仍占着缓存导致新请求被拒。
  `--small-model` 模式现在每轮自动清空 LLM 缓存：
  - 每个用户任务开始主动发轻量"清缓存"请求（best-effort，失败静默忽略）；
  - 每个 LLM 请求体带 `cache_prompt:false`，让本地服务本轮不复用/不累积 prompt 缓存，
    每次都全新计算——等价于"每轮清空缓存"，保证 context 始终正确送入。
  - 仅对自建本地服务（llama.cpp/Ollama/vLLM）生效，云端厂商忽略该字段。
- **`_buildRequest` 在 small-model 模式把所有 system 消息合并为单条**放在开头，
  彻底消除折叠后 `system=2` 触发 Qwen Jinja 报错。

### 🧪 测试
- `small-model.test.js` 新增 4 个测试，全量单测通过（git-tool.integration 4 项为既有失败）。


## v2.8.26 — small-model 模式根治本地服务 500（清空 LLM 缓存 + 合并 system）

### 🐛 修复
- **根治"工作几轮后报 500"**（error.log 中 llama.cpp `System message must be at the beginning`）：
  真正根因不是 cc-node 端 context 到极限，而是 **LLM 端（llama.cpp 等自建服务）KV/prompt
  缓存无限叠加被塞满**——即便 compact 后 cc-node 发送的 context 变小，LLM 端旧的大 context
  仍占着缓存导致新请求被拒。`--small-model` 模式现在每轮自动清空 LLM 缓存：
  - **每个用户任务开始时**主动向本地服务发一次轻量"清缓存"请求（best-effort，失败静默忽略）；
  - **每个 LLM 请求体带 `cache_prompt:false`**，让本地服务本轮不复用、不累积上一次的
    prompt 缓存，每次都全新计算——等价于"每轮清空缓存"，保证 context 始终正确送入。
  - 仅对自建本地服务（llama.cpp/Ollama/vLLM 等）生效，云端厂商忽略该字段。
- **`_buildRequest` 在 small-model 模式下把所有 system 消息合并为单条**放在开头，
  彻底消除折叠后 `system=2` 触发 Qwen Jinja `System message must be at the beginning` 的报错。

### 🧪 测试
- `small-model.test.js` 新增 4 个测试：small-model 合并 system 为单条、非 small-model 保持原行为、
  small-model 本地服务请求带 `cache_prompt:false`、非 small-model 不带 `cache_prompt`。
- 全量单测通过（git-tool.integration 4 项为既有失败，需 GitHub 环境，与本改动无关）。

## v2.8.25

### ✨ 新功能
- 新增运行时 API 来源切换命令（仅本次会话生效，重启回启动值）：
  - `/api-base <url>` — 运行时切换 API 地址并自动重探 context 窗口
  - `/api-key <key>` — 运行时切换 API Key（掩码显示）
  - `/api` — 查看当前 API Base / Key / Model
- 用途：无需重启即可在本地 llama.cpp / Ollama 与云端 DeepSeek 等来源间切换。
- 实现：复用 `/model` 模式，改 `engine.config.apiBase/apiKey`（`_callLLM` 实时读取），
  局部变量 `apiBase/apiKey` 改 `let` 以保证窗口重探测拿到新值。


## v2.8.25 — 新增运行时 API 来源切换命令 `/api-base`/`/api-key`

### ✨ 新功能
- **运行时切换 LLM 来源**（仅本次会话生效，不持久化，重启回启动值）：
  - `/api-base <url>` — 切换 API 地址，立即生效；切换后自动重新探测 context 窗口，
    并提示选择新来源的模型
  - `/api-key <key>` — 切换 API Key（masked 显示），立即生效
  - `/api` — 查看当前 API Base / Key / Model
- 用途：无需重启即可在本地 llama.cpp / Ollama 与 DeepSeek 等云端来源间切换。
- 复用现有机制实现：`engine.config.apiBase/apiKey` 为可变属性，`_callLLM` 每次请求
  实时读取，故改字段即时生效；复制 `/model` 命令模式。

### 🧪 测试
- 全量单测通过（git-tool.integration 4 项为既有失败，需 GitHub 环境，与本改动无关）。

## v2.8.24

## v2.8.24 — 回归朴素模式：移除小模型干预机制，恢复 v2.8.11 可用状态

### 🐛 重大调整
- **根因**：v2.8.13 之后我加的 `--small-model` 一整套"辅助机制"（意图引导注入、
  工具精简、多步计划、框架代执行、cwd 注入、收尾引导）是**帮倒忙**的。
  实测（v2.8.11 完成整个项目）：小模型在**朴素模式**下才能正常工作——
  16 个工具全上、无任何注入干预。我加的机制越多，模型越乱（不调用工具、瞎编内容）。
- **回归**：`_runToolLoop` 恢复为 v2.8.11 朴素结构——不做任何干预：
  - 移除：意图引导注入、多步计划注入、收尾引导注入
  - 移除：工具精简（16 个工具全上，不再按意图砍工具）
  - 移除：框架代执行（`_frameworkExecute`）
  - 移除：system prompt 的 cwd / 工具铁律注入（用回基础 prompt）
- **保留的合理改进**（不干预模型行为）：
  - `max_tokens` 根据窗口动态计算（纯利好）
  - 折叠保留当前任务链 + system 前置（上下文管理，不干预模型）

### 🧪 测试
- 全量 169 个单元测试通过，无回归。


## v2.8.24 (未发布) — 回归朴素模式：移除小模型干预机制，恢复 v2.8.11 可用状态

### 🐛 重大调整
- **根因**：v2.8.13 之后我加的 `--small-model` 一整套"辅助机制"（意图引导注入、
  工具精简、多步计划、框架代执行、cwd 注入、收尾引导）是**帮倒忙**的。
  实测（v2.8.11 完成整个项目）：小模型在**朴素模式**下才能正常工作——
  16 个工具全上、无任何注入干预。我加的机制越多，模型越乱（不调用工具、瞎编内容）。
- **回归**：`_runToolLoop` 恢复为 v2.8.11 朴素结构——不做任何干预：
  - 移除：意图引导注入、多步计划注入、收尾引导注入
  - 移除：工具精简（16 个工具全上，不再按意图砍工具）
  - 移除：框架代执行（`_frameworkExecute`）
  - 移除：system prompt 的 cwd / 工具铁律注入（用回基础 prompt）
- **保留的合理改进**（不干预模型行为）：
  - `max_tokens` 根据窗口动态计算（纯利好）
  - 折叠保留当前任务链 + system 前置（上下文管理，不干预模型）

### 🧪 测试
- 全量 169 个单元测试通过，无回归。

## v2.8.23 — 修复工具过度精简导致小模型不调用工具

### 🐛 修复
- **根因**：v2.8.13 引入的"按意图精简工具"（把 16 个工具精简成 2-6 个）是**帮倒忙**。
  v2.8.12 之前全 16 个工具模型能正常调用；精简后模型反而不调用工具、只会瞎编
  （如"阅读文件"却直接编一份假文档）。
- **修复**（`selectRelevantTools`）：小模型工具调用不能过度精简，改为：
  1. **至少保留 6 个核心工具**（Bash/Read/Edit/Write/Glob/Grep）——每次必给；
  2. **有明确意图时**：核心 6 个 + 意图额外工具（联网→WebSearch/WebFetch 等），
     只追加、不减少核心；
  3. **无明确意图/找不到适配时**：干脆全部调用（16 个全给），让模型自己挑。
- 原则：**工具给全，让模型自己挑；而不是替它精简，导致它无工具可用而瞎编。**

### 🧪 测试
- `small-model.test.js` 更新工具精简测试（至少 6 个核心 + 无意图全给），共 33 个。
- 全量 169 个单元测试通过，无回归。


## v2.8.23 (未发布) — 修复工具过度精简导致小模型不调用工具

### 🐛 修复
- **根因**：v2.8.13 引入的"按意图精简工具"（把 16 个工具精简成 2-6 个）是**帮倒忙**。
  v2.8.12 之前全 16 个工具模型能正常调用；精简后模型反而不调用工具、只会瞎编
  （如"阅读文件"却直接编一份假文档）。
- **修复**（`selectRelevantTools`）：小模型工具调用不能过度精简，改为：
  1. **至少保留 6 个核心工具**（Bash/Read/Edit/Write/Glob/Grep）——每次必给；
  2. **有明确意图时**：核心 6 个 + 意图额外工具（联网→WebSearch/WebFetch 等），
     只追加、不减少核心；
  3. **无明确意图/找不到适配时**：干脆全部调用（16 个全给），让模型自己挑。
- 原则：**工具给全，让模型自己挑；而不是替它精简，导致它无工具可用而瞎编。**

### 🧪 测试
- `small-model.test.js` 更新工具精简测试（至少 6 个核心 + 无意图全给），共 33 个。
- 全量 169 个单元测试通过，无回归。

## v2.8.22 — 修复框架代执行死循环 + 路径提取吞中文 bug

### 🐛 修复
- **修复框架代执行死循环**：模型持续敷衍时（回"研究一下"/"Solved by..."），原逻辑
  框架代执行后 `continue` 让模型总结，模型仍敷衍 → 又代执行 → 无限循环，消息无限膨胀。
  现在**框架代执行后直接把真实结果作为最终答案返回**，不再让模型总结（模型已证明只会
  敷衍），彻底消除死循环。
- **修复路径提取吞中文 bug**：`阅读D:\...\COMPLETION_REPORT.md,对项目有个全盘了解`
  之前会被贪婪匹配成 `...COMPLETION_REPORT.md,对项目有个全盘了解`（把指令说明吞进
  路径，Read 打开不存在的文件）。现在路径匹配**只允许合法路径字符，遇逗号/分号/中文
  立即停止**，在文件扩展名处截断。

### 🧪 测试
- `small-model.test.js` 新增"路径后带中文说明正确截断"回归测试，共 32 个。
- 全量 168 个单元测试通过，无回归。


## v2.8.22 (未发布) — 修复框架代执行死循环 + 路径提取吞中文 bug

### 🐛 修复
- **修复框架代执行死循环**：模型持续敷衍时（回"研究一下"/"Solved by..."），原逻辑
  框架代执行后 `continue` 让模型总结，模型仍敷衍 → 又代执行 → 无限循环，消息无限膨胀。
  现在**框架代执行后直接把真实结果作为最终答案返回**，不再让模型总结（模型已证明只会
  敷衍），彻底消除死循环。
- **修复路径提取吞中文 bug**：`阅读D:\...\COMPLETION_REPORT.md,对项目有个全盘了解`
  之前会被贪婪匹配成 `...COMPLETION_REPORT.md,对项目有个全盘了解`（把指令说明吞进
  路径，Read 打开不存在的文件）。现在路径匹配**只允许合法路径字符，遇逗号/分号/中文
  立即停止**，在文件扩展名处截断。

### 🧪 测试
- `small-model.test.js` 新增"路径后带中文说明正确截断"回归测试，共 32 个。
- 全量 168 个单元测试通过，无回归。

## v2.8.21 — 修复"工作到一半变傻"：折叠时保留当前任务链

### 🐛 修复
- **根因定位**：v2.8.17"工作到一半变傻、模型不回答"的根因是 `foldHistoryByCount`
  （消息条数折叠）在**任务进行到一半时**触发，把"当前正在进行的任务链"折叠成
  模糊摘要、只留最近 4 轮。模型丢失了"当前任务状态"（在做什么、做到哪、
  下一步干什么），于是停止调用工具、变傻。
- **修复**：折叠策略改为**优先只折叠"最近 user 指令之前"的已完成的早期历史**，
  当前正在进行的任务（最近 user 指令及其后的工具调用链）**完整保留、永不折叠**。
  若当前任务本身消息过多，则按**完整 user 轮次**为单位折叠，绝不从
  tool/assistant 消息中间截断工具链。
- 模型始终能看到"当前任务：实现X → 已做Y → 下一步Z"的完整状态，不会中途失忆。

### 🧪 测试
- `compact-window.test.js` 新增 2 个回归测试（保留当前任务链 + 不截断工具链），共 25 个。
- 全量 167 个单元测试通过，无回归。


## v2.8.21 (未发布) — 修复"工作到一半变傻"：折叠时保留当前任务链

### 🐛 修复
- **根因定位**：v2.8.17"工作到一半变傻、模型不回答"的根因是 `foldHistoryByCount`
  （消息条数折叠）在**任务进行到一半时**触发，把"当前正在进行的任务链"折叠成
  模糊摘要、只留最近 4 轮。模型丢失了"当前任务状态"（在做什么、做到哪、
  下一步干什么），于是停止调用工具、变傻。
- **修复**：折叠策略改为**优先只折叠"最近 user 指令之前"的已完成的早期历史**，
  当前正在进行的任务（最近 user 指令及其后的工具调用链）**完整保留、永不折叠**。
  若当前任务本身消息过多，则按**完整 user 轮次**为单位折叠，绝不从
  tool/assistant 消息中间截断工具链。
- 模型始终能看到"当前任务：实现X → 已做Y → 下一步Z"的完整状态，不会中途失忆。

### 🧪 测试
- `compact-window.test.js` 新增 2 个回归测试（保留当前任务链 + 不截断工具链），共 25 个。
- 全量 167 个单元测试通过，无回归。

## v2.8.20 — 框架代执行：模型敷衍调不起工具时，框架直接替它执行

### 🚀 新特性
- **框架代执行**（`extractFrameworkAction` + `_frameworkExecute`）：
  当 27B Q3 量化模型多次敷衍（重试后仍只回"研究一下"等空话、不调工具）时，
  框架**绕过模型**，根据用户指令直接推断并执行最合理的工具，把真实结果注入
  对话，再让模型基于结果总结。
  - 当前支持"读取文件"：识别"阅读/查看 + 文件路径"→ 框架直接执行 `Read(path)`。
  - 让"一句话调用小模型工作"真正成立——不再依赖小模型"会调工具"这个它不具备的能力。

### 🧪 测试
- `small-model.test.js` 新增 3 个框架代执行测试（绝对路径/相对路径/无动作），共 31 个。
- 全量 165 个单元测试通过，无回归。


## v2.8.20 (未发布) — 框架代执行：模型敷衍调不起工具时，框架直接替它执行

### 🚀 新特性
- **框架代执行**（`extractFrameworkAction` + `_frameworkExecute`）：
  当 27B Q3 量化模型多次敷衍（重试后仍只回"研究一下"等空话、不调工具）时，
  框架**绕过模型**，根据用户指令直接推断并执行最合理的工具，把真实结果注入
  对话，再让模型基于结果总结。
  - 当前支持"读取文件"：识别"阅读/查看 + 文件路径"→ 框架直接执行 `Read(path)`。
  - 让"一句话调用小模型工作"真正成立——不再依赖小模型"会调工具"这个它不具备的能力。

### 🧪 测试
- `small-model.test.js` 新增 3 个框架代执行测试（绝对路径/相对路径/无动作），共 31 个。
- 全量 165 个单元测试通过，无回归。

## v2.8.19 — 修复小模型无限工具循环

### 🐛 修复
- **修复工具循环上限判断 bug**：原逻辑用 `state.turnCount`（用户请求数）判断是否达到
  "最大回合数"，导致单个用户请求内的工具循环 100 轮也不会触发停止（无限循环）。
  现在小模型模式下工具循环有**独立上限**（默认 8 轮）。
- **小模型收尾引导**：接近工具循环上限时注入"停止调用新工具、总结收尾"引导，
  让模型主动停，而不是无休止地"写一个又写一个"。
- **强制收尾兜底**：达到工具循环上限仍未收尾时，强制输出总结提示，不再无限循环。
- 新增 `--small-model-max-turns N` / `config.smallModelMaxTurns`（默认 8）可调上限。

### 🧪 测试
- 全量 162 个单元测试通过，无回归。


## v2.8.19 (未发布) — 修复小模型无限工具循环

### 🐛 修复
- **修复工具循环上限判断 bug**：原逻辑用 `state.turnCount`（用户请求数）判断是否达到
  "最大回合数"，导致单个用户请求内的工具循环 100 轮也不会触发停止（无限循环）。
  现在小模型模式下工具循环有**独立上限**（默认 8 轮）。
- **小模型收尾引导**：接近工具循环上限时注入"停止调用新工具、总结收尾"引导，
  让模型主动停，而不是无休止地"写一个又写一个"。
- **强制收尾兜底**：达到工具循环上限仍未收尾时，强制输出总结提示，不再无限循环。
- 新增 `--small-model-max-turns N` / `config.smallModelMaxTurns`（默认 8）可调上限。

### 🧪 测试
- 全量 162 个单元测试通过，无回归。

## v2.8.18 — 折叠/裁剪时隔离所有 system 消息，彻底消除中间 system

### 🐛 修复
- **`foldHistoryByCount` 和 `trimToWindow` 改为收集【所有】 system 消息**，不再只取第一条。
  此前多次折叠/裁剪后，旧的摘要 system 会被当成普通消息塞进 body，最终被挤到
  对话中间，触发 llama.cpp "System message must be at the beginning" (500)。
  现在无论折叠多少次，所有 system 都隔离到开头。
- 配合 v2.8.17 的 `_buildRequest` 前置修复，形成双重保障：
  - 状态层：折叠/裁剪不再把 system 塞进 body；
  - 请求层：即便状态异常，`_buildRequest` 也把所有 system 前置。

### 🧪 测试
- `compact-window.test.js` 新增 2 个回归测试（折叠/裁剪后 system 全在开头），共 23 个。
- 全量 162 个单元测试通过，无回归。


## v2.8.18 (未发布) — 折叠/裁剪时隔离所有 system 消息，彻底消除中间 system

### 🐛 修复
- **`foldHistoryByCount` 和 `trimToWindow` 改为收集【所有】 system 消息**，不再只取第一条。
  此前多次折叠/裁剪后，旧的摘要 system 会被当成普通消息塞进 body，最终被挤到
  对话中间，触发 llama.cpp "System message must be at the beginning" (500)。
  现在无论折叠多少次，所有 system 都隔离到开头。
- 配合 v2.8.17 的 `_buildRequest` 前置修复，形成双重保障：
  - 状态层：折叠/裁剪不再把 system 塞进 body；
  - 请求层：即便状态异常，`_buildRequest` 也把所有 system 前置。

### 🧪 测试
- `compact-window.test.js` 新增 2 个回归测试（折叠/裁剪后 system 全在开头），共 23 个。
- 全量 162 个单元测试通过，无回归。

## v2.8.17 — 根治 "System message must be at the beginning" 500 错误

### 🐛 修复
- **`_buildRequest` 把所有 system 消息统一前置到请求开头**，不再原样透传。
  折叠/摘要/会话恢复可能让 system 摘要消息出现在 state.messages 中间，
  原逻辑会把它们原样 push 进请求，导致 llama.cpp/Jinja 报
  "System message must be at the beginning"（500）。
  现在无论 state 里 system 位置如何，请求里 system 永远只在开头，彻底根治。

### 🧪 测试
- `small-model.test.js` 新增"_buildRequest 把中间 system 前置"回归测试，共 28 个。
- 全量 160 个单元测试通过，无回归。


## v2.8.17 (未发布) — 根治 "System message must be at the beginning" 500 错误

### 🐛 修复
- **`_buildRequest` 把所有 system 消息统一前置到请求开头**，不再原样透传。
  折叠/摘要/会话恢复可能让 system 摘要消息出现在 state.messages 中间，
  原逻辑会把它们原样 push 进请求，导致 llama.cpp/Jinja 报
  "System message must be at the beginning"（500）。
  现在无论 state 里 system 位置如何，请求里 system 永远只在开头，彻底根治。

### 🧪 测试
- `small-model.test.js` 新增"_buildRequest 把中间 system 前置"回归测试，共 28 个。
- 全量 160 个单元测试通过，无回归。

## v2.8.16 — 单次输出上限 max_tokens 根据上下文窗口动态计算

### 🚀 新特性
- **`max_tokens` 不再写死 4096**，改为根据上下文窗口（`/window` 设置）动态计算：
  `max_tokens = max(4096, 窗口 × 1/16)`，且不超过窗口一半（保证输入有空间、绝不超窗）。
  - 131072 窗口 → 8192；65536 → 4096；200000 → 12500。
  - 窗口越大单次输出空间越大，避免小模型 Write 大文件时被截断。
- 新增 `--max-output-tokens N` / `config.maxOutputTokens`（作为输出下限）覆盖；
  `outputRatio` 可调输出占窗口比例（默认 1/16）。

### 🧪 测试
- `small-model.test.js` 新增 3 个 max_tokens 动态计算测试，共 27 个。
- 全量 159 个单元测试通过，无回归。

### 📝 文档
- README：新增"单次输出上限动态计算"章节、`--max-output-tokens` 参数。


## v2.8.16 (未发布) — 单次输出上限 max_tokens 根据上下文窗口动态计算

### 🚀 新特性
- **`max_tokens` 不再写死 4096**，改为根据上下文窗口（`/window` 设置）动态计算：
  `max_tokens = max(4096, 窗口 × 1/16)`，且不超过窗口一半（保证输入有空间、绝不超窗）。
  - 131072 窗口 → 8192；65536 → 4096；200000 → 12500。
  - 窗口越大单次输出空间越大，避免小模型 Write 大文件时被截断。
- 新增 `--max-output-tokens N` / `config.maxOutputTokens`（作为输出下限）覆盖；
  `outputRatio` 可调输出占窗口比例（默认 1/16）。

### 🧪 测试
- `small-model.test.js` 新增 3 个 max_tokens 动态计算测试，共 27 个。
- 全量 159 个单元测试通过，无回归。

### 📝 文档
- README：新增"单次输出上限动态计算"章节、`--max-output-tokens` 参数。

## v2.8.15 — 小模型多步任务框架深度拆解 + 注入工作目录

### 🚀 新特性
- **多步任务框架深度拆解**（`buildMultiStepPlan`，层 B 深化）：
  识别"按计划实现/开发"类复杂任务，生成**分步执行计划**注入 system，
  强制模型按"① Read 计划 → ② Glob/Grep 看现状 → ③ Write/Edit 实现 → ④ Bash 验证"
  逐步推进。解决小模型（27B Q3）撑不住多步任务、不读计划就瞎写的问题。
- **system prompt 注入当前工作目录**：明确告诉模型 `cwd` 在哪个项目目录，
  避免它瞎猜绝对路径（如 `/home/user/repos/...`）导致 File not found。
- **新增"实现/开发"意图规则**：`按计划实现第一阶段` 等任务正确识别并精简到
  相关工具（Bash/Read/Edit/Write/Glob/Grep）。

### 🧪 测试
- `small-model.test.js` 新增 6 个测试（cwd 注入 1 + 多步计划 5），共 24 个。
- 全量 156 个单元测试通过，无回归。


## v2.8.15 (未发布) — 小模型多步任务框架深度拆解 + 注入工作目录

### 🚀 新特性
- **多步任务框架深度拆解**（`buildMultiStepPlan`，层 B 深化）：
  识别"按计划实现/开发"类复杂任务，生成**分步执行计划**注入 system，
  强制模型按"① Read 计划 → ② Glob/Grep 看现状 → ③ Write/Edit 实现 → ④ Bash 验证"
  逐步推进。解决小模型（27B Q3）撑不住多步任务、不读计划就瞎写的问题。
- **system prompt 注入当前工作目录**：明确告诉模型 `cwd` 在哪个项目目录，
  避免它瞎猜绝对路径（如 `/home/user/repos/...`）导致 File not found。
- **新增"实现/开发"意图规则**：`按计划实现第一阶段` 等任务正确识别并精简到
  相关工具（Bash/Read/Edit/Write/Glob/Grep）。

### 🧪 测试
- `small-model.test.js` 新增 6 个测试（cwd 注入 1 + 多步计划 5），共 24 个。
- 全量 156 个单元测试通过，无回归。

## v2.8.14 — 修复小模型意图引导的两处 bug

### 🐛 修复
- **修复 llama.cpp 500 错误 "System message must be at the beginning"**：
  小模型模式的意图引导此前作为独立 `system` 消息插入对话中间，但 llama.cpp/Jinja
  严格要求 system 消息必须位于对话开头。现在改为**把引导合并进首条 system 消息**
  （保持 system 全在开头），不再产生非法的中间 system 消息。
- **修复意图误判：阅读文档被当成写文档**：
  新增"读/阅读/查看/打开"意图规则（优先于写规则），"阅读DEVELOPMENT_PLAN.md文档"
  现在正确映射到 `Read`，而非 `Write`。工具精简也随之正确暴露 Read/Glob。

### 🧪 测试
- `small-model.test.js` 新增"阅读文档是读取任务"测试，共 18 个。
- 全量 150 个单元测试通过，无回归。


## v2.8.14 (未发布) — 修复小模型意图引导的两处 bug

### 🐛 修复
- **修复 llama.cpp 500 错误 "System message must be at the beginning"**：
  小模型模式的意图引导此前作为独立 `system` 消息插入对话中间，但 llama.cpp/Jinja
  严格要求 system 消息必须位于对话开头。现在改为**把引导合并进首条 system 消息**
  （保持 system 全在开头），不再产生非法的中间 system 消息。
- **修复意图误判：阅读文档被当成写文档**：
  新增"读/阅读/查看/打开"意图规则（优先于写规则），"阅读DEVELOPMENT_PLAN.md文档"
  现在正确映射到 `Read`，而非 `Write`。工具精简也随之正确暴露 Read/Glob。

### 🧪 测试
- `small-model.test.js` 新增"阅读文档是读取任务"测试，共 18 个。
- 全量 150 个单元测试通过，无回归。

## v2.8.13 — 小模型适配模式：让弱模型也能可靠完成编程任务

### 🚀 新特性
- **新增小模型适配模式**（`--small-model` / `config.smallModel=true`，默认关闭）：
  专为本地小模型（如 27B Q3 量化）设计，把智能从"模型端"转移到"框架端"，
  解决小模型"只回空话不调工具、多轮往返丢目标"的痛点。
  - **层 A · 兜底**：
    - **强化 system prompt**：追加"工具使用铁律"，明确告诉模型必须调用工具完成任务；
    - **敷衍输出检测 + 重试**：检测到 `Solved by...` / 空话 / 太短 / 无工具调用时，
      追加强引导重试一次（`isFillerResponse` + `RETRY_GUIDANCE`）；
    - **工具数量精简**：按用户指令意图只暴露核心工具子集（`selectRelevantTools`），
      降低小模型的选择负担。
  - **层 B · 替代**：
    - **意图识别 + 引导**：用规则把"写文档/找文件/跑命令/改代码/联网搜索"映射到
      明确工具（`detectIntent` + `buildIntentGuidance`），首轮注入任务引导，
      不完全依赖模型自主规划。

### 🧪 测试
- 新增 `small-model.test.js`，17 个测试（敷衍检测 4 + 意图识别 6 + 引导 2 + 工具精简 3 +
  system prompt 1 + 开关 1）。
- 全量 149 个单元测试通过，无回归。

### 📝 文档
- README：新增"小模型适配模式"章节、`--small-model` 参数、`smallModel` 配置项。


## v2.8.13 (未发布) — 小模型适配模式：让弱模型也能可靠完成编程任务

### 🚀 新特性
- **新增小模型适配模式**（`--small-model` / `config.smallModel=true`，默认关闭）：
  专为本地小模型（如 27B Q3 量化）设计，把智能从"模型端"转移到"框架端"，
  解决小模型"只回空话不调工具、多轮往返丢目标"的痛点。
  - **层 A · 兜底**：
    - **强化 system prompt**：追加"工具使用铁律"，明确告诉模型必须调用工具完成任务；
    - **敷衍输出检测 + 重试**：检测到 `Solved by...` / 空话 / 太短 / 无工具调用时，
      追加强引导重试一次（`isFillerResponse` + `RETRY_GUIDANCE`）；
    - **工具数量精简**：按用户指令意图只暴露核心工具子集（`selectRelevantTools`），
      降低小模型的选择负担。
  - **层 B · 替代**：
    - **意图识别 + 引导**：用规则把"写文档/找文件/跑命令/改代码/联网搜索"映射到
      明确工具（`detectIntent` + `buildIntentGuidance`），首轮注入任务引导，
      不完全依赖模型自主规划。

### 🧪 测试
- 新增 `small-model.test.js`，17 个测试（敷衍检测 4 + 意图识别 6 + 引导 2 + 工具精简 3 +
  system prompt 1 + 开关 1）。
- 全量单元测试通过，无回归。

### 📝 文档
- README：新增"小模型适配模式"章节、`--small-model` 参数、`smallModel` 配置项。

## v2.8.12 — 消息条数感知的历史折叠 + 常驻工具结果截断

### 🚀 新特性
- **新增按消息条数折叠历史 `foldHistoryByCount`**（`src/core/compact.js`）：
  当上下文消息条数超过 `maxMessages`（默认 80，可用 `--max-messages N` 或
  `config.maxMessages` 开启）时，把早期历史折叠成一条摘要（保留 Main goal /
  工具使用 / 关键结果），仅保留最近 4 轮完整对话。
  解决 **token 未超窗（如 37%）但 200+ 条消息让本地 27B 小模型"迷失"当前指令、
  只回 `Solved after next action`** 的核心问题。
- **新增发送前常驻工具结果截断 `trimToolResults`**（`src/core/compact.js`）：
  每次发送前（不依赖是否超窗）对超长工具结果（>6000 字符）做截断，压住过程噪音。
- **`_ensureFitWindow` 三层收敛**（`src/core/query-engine.js`）：
  ① 工具结果常驻截断 → ② 消息条数折叠 → ③ token 超窗压缩/滑动窗口裁剪兜底。

### 🧪 测试
- `compact-window.test.js` 新增 8 个测试（条数折叠 5 + 工具结果截断 3），共 21 个。
- 全量单元测试通过，无回归。

### 📝 文档
- README：新增 `--max-messages` 参数、自动压缩机制"条数折叠 + 工具截断"层、
  `maxMessages` 配置项说明。
- CHANGELOG：本条目。

## v2.8.11 (未发布) — 保守压缩触发，防止 context 实际超窗（400 exceed_context_size）

### 🐛 修复
- **修复 `exceed_context_size_error` 400 错误**：请求 context（131496 token）超过模型
  实际上限（131072）。根因是 `_ensureFitWindow` 用启发式估算判断是否压缩，而估算可能
  比模型真实 token **偏少**——估算认为"没超窗"时实际已超限，压缩触发太晚，context 涨过
  模型窗口。
- **保守化**（`src/core/query-engine.js`）：
  - 压缩触发点从"估算 > 可用窗口"提前到"估算 > 可用窗口 × **85%**"
    （`compressSafetyFactor`，默认 0.85，可在 `QueryEngineConfig` 配置）；
  - 压缩目标 / `trimToWindow` 兜底也用同一保守阈值（`limitOverride`），
    确保实际请求永远 ≤ 模型窗口，给 tokenization 差异留余量。
- **`trimToWindow` 新增 `limitOverride`**（`src/core/compact.js`）：可直接指定裁剪上限。

### 🧪 测试
- `compact-window.test.js` 新增"limitOverride 保守裁剪上限"测试，共 13 个。
- 全量单元测试通过，无回归。

## v2.8.10 (未发布) — 修复 v2.8.9 诊断日志的 TDZ 错误

### 🐛 修复
- **修复 v2.8.9 引入的 `Cannot access 'url' before initialization` 运行时错误**：
  v2.8.9 的诊断日志在 `body` 构造后立即打印，但引用了**尚未初始化**的 `url`
  变量（TDZ 暂时性死区），导致每次 LLM 请求一开始就抛异常、对话直接失败。
  - **修复**：把 `url` 的定义提前到 `body` 构造之前。

## v2.8.9 (未发布) — verbose 打印实际请求诊断（排查"模型不调用工具"）

### 🐛 诊断
- **`-v` 模式新增请求诊断日志**（`src/core/query-engine.js` `_callLLM`）：
  打印实际发送的请求关键信息，用于排查"模型为何不调用工具 / 复读 / 幻觉"：
  - 请求 URL、`model`、消息条数（system/user/assistant/tool 各多少）
  - 历史中 `tool_calls` 数量、首条/末条消息内容
  - `tools` 定义数量及工具名；若 `tools` 为空则醒目警告
- 仅新增 `console.error` 打印，**不改变任何请求/响应逻辑**。

## v2.8.8 (未发布) — `/window`、`/budget` 显示真实 context 用量

### 🐛 修复
- **修复 `/window`、`/budget` 在本地网关（不返回 usage）时 context 用量恒为 0%**：
  - 原实现 `Input used` 依赖 API 上报的 `inputTokens`。当网关流式响应不返回
    `usage` 时（本地 Ollama/llama.cpp 常见），`inputTokens` 恒为 0，即使对话
    一轮后真实 context 已有内容，仍显示 `0 / 128,000 (0%)`，不符合逻辑。
  - **修复**（`src/core/cli.js`）：改用**实时估算** `estimateMessages(state.messages)`
    反映"当前 context 真实填充了多少窗口"，并显示占可用窗口（减去输出预留）的百分比；
    同时附带显示 API 上报的 input token 作为对照。

### 📝 展示效果（修复后）
```
/window
Context window: 128.0K (手动指定)
  Context used: 4,820 / 128,000 (4% of usable window)
  (real-time estimate; API-reported input: 0 tok)
  Manual override: 128.0K (persisted in config)
```

## v2.8.7 (未发布) — 修复上下文压缩摘要丢失核心任务（AI"变傻"）

### 🐛 关键修复
- **修复"上下文压缩后 AI 失忆、什么也不干"**：根因是 `generateSummary` 摘要质量差，
  把**对话早期/核心的任务指令丢掉了**：
  - 原实现用 `[...topics].slice(-5)` 只保留**最后 5 个** user 意图 → 核心任务如果在
    早期，会被后续例行内容**挤掉**，AI 压缩后完全不知道要干什么；
  - `keyResults[keyResults.length - 1]` 只取**最后一条**结果 → 早期关键发现丢失；
  - 长而无意义的例行内容占满摘要，淹没核心结论。
  - **修复**（`src/core/compact.js` `generateSummary`）：
    - 新增 **`Main goal`**：显式标注对话**最早**的明确用户意图（通常就是核心任务/主线）；
    - 其余意图按出现顺序保留（前 10 条），**数字归一化 + 去填充去重**，
      让"例行检查 0/1/2..."归并为一条，不占满摘要；
    - **Key results**：优先保留【最早的一条结论性内容】+【最新的一条结果】，
      过滤纯填充/过渡性话术，避免例行内容淹没核心结论。

### 🧪 测试
- `compact-window.test.js` 扩充到 12 个：新增"Main goal 保留核心任务"、
  "数字归一化去重"。
- 全量单元测试 123 通过，无回归。

## v2.8.6 (未发布) — 修复滑动窗口裁剪导致上下文丢失（AI"变傻子"）

### 🐛 关键修复
- **修复 v2.8.5 引入的"裁剪反了 → 上下文被直接删除，AI 失忆什么也不干"问题**：
  - **根因**：`_ensureFitWindow` 用实时 `estimateMessages` 判定超窗，但调用的
    `autoCompact` 却用**滞后的 `usagePercent`**（`inputTokens/maxTokens`，只在 LLM
    返回 usage 后才更新）判断是否压缩。两者不一致 → 一旦超窗，`autoCompact` 几乎
    永远返回"不压缩" → 直接走 `trimToWindow` 兜底，把最早的对话（含用户任务指令、
    早期工具结果）**直接删除且不保留摘要**，导致 AI 丢失全部上下文主线。
  - **修复**（`src/core/query-engine.js`）：
    - `_ensureFitWindow` 改用 `compactMessages`（基于实时 token 估算）**强制**摘要压缩，
      不再依赖滞后的 `usagePercent`；
    - 摘要仍超窗时才走 `trimToWindow` 滑动窗口兜底，且 `trimToWindow` **默认保留
      被裁剪历史的摘要**（`keepSummary`），避免上下文丢失。

### ✨ 改进
- **`trimToWindow` 支持摘要保留**（`src/core/compact.js`）：
  - 新增 `keepSummary` 选项（默认 `true`）：被裁掉的早期消息压缩成 `[Context Summary]`
    system 保留，AI 仍保有任务主线；
  - 裁剪时把摘要 token 计入预算，确保"裁剪 + 摘要"后仍 ≤ 窗口上限；
  - 返回结构新增 `summary` 字段。
- **`/compact` 手动命令**（`src/core/cli.js`）：改用实时估算判断是否需要压缩，用户主动
  触发时总能真正压缩（不再因 `usagePercent` 未达标而拒绝）。

### 🧪 测试
- `src/__tests__/compact-window.test.js` 扩充到 10 个：新增"被裁剪历史压缩成摘要保留"、
  "keepSummary=false 不保留摘要"，并修正预算使裁剪+摘要 ≤ 窗口。
- 全量单元测试 121 通过，无回归。

## v2.8.5 (未发布) — 上下文滑动窗口：修复上下文满后无法输入

### 🐛 修复（重要）
- **修复"上下文满了以后后面的信息无法被输入"的 bug**：
  - 原 `autoCompact` 为"摘要式"压缩：保留最近 N 轮 + 早期摘要，依赖 `usagePercent`
    触发，且压缩后不校验是否真的 ≤ 窗口。上下文一满，新消息 push 后整体超窗，
    摘要仍放不下 → 新信息无法输入。
  - 新增**滑动窗口精确裁剪** `trimToWindow`（`src/core/compact.js`）：
    - 计算消息总 token；
    - 超窗时从【最早】消息逐条裁剪（最新信息始终保留在末尾）；
    - 直到总 token ≤ 窗口上限，保证新信息能拼接到末尾；
    - system 提示永不裁剪；极端情况仍保留 system + 最近一条，保证至少能发出请求。
- **`QueryEngine` 新增 `_ensureFitWindow()`**（`src/core/query-engine.js`）：
  - 新消息 push 后 / 工具循环每轮发送前调用，确保上下文永不超窗；
  - 策略：摘要优先（信息量高）→ 仍超窗则滑动窗口精确裁剪兜底。
  - 替换原先不可靠的 `usagePercent` 触发 + 无兜底的硬校验。

### 🧪 测试
- 新增 `src/__tests__/compact-window.test.js`（8 个测试）：未超窗不动、从最早裁剪、
  最新消息保留末尾、system 不裁剪、连续无空洞、极端单条超窗、自动估算。

## v2.8.4 (2026-08-24) — Telegram 帮助信息与命令菜单补全

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
