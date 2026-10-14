/**
 * 流式响应处理
 * OpenAI 兼容 SSE 格式（全行业通用）
 *
 * 适用于: DeepSeek / Qwen / GLM / Kimi / Ollama / vLLM / OpenAI / 任何兼容接口
 */

/**
 * 解析 SSE 流式响应
 */
export async function* parseStream(response) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const toolCallBuffers = new Map() // index → { id, name, arguments }

  const result = {
    content: '',
    reasoningContent: '',
    toolCalls: [],
    usage: { input_tokens: 0, output_tokens: 0 },
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop()

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6).trim()
        if (data === '[DONE]') continue

        try {
          const chunk = JSON.parse(data)
          const delta = chunk.choices?.[0]?.delta

          if (!delta) continue

          // reasoning_content (DeepSeek thinking mode)
          if (delta.reasoning_content) {
            result.reasoningContent += delta.reasoning_content
            // 实时产出 reasoning 事件，供 onDelta 回调（如推送思维链到 Telegram）消费
            yield { type: 'reasoning', text: delta.reasoning_content }
          }

          // 文本
          if (delta.content) {
            result.content += delta.content
            yield { type: 'text', text: delta.content }
          }

          // 工具调用
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index
              if (!toolCallBuffers.has(idx)) {
                toolCallBuffers.set(idx, {
                  id: tc.id || '',
                  name: tc.function?.name || '',
                  arguments: '',
                })
              }
              const buf = toolCallBuffers.get(idx)
              if (tc.id) buf.id = tc.id
              if (tc.function?.name) buf.name = tc.function.name
              if (tc.function?.arguments) buf.arguments += tc.function.arguments
            }
          }

          // 流结束 — 处理积攒的工具调用
          if (chunk.choices?.[0]?.finish_reason) {
            for (const [_, buf] of toolCallBuffers) {
              let input = {}
              try { input = JSON.parse(buf.arguments) } catch {}
              result.toolCalls.push({ id: buf.id, name: buf.name, input })
              yield { type: 'tool_use', toolCall: { id: buf.id, name: buf.name, input } }
            }
          }

          // usage
          if (chunk.usage) {
            result.usage.input_tokens = chunk.usage.prompt_tokens || 0
            result.usage.output_tokens = chunk.usage.completion_tokens || 0
            // 思考 token（v3.6.18）：各家的位置/命名不一，逐个兜。
            // 为什么必须采集：思考 token **计入 completion_tokens / max_tokens**。
            // 若预算被思考吃光，响应会是「content 为空 + finish_reason=length」——
            // 这正是"模型返回空回复"最常见的真因，采到它才能一眼定位。
            const rt = chunk.usage.completion_tokens_details?.reasoning_tokens
              ?? chunk.usage.output_tokens_details?.reasoning_tokens
              ?? chunk.usage.reasoning_tokens
            if (typeof rt === 'number') result.usage.reasoning_tokens = rt
          }
          // 结束原因（供上层诊断空回复：length vs stop）
          const fr = chunk.choices?.[0]?.finish_reason
          if (fr) result.usage.finish_reason = fr
        } catch {
          // 忽略解析错误
        }
      }
    }
  } finally {
    reader.releaseLock()
  }

  yield { type: 'done', result }
}

/**
 * 解析非流式响应
 */
export function parseNonStreamResponse(data) {
  const result = { content: '', reasoningContent: '', toolCalls: [], usage: {} }
  const choice = data.choices?.[0]

  if (choice?.message?.content) {
    result.content = choice.message.content
  }

  if (choice?.message?.reasoning_content) {
    result.reasoningContent = choice.message.reasoning_content
  }

  for (const tc of (choice?.message?.tool_calls || [])) {
    let input = {}
    try { input = JSON.parse(tc.function.arguments) } catch {}
    result.toolCalls.push({ id: tc.id, name: tc.function.name, input })
  }

  if (data.usage) {
    const rt = data.usage.completion_tokens_details?.reasoning_tokens
      ?? data.usage.output_tokens_details?.reasoning_tokens
      ?? data.usage.reasoning_tokens
    result.usage = {
      input_tokens: data.usage.prompt_tokens,
      output_tokens: data.usage.completion_tokens,
      ...(typeof rt === 'number' && { reasoning_tokens: rt }),
      ...(choice?.finish_reason && { finish_reason: choice.finish_reason }),
    }
  }

  return result
}
