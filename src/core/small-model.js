/**
 * 小模型适配层 — 让 cc-node 在弱模型（如 27B Q3 量化）下也能可靠工作
 *
 * 背景：
 *   小模型的核心弱点是"规划 + 工具调用 + 自我纠错"不稳定——常出现：
 *     - 看不懂指令，只回 "Solved by sharing best practices." 等敷衍空话，不调工具；
 *     - 一次请求里塞 16 个工具定义让它选择困难，乱调或漏调；
 *     - 多轮工具往返后"丢"了原始目标。
 *   本模块把智能从"模型端"转移到"框架端"，提供两层适配：
 *
 *   【层 A — 兜底（防呆）】：
 *     - 强化 system prompt：明确告诉模型"必须调用工具完成任务，不能只回文字"；
 *     - 敷衍输出检测：识别无工具调用 + 无实质内容的空话，返回需要重试的信号；
 *     - 工具数量精简：按任务场景只暴露核心工具子集，减少选择负担。
 *
 *   【层 B — 替代（框架接管规划）】：
 *     - 意图识别：用关键词规则把常见任务（写文件/找文件/跑命令/查代码）映射到
 *       明确的工具动作，不完全依赖模型自主规划；
 *     - 提供一个"计划"数据结构，框架可据此按序执行。
 *
 * 注意：本模块默认【不启用】。通过 config.smallModel=true 或 --small-model 开启。
 */

// ---- 敷衍/空话输出特征（层 A）----
// 小模型在"没读懂、没调工具"时输出的占位句/空话模式。
// 命中这些且【本轮无工具调用】时，判定为敷衍输出，触发重试。
const FILLER_PATTERNS = [
  /^\s*solved/i,
  /^\s*done\b/i,
  /by sharing best practices/i,
  /this is the kind of mistake/i,
  /next action/i,
  /^\s*ok\b/i,
  /^\s*okay\b/i,
  /^\s*got it/i,
  /^\s*understood/i,
  /^\s*no problem/i,
  /^\s*let me think/i,
  /^\s*sure\b/i,
  /^\s*yes\b/i,
  /^\s*right\b/i,
  /^\s*hmm/i,
]

// 有"实质内容"的最小长度（去掉空白/填充后）
const MIN_SUBSTANTIVE_CHARS = 20

/**
 * 判断一次模型回复是否属于"敷衍输出"（无工具调用 + 空话/过短）
 *
 * 用途：小模型模式下，当模型没调工具却回了句空话时，判定为"没干活"，
 *       触发框架重试（并在重试时追加强引导）。
 *
 * @param {object} response — _callLLM 的返回 { content, toolCalls, ... }
 * @param {object} [opts]
 * @param {number} [opts.minChars=20] — 判定"实质内容"的最小有效字符数
 * @returns {boolean} true 表示敷衍输出（应重试）
 */
export function isFillerResponse(response, opts = {}) {
  const minChars = opts.minChars || MIN_SUBSTANTIVE_CHARS
  // 有工具调用 → 在干活，不是敷衍
  if (response.toolCalls && response.toolCalls.length > 0) return false
  const content = (response.content || '').trim()
  if (!content) return true // 空回复 = 敷衍
  // 去掉空白后的有效字符数
  const substantive = content.replace(/\s+/g, '').replace(/[，。！？,.!?、；;：:]/g, '')
  if (substantive.length < minChars) return true // 太短 = 敷衍
  // 命中空话模式
  for (const pat of FILLER_PATTERNS) {
    if (pat.test(content)) return true
  }
  return false
}

// ---- 小模型强化 system prompt（层 A）----
// 追加到基础 system prompt 之后的强工具引导。对小模型是决定性的：
// 大模型能"猜"到要调工具，小模型必须被明确告知。
export const SMALL_MODEL_SYSTEM_PROMPT = `
## 工具使用铁律（对你至关重要）
你是一个【工具调用 Agent】，不是一个聊天机器人。用户给你的是一个【任务】，你必须通过调用工具来完成任务，绝对不能只回复文字。

遵守以下规则：
1. **每次收到用户任务，第一反应是"该调用哪个工具"，而不是"该怎么用文字回答"。**
2. 如果任务需要读取/查看/搜索文件，调用 Glob / Grep / Read。
3. 如果任务需要创建/修改文件，调用 Write / Edit。
4. 如果任务需要运行命令，调用 Bash。
5. 如果任务需要联网，调用 WebFetch / WebSearch。
6. **调用工具时，必须提供完整、正确的参数**（绝对路径、完整内容、具体命令）。
7. 调用工具后，根据工具返回结果继续，直到任务真正完成。
8. 除非任务只是简单问答（不需要任何工具），否则【禁止】不调用工具就回复。
9. 禁止输出 "Solved by..."、"\u201cDone\u201d"、"Let me think" 等空话——这些不是完成任务。
10. 如果一次要做多件事，一次调用一个工具，逐步推进，不要试图一次性解决。

记住：**你的价值在于调用工具把事做完，而不是说漂亮话。**
`

