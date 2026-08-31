// SPDX-License-Identifier: Apache-2.0
// lib/sources/daedalus/convert.mjs — Daedalus 会话 JSON → DSH 会话事件（纯函数）。
//
// Daedalus 会话文件是单个 JSON 对象：{ session_id, model, session_start,
// messages: [...] }。messages 为 OpenAI 兼容结构：
//   - user:     { role, content }
//   - assistant:{ role, content, finish_reason, reasoning?, reasoning_content?,
//                 tool_calls?: [{ id, call_id, function: { name, arguments } }] }
//   - tool:     { role, content, tool_call_id }
//
// 转换纪律与其他源一致：user 消息开新回合；assistant 消息 = 一个 step
// （content: text/reasoning + toolCalls）；tool 结果挂到声明该 call_id 的
// step 上（跨 step 的孤儿结果由 synthesizeSession 计数并合成错误结果兜底）。

import { SESSION_FORMAT_VERSION, mintSessionId, parseTime, synthesizeSession } from '../../convert.mjs'
import { truncateText } from '../contract.mjs'

/** 从消息 content 提取纯文本（string 或 block 数组）。 */
function asText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' && typeof b.text === 'string' ? b.text : ''))
      .join('\n')
  }
  return ''
}

/** 提取推理文本（reasoning 优先，其次 reasoning_content）。 */
function reasoningText(m) {
  for (const key of ['reasoning', 'reasoning_content']) {
    const v = m?.[key]
    if (typeof v === 'string' && v.trim()) return v
  }
  return ''
}

/**
 * 转换 Daedalus 会话 JSON 文本为 DSH 会话事件结构。
 * @param raw - 会话文件 JSON 文本。
 * @param args - { sessionId? }（session_id 缺失时的兜底）。
 * @returns synthesizeSession 输出 { meta, events, turns, title, messages, toolCalls, skipped, records, repaired }。
 */
export function convertDaedalusSession(raw, args = {}) {
  let doc
  try {
    doc = JSON.parse(raw)
  } catch (err) {
    throw new Error('Daedalus session JSON parse failed: ' + ((err && err.message) || err))
  }
  const messages = Array.isArray(doc?.messages) ? doc.messages : []
  const sourceId = (typeof doc?.session_id === 'string' && doc.session_id)
    || args.sessionId
    || String(Date.now())
  const meta = {
    version: SESSION_FORMAT_VERSION,
    id: mintSessionId(sourceId),
    createdAt: parseTime(doc?.session_start),
  }
  const model = typeof doc?.model === 'string' && doc.model ? doc.model : 'daedalus'

  const turns = []
  const stepByCallId = new Map()
  let current = null
  let skipped = 0
  for (const m of messages) {
    const role = m?.role
    if (role === 'user') {
      const text = asText(m?.content)
      if (!text.trim()) { skipped += 1; continue }
      current = { prompt: text, steps: [] }
      turns.push(current)
    } else if (role === 'assistant') {
      if (!current) {
        current = { prompt: '(no user message)', steps: [] }
        turns.push(current)
      }
      const content = []
      const text = asText(m?.content).trim()
      if (text) content.push({ type: 'text', text })
      const reasoning = reasoningText(m)
      if (reasoning) content.push({ type: 'reasoning', text: reasoning })
      const step = { content, toolCalls: [], toolResults: [] }
      current.steps.push(step)
      for (const tc of Array.isArray(m?.tool_calls) ? m.tool_calls : []) {
        const id = (typeof tc?.id === 'string' && tc.id) || (typeof tc?.call_id === 'string' ? tc.call_id : '')
        const name = tc?.function?.name
        if (!id || typeof name !== 'string' || !name) continue
        const argsRaw = tc?.function?.arguments
        const argumentText = typeof argsRaw === 'string' ? argsRaw : JSON.stringify(argsRaw ?? {})
        step.toolCalls.push({ id, name, arguments: argumentText })
        stepByCallId.set(id, step)
      }
    } else if (role === 'tool') {
      const callId = typeof m?.tool_call_id === 'string' ? m.tool_call_id : ''
      const result = { toolCallId: callId, content: [{ type: 'text', text: asText(m?.content) }] }
      const declaring = callId ? stepByCallId.get(callId) : undefined
      if (declaring) {
        declaring.toolResults.push(result)
      } else if (current && current.steps.length > 0) {
        current.steps[current.steps.length - 1].toolResults.push(result)
      } else {
        skipped += 1
      }
    } else {
      skipped += 1
    }
  }

  const titleTurn = turns.find((t) => t.prompt && !t.prompt.startsWith('('))
  const title = titleTurn ? truncateText(titleTurn.prompt) : ''
  return synthesizeSession({
    meta,
    turns,
    title,
    provider: 'daedalus',
    model,
    skipped,
    records: messages.length,
  })
}
