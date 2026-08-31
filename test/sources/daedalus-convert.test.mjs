// daedalus-convert.test.mjs — Daedalus 会话转换：回合/步骤合成、工具调用平衡、标题、事件纪律。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { convertDaedalusSession } from '../../lib/sources/daedalus/convert.mjs'
import { parseTime, validateSessionEvents } from '../../lib/convert.mjs'

test('convertDaedalusSession：用户/助手/tool 回合、文本/推理/工具平衡、标题唯一', () => {
  const raw = JSON.stringify({
    session_id: 'sess_1',
    model: 'test-model',
    session_start: '2026-08-01T10:00:00Z',
    messages: [
      { role: 'user', content: 'Fix the bug' },
      {
        role: 'assistant',
        content: 'Here you go:',
        reasoning: 'think…',
        tool_calls: [{ id: 'c1', function: { name: 'bash', arguments: '{"command":"ls"}' } }],
      },
      { role: 'tool', content: 'a.txt', tool_call_id: 'c1' },
    ],
  })
  const converted = convertDaedalusSession(raw, { sessionId: 'sess_1' })
  assert.equal(converted.meta.id, 'import-sess_1')
  assert.equal(converted.meta.createdAt, parseTime('2026-08-01T10:00:00Z'))
  assert.equal(converted.turns.length, 1)
  assert.equal(converted.toolCalls, 1)
  assert.equal(converted.messages, 3)
  assert.equal(converted.title, 'Fix the bug')
  assert.ok(converted.events.some((e) => e.type === 'assistant/message'
    && e.data.message.content.some((b) => b.type === 'reasoning')))
  const call = converted.events.find((e) => e.type === 'tool/call')
  assert.equal(call.data.name, 'bash')
  assert.equal(call.data.arguments, '{"command":"ls"}')
  const titles = converted.events.filter((e) => e.type === 'session/title')
  assert.equal(titles.length, 1)
  assert.equal(titles[0].data.title, 'Fix the bug')
  assert.deepEqual(validateSessionEvents(converted.events), [])
})

test('convertDaedalusSession：call_id 兜底、缺失结果补合成错误结果、孤儿结果计数', () => {
  const raw = JSON.stringify({
    session_id: 'sess_2',
    messages: [
      { role: 'user', content: 'do it' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { call_id: 'pending_1', function: { name: 'bash', arguments: {} } },
          { id: 'err_1', function: { name: 'read', arguments: '{}' } },
        ],
      },
      { role: 'tool', content: 'ok', tool_call_id: 'err_1' },
      { role: 'tool', content: 'orphan', tool_call_id: 'no_such_call' },
    ],
  })
  const converted = convertDaedalusSession(raw, { sessionId: 'sess_2' })
  assert.deepEqual(validateSessionEvents(converted.events), [])
  const results = converted.events.filter((e) => e.type === 'tool/result')
  // pending_1 无结果 → 合成；err_1 真实结果；孤儿不产生事件。
  assert.equal(results.length, 2)
  assert.equal(converted.repaired.synthesized, 1)
  assert.equal(converted.repaired.orphanResults, 1)
  const errResult = results.find((e) => e.data.message.content[0].toolCallId === 'err_1')
  assert.equal(errResult.data.message.content[0].content[0].text, 'ok')
})

test('convertDaedalusSession：多用户消息切多回合，空 user 跳过', () => {
  const raw = JSON.stringify({
    session_id: 'sess_3',
    messages: [
      { role: 'user', content: 'First question?' },
      { role: 'assistant', content: 'A1' },
      { role: 'user', content: '   ' },
      { role: 'assistant', content: 'A2' },
      { role: 'user', content: 'Second?' },
      { role: 'assistant', content: 'A3' },
    ],
  })
  const converted = convertDaedalusSession(raw, { sessionId: 'sess_3' })
  assert.equal(converted.turns.length, 2)
  assert.equal(converted.skipped, 1)
  const titles = converted.events.filter((e) => e.type === 'session/title')
  assert.equal(titles.length, 1)
  assert.equal(titles[0].data.title, 'First question?')
  assert.deepEqual(validateSessionEvents(converted.events), [])
})

test('convertDaedalusSession：无 session_id 用 args.sessionId 兜底；空会话不抛错', () => {
  const converted = convertDaedalusSession(JSON.stringify({ messages: [] }), { sessionId: 'sess_4' })
  assert.equal(converted.meta.id, 'import-sess_4')
  assert.equal(converted.events.length, 0)
  assert.equal(converted.messages, 0)
})

test('convertDaedalusSession：畸形 JSON 抛错', () => {
  assert.throws(() => convertDaedalusSession('{oops'), /parse failed/)
})