/**
 * 生成小模型模式下的完整 system prompt（基础 prompt + 强化引导）
 * @param {string} basePrompt — 基础 system prompt
 * @param {object} [opts]
 * @param {string} [opts.cwd] — 当前工作目录（注入给模型，避免它瞎猜文件路径）
 * @returns {string}
 */
export function buildSmallModelSystemPrompt(basePrompt, opts = {}) {
  let prompt = basePrompt + SMALL_MODEL_SYSTEM_PROMPT
  // 注入当前工作目录：小模型没有上下文意识，不知道用户在哪个项目目录，
  // 不给 cwd 它会瞎猜绝对路径（如 /home/user/repos/...），导致 File not found。
  if (opts.cwd) {
    prompt += `\n\n## 当前工作目录\n用户当前的工作目录是：\`${opts.cwd}\`\n查找/读取/写入文件时，优先在此目录（或此目录的子目录）中定位文件，不要猜测其它绝对路径。\n`
  }
  return prompt
}

// ---- 重试追加强引导（层 A）----
// 当模型敷衍输出触发重试时，往对话里注入一条"强制工具调用"的用户级提醒，
// 让模型看到"我刚才敷衍了，现在必须调工具"。
export const RETRY_GUIDANCE = `[系统提示] 你刚才没有调用任何工具就回复了，这不算完成任务。请立即重新审视任务，调用合适的工具（Write/Edit/Read/Grep/Glob/Bash 等）真正完成任务。不要再输出空话。`

// ---- 意图识别 + 框架动作映射（层 B）----
// 小模型模式下，框架用关键词规则把常见任务映射到明确的工具动作，
// 作为"计划"注入，引导模型按序执行（而非让模型自由发挥）。
//
// 每个意图规则：
//   pattern: 触发正则
//   plan: 建议的工具调用序列（按序执行）
//   note: 给模型的动作说明

