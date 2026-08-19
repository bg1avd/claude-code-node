/**
 * AskUserQuestion 工具 — 向用户提问
 * 对应原版: src/tools/AskUserQuestionTool/
 *
 * 交互策略（按优先级）：
 * 1. ctx.engine.config.onAskUser — 由宿主（cli.js）注入，按当前来源（CLI/Telegram）分流，
 *    Telegram 模式推送问题到远程并等待回复（带超时兜底），CLI 模式走本地终端交互。
 *    这是最完善的路径，避免远程模式下本地阻塞导致引擎死锁。
 * 2. ctx.readline — 回退：本地 CLI 终端 question。
 * 3. 都不存在 — 返回提示信息（不阻塞）。
 */
import { ToolDef } from '../types/index.js'

export const askUserTool = new ToolDef(
  'AskUserQuestion',
  `Ask the user a question and wait for their response.
Use this when you need clarification or user input to proceed.`,
  {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: 'The question to ask the user',
      },
    },
    required: ['question'],
  },
  async (input, ctx) => {
    // 优先级 1：宿主注入的 onAskUser（处理 CLI / Telegram 分流，含远程等待与超时兜底）
    const onAskUser = ctx?.engine?.config?.onAskUser
    if (typeof onAskUser === 'function') {
      return onAskUser(input.question)
    }

    // 优先级 2：CLI 模式，通过 readline 接口提问
    if (ctx?.readline) {
      return new Promise((resolve) => {
        ctx.readline.question(`\n❓ ${input.question}\n> `, (answer) => {
          resolve(answer.trim())
        })
      })
    }

    // 优先级 3：非 CLI 模式 — 返回提示信息，不阻塞
    return `[AskUserQuestion: ${input.question} (no interactive terminal available)]`
  },
  'always-allow'
)
