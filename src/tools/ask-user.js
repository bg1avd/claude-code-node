/**
 * AskUserQuestion 工具 — 向用户提问
 * 对应原版: src/tools/AskUserQuestionTool/
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
    // 在 CLI 模式下，通过 ctx 的 readline 接口提问
    if (ctx?.readline) {
      return new Promise((resolve) => {
        ctx.readline.question(`\n❓ ${input.question}\n> `, (answer) => {
          resolve(answer.trim())
        })
      })
    }
    // 非 CLI 模式 — 返回提示信息
    return `[AskUserQuestion: ${input.question} (no interactive terminal available)]`
  },
  'always-allow'
)