const INTENT_RULES = [
  {
    // 实现/开发任务：按计划实现、开始写代码、实现模块等 —— 多步复杂任务
    // 这类任务 detectIntent 只给工具提示，真正的分步拆解由 buildMultiStepPlan 完成
    pattern: /(按计划|依据计划|根据计划).*(实现|开发|完成|写代码|编码|落地)/i,
    plan: ['Read（读计划）', 'Glob/Grep（看现状）', 'Write/Edit（实现）', 'Bash（验证）'],
    note: '这是按计划实现代码的多步任务，需要先读计划再逐步实现。',
    toolHint: 'Bash, Read, Edit, Write, Glob, Grep',
  },
  {
    // 实现/开发任务（不带"按计划"）：实现模块/功能/代码
    pattern: /(实现|开发|编写|写出|完成).*(模块|功能|代码|接口|函数|类|系统|第一阶段|阶段)/i,
    plan: ['Read（读相关文件）', 'Glob/Grep（看现状）', 'Write/Edit（实现）', 'Bash（验证）'],
    note: '这是实现代码的多步任务，先了解现状再实现并验证。',
    toolHint: 'Bash, Read, Edit, Write, Glob, Grep',
  },
  {
    // 读/查看/阅读文档或文件 → 读取任务（优先于写规则，避免"阅读XX文档"被误判为写）
    pattern: /(读|阅读|查看|打开|展示|显示|看看|浏览).*(文档|文件|内容|md|readme|代码|计划)/i,
    plan: ['Read（读文件内容）'],
    note: '这是读取任务，用 Read 读取目标文件内容并理解。',
    toolHint: 'Read, Glob',
  },
  {
    // 写文档/文件/计划/代码：覆盖"写/创建/生成/更新/保存/做好...文档/计划"等
    pattern: /(写|创建|生成|更新|保存|做好|做一份|制定|起草|撰写|输出|整理|编写).*(文档|文件|计划|方案|说明|md|readme|代码|函数|模块|接口)/i,
    plan: ['Grep/Glob（先看现状）', 'Write/Edit（写内容）'],
    note: '先搜索确认目标文件是否存在/已有内容，再用 Write 或 Edit 写入。',
    toolHint: 'Write, Edit, Glob, Grep',
  },
  {
    // 明确提到"文档/文件"但未命中动词 → 归为写文件任务（"做...开发计划文档"）
    pattern: /(文档|计划文档|开发计划|方案文档|说明文档|md文件).*(写好|完成|制作|做|实现|产出)?$/i,
    plan: ['Write/Edit（写内容）'],
    note: '这是一个要产出文档/计划的写作任务，直接 Write 或 Edit 写入目标文件。',
    toolHint: 'Write, Edit',
  },
  {
    pattern: /(找|搜索|查|列出|看看|查看|浏览).*(文件|代码|函数|目录|项目|结构)/i,
    plan: ['Glob（找文件）', 'Grep（搜内容）', 'Read（读文件）'],
    note: '用 Glob 找文件路径，用 Grep 搜内容，用 Read 读文件内容。',
    toolHint: 'Glob, Grep, Read',
  },
  {
    pattern: /(跑|运行|执行|测试|调试|编译|构建).*(命令|脚本|程序|测试|npm|node|python|项目|build)/i,
    plan: ['Bash（运行命令）'],
    note: '用 Bash 运行命令/脚本/测试，并读取输出。',
    toolHint: 'Bash',
  },
  {
    pattern: /(改|修|修复|编辑|更新|优化|重构).*(文件|代码|bug|问题|错误|逻辑|接口|函数)/i,
    plan: ['Read（读当前内容）', 'Edit（精确修改）'],
    note: '先 Read 查看当前内容，再用 Edit 精确修改指定位置。',
    toolHint: 'Read, Edit',
  },
  {
    pattern: /(联网|搜索|查一下|网页|网络|资料|信息|最新|资讯)/i,
    plan: ['WebSearch（搜索）', 'WebFetch（抓网页）'],
    note: '用 WebSearch 搜索，用 WebFetch 抓取具体网页内容。',
    toolHint: 'WebSearch, WebFetch',
  },
  {
    pattern: /(git|提交|push|pull|commit|pr|github|版本)/i,
    plan: ['Bash（git 命令）', 'GitTool（PR 管理）'],
    note: '用 Bash 执行 git 命令，或用 GitTool 管理 GitHub PR。',
    toolHint: 'Bash, GitTool',
  },
]

/**
 * 根据用户指令识别意图，返回框架建议的动作计划
 *
 * @param {string} userInput — 用户指令
 * @returns {{ matched: boolean, intent: string, note: string, toolHint: string } | null}
 */
export function detectIntent(userInput) {
  if (!userInput) return null
  for (const rule of INTENT_RULES) {
    if (rule.pattern.test(userInput)) {
      return {
        matched: true,
        intent: rule.plan.join(' → '),
        note: rule.note,
        toolHint: rule.toolHint,
      }
    }
  }
  return null
}

/**
 * 生成注入到消息里的"意图引导 system 提示"（层 B）
 *
 * 当检测到明确意图时，往上下文中插入一条引导，告诉模型该用哪些工具，
 * 降低小模型的决策负担。
 *
 * @param {string} userInput
 * @param {object} [opts]
 * @param {boolean} [opts.enable=true] — 是否启用意图引导
 * @returns {string|null} 引导文本；未匹配或未启用返回 null
 */
export function buildIntentGuidance(userInput, opts = {}) {
  if (opts.enable === false) return null
  const intent = detectIntent(userInput)
  if (!intent) return null
  return `[任务引导] 根据用户指令，建议按此思路用工具推进：${intent.intent}。\n说明：${intent.note}\n可用工具：${intent.toolHint}`
}

/**
 * 框架代执行：从用户指令里推断"框架该替模型执行哪个工具动作"
 *
 * 背景：27B Q3 量化模型工具调用能力极弱，即使有最强引导也常只回"研究一下"等
 * 空话而不调工具。此时框架必须【绕过模型】，根据指令直接替它执行最合理的工具，
 * 把真实结果注入对话，再让模型基于结果总结。
 *
 * 当前支持（按优先级）：
 *   1. 读取文件：指令里含文件路径 + 阅读/查看/打开等动词 → Read(path)
 *
 * 后续可扩展：写文件、跑命令、搜索等。
 *
 * @param {string} userInput — 用户指令
 * @param {object} [opts]
 * @param {string} [opts.cwd] — 当前工作目录（用于解析相对路径）
 * @returns {{ tool: string, input: object, toolName: string } | null}
 *          tool = 'Read'/'Write' 等工具名；input 为工具参数；toolName 为展示名
 */
