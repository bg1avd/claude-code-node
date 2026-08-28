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
 * @returns {string}
 */
export function buildSmallModelSystemPrompt(basePrompt) {
  return basePrompt + SMALL_MODEL_SYSTEM_PROMPT
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
 * 精简工具列表（层 A）— 小模型一次看太多工具会混乱
 *
 * 从完整工具列表里，按用户指令筛选出最相关的核心工具子集。
 * 这样模型的工具选择负担小，更不容易乱调/漏调。
 *
 * @param {Array} allTools — 完整 ToolDef 列表
 * @param {string} userInput — 用户指令
 * @param {object} [opts]
 * @param {boolean} [opts.enable=true] — 是否启用精简
 * @returns {Array} 精简后的工具列表
 */
export function selectRelevantTools(allTools, userInput, opts = {}) {
  if (opts.enable === false) return allTools
  if (!allTools || allTools.length === 0) return allTools

  const intent = detectIntent(userInput)
  // 未识别到明确意图 → 返回核心工具（不塞满 16 个）
  const coreNames = intent
    ? intent.toolHint.split(',').map(s => s.trim())
    : ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep']

  // 核心工具优先，保留指定工具；若一个都没命中则退回首屏核心集
  const selected = allTools.filter(t => coreNames.includes(t.name))
  if (selected.length === 0) {
    return allTools.filter(t => ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep'].includes(t.name))
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