export function extractFrameworkAction(userInput, opts = {}) {
  if (!userInput) return null
  const cwd = opts.cwd || ''

  // 1. 读取文件任务：含路径 + 读/查看/打开
  const readIntent = /(读|阅读|查看|打开|展示|显示|看看|浏览|看)/i.test(userInput)

  // 提取路径。关键：路径字符集【只允许文件路径合法字符】，遇到逗号/分号/空格/中文
  // 立即停止，避免把指令里的说明文字（如 ",对项目有个全盘了解"）拼进路径。
  // 合法路径字符：字母数字、\ / . : - _、空格(在引号内罕见，排除以免误吞)、
  // Windows 盘符。
  // 优先匹配带扩展名的完整路径，扩展名后即停止。
  const pathRegex =
    /([A-Za-z]:[\\/][\w@.\-\\/ ]*\.(?:md|txt|py|json|log|yaml|yml|toml|ini|cfg|csv|xml)|[\\/][\w@.\-\\/ ]*\.(?:md|txt|py|json|log|yaml|yml|toml|ini|cfg|csv|xml)|\.{1,2}[\\/][\w@.\-\\/]*\.(?:md|txt|py|json|log|yaml|yml|toml|ini|cfg|csv|xml)|[\w@.-]+\.(?:md|txt|py|json|log|yaml|yml|toml|ini|cfg|csv|xml))/i

  // 用 [^,，;；。\s] 确保遇到分隔符就停，然后取最长的、以扩展名结尾的匹配
  const match = userInput.match(pathRegex)
  let filePath = null
  if (match) {
    filePath = match[1].trim()
  }

  if (readIntent && filePath) {
    // 去掉开头的 ./ 或 ../
    filePath = filePath.replace(/^\.\.?[\\/]/, '')
    // 若是相对路径且给了 cwd，拼成绝对路径
    if (!/^[A-Za-z]:[\\/]/.test(filePath) && !filePath.startsWith('/') && cwd) {
      filePath = cwd.replace(/[\\/]+$/, '') + '\\' + filePath
    }
    return { tool: 'Read', toolName: 'Read', input: { file_path: filePath } }
  }

  return null
}

// 常见计划文档文件名（供多步拆解时定位计划文件）
const PLAN_FILE_CANDIDATES = [
  'DEVELOPMENT_PLAN.md',
  'development_plan.md',
  'DEV_PLAN.md',
  'PLAN.md',
  'plan.md',
  'PROJECT_PLAN.md',
  'ROADMAP.md',
]

/**
 * 框架深度拆解：为"按计划实现"类多步任务生成分步执行计划（层 B 深化）
 *
 * 背景：小模型（27B Q3）撑不住"按计划实现第一阶段"这类多步复杂任务——
 * 它常常不读计划就瞎写，或干脆敷衍。框架必须【接管规划】，把任务拆成
 * 明确、可执行的步骤注入给模型。
 *
 * 针对"按计划实现/开发"任务，生成强制分步引导，核心是：
 *   第 1 步必须 Read 计划文件（定位要实现的模块/函数）；
 *   后续步骤按"看现状 → 实现 → 验证"推进。
 *
 * @param {string} userInput — 用户指令
 * @param {object} [opts]
 * @param {string} [opts.cwd] — 当前工作目录（用于给计划文件相对路径）
 * @param {boolean} [opts.enable=true] — 是否启用
 * @returns {{ isMultiStep: boolean, plan: string } | null}
 *          isMultiStep=true 表示识别为多步实现任务；plan 为注入给模型的分步引导
 */
export function buildMultiStepPlan(userInput, opts = {}) {
  if (opts.enable === false) return null
  if (!userInput) return null
  const s = userInput

  // 识别"按计划实现/开发"类任务
  const isPlanImplement = /(按计划|依据计划|根据计划|按开发计划|按照计划).*(实现|开发|完成|写|落地|推进)/i.test(s)
    || /实现.*(计划|第一阶段|阶段|模块)/i.test(s)

  if (!isPlanImplement) return null

  // 定位计划文件：从指令里提取文件名，否则用常见候选
  let planFile = ''
  const m = s.match(/([\w./-]+\.md)/i)
  if (m) {
    planFile = m[1]
  } else {
    planFile = PLAN_FILE_CANDIDATES[0] // 默认 DEVELOPMENT_PLAN.md
  }
  // 若非绝对路径且给了 cwd，拼成相对提示
  const planRef = planFile

  const plan = `[多步执行计划] 这是一个按计划实现代码的任务，请【严格按以下步骤】用工具推进，不要跳过，不要一次做太多：

步骤 1（必做）：用 Read 读取计划文件 \`${planRef}\`，从中找出用户要求实现的阶段/模块/函数（明确要做什么、涉及哪些文件、有哪些要求）。
步骤 2：用 Glob 查看项目当前文件结构（cwd 下），用 Grep 搜索计划里提到的模块/函数是否已有代码。
步骤 3：对每个需要实现的目标，先 Read 相关现有文件了解现状，再用 Write 创建新文件 / 用 Edit 修改已有文件来落地实现。
步骤 4：实现完成后，用 Bash 运行测试或编译命令验证（如有），并总结实现了什么。

严格遵守：第 1 步必须先 Read 计划文件；每一步完成后再进行下一步；不要在没有读计划的情况下直接写代码。`

  return { isMultiStep: true, plan }
}

/**
 * 生成注入到 system 的完整小模型引导（意图引导 + 多步计划 + cwd）
 *
 * 把多个引导源合并成一段，追加到首条 system 消息末尾。
 *
 * @param {string} userInput — 用户指令
 * @param {object} [opts]
 * @param {string} [opts.cwd] — 当前工作目录
 * @param {boolean} [opts.enable=true]
 * @returns {string|null} 合并后的引导文本
 */
export function buildCombinedGuidance(userInput, opts = {}) {
  if (opts.enable === false) return null
  const parts = []
  // 多步计划优先（复杂实现任务走深度拆解）
  const multi = buildMultiStepPlan(userInput, opts)
  if (multi) {
    parts.push(multi.plan)
  } else {
    // 否则用简单意图引导
    const g = buildIntentGuidance(userInput, opts)
    if (g) parts.push(g)
  }
  if (parts.length === 0) return null
  return parts.join('\n\n')
}

/**
 * 工具选择（层 A）— 小模型适配的关键经验
 *
 * 重要结论（来自实测）：**小模型工具调用不能过度精简**。
 * v2.8.12 之前（16 个工具全上）模型能正常调用工具；v2.8.13 之后我做了"按意图
 * 精简成 2-6 个"，结果模型反而不调用工具、只会瞎编。因此策略改为：
 *
 *   1. **保底至少 6 个核心工具**：Bash, Read, Edit, Write, Glob, Grep（每次必给）；
 *   2. **按任务适配追加**：若意图明确需要额外工具（联网→WebSearch/WebFetch 等），
 *      在核心 6 个之上追加，绝不减少核心集；
 *   3. **找不到合适的适配，就全部给**：宁可全给 16 个，也不要精简到很少。
 *
 * 原则：**工具给全，让模型自己挑；而不是替它精简，导致它无工具可用而瞎编。**
 *
 * @param {Array} allTools — 完整 ToolDef 列表
 * @param {string} userInput — 用户指令
 * @param {object} [opts]
 * @param {boolean} [opts.enable=true] — 是否启用适配
 * @returns {Array} 选择后的工具列表（至少 6 个核心；找不到适配则全部）
 */
export function selectRelevantTools(allTools, userInput, opts = {}) {
  if (opts.enable === false) return allTools
  if (!allTools || allTools.length === 0) return allTools

  // 核心工具保底集（每次必给）：小模型不能过度精简工具，否则不会调用只会瞎编
  const CORE = ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep']
  const intent = detectIntent(userInput)

  // 找不到合适的适配（无明确意图）→ 干脆全部调用，让模型自己挑。
  // 这是实测经验：v2.8.12 之前全 16 个工具模型能正常调用；精简后反而变傻。
  if (!intent) {
    return allTools
  }

  // 有明确意图 → 核心 6 个（保底）+ 意图命中的额外工具（追加，不减少核心）
  const toolNames = new Set(CORE)
  if (intent.toolHint) {
    for (const name of intent.toolHint.split(',').map(s => s.trim())) {
      toolNames.add(name)
    }
  }
  const selected = allTools.filter(t => toolNames.has(t.name))

  // 兜底：筛选不足 6 个（核心工具不全）→ 全给
  if (selected.length < 6) {
    return allTools
  }

  return selected
}

/**
 * 小模型模式开关判断
 * @param {object} engineConfig — QueryEngineConfig 实例
 * @returns {boolean}
 */
export function isSmallModelEnabled(engineConfig) {
  return !!(engineConfig && engineConfig.smallModel)
}
