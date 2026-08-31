// daedalus-parser.test.mjs — Daedalus 源解析器：定位/白名单/会话/技能/记忆/SOUL.md 检测。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { locateHome, whitelist, detect, source } from '../../lib/sources/daedalus/parser.mjs'
import { assertAllowedRead, digestText } from '../../lib/sources/contract.mjs'

async function makeTempHome(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'daedalus-move-test-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  return dir
}

test('locateHome：DAEDALUS_HOME 优先，空值回退默认 ~/.daedalus', () => {
  assert.equal(source, 'daedalus')
  assert.equal(locateHome({ DAEDALUS_HOME: 'D:\\daedalus' }, 'C:\\Users\\me'), path.resolve('D:\\daedalus'))
  assert.equal(locateHome({}, 'C:\\Users\\me'), path.join('C:\\Users\\me', '.daedalus'))
  assert.equal(locateHome({ DAEDALUS_HOME: '   ' }, 'C:\\Users\\me'), path.join('C:\\Users\\me', '.daedalus'))
})

test('whitelist：auth.json/.env/config.yaml/checkpoints/request_dump 越界读取抛错，白名单内放行', () => {
  const home = 'D:\\daedalus-home'
  const roots = whitelist(home)
  for (const bad of ['auth.json', '.env', 'config.yaml', 'checkpoints', 'gateway', 'request_dump_1.json']) {
    assert.throws(() => assertAllowedRead(roots, path.join(home, bad)), /读取越界/)
  }
  assert.equal(assertAllowedRead(roots, path.join(home, 'sessions', 'session_x.json')), path.resolve(home, 'sessions', 'session_x.json'))
  assert.equal(assertAllowedRead(roots, path.join(home, 'SOUL.md')), path.resolve(home, 'SOUL.md'))
})

test('detect：session_*.json 检测（id/title/turns/model/createdAt），request_dump_* 永不读取，畸形 JSON 记 error', async (t) => {
  const home = await makeTempHome(t)
  const sessionsRoot = path.join(home, 'sessions')
  await mkdir(sessionsRoot, { recursive: true })
  const doc = {
    session_id: 'sess_1',
    model: 'test-model',
    session_start: '2026-08-01T10:00:00Z',
    messages: [
      { role: 'user', content: 'Fix the bug' },
      { role: 'assistant', content: 'Done', tool_calls: [{ id: 'c1', function: { name: 'bash', arguments: '{}' } }] },
      { role: 'tool', content: 'ok', tool_call_id: 'c1' },
    ],
  }
  await writeFile(path.join(sessionsRoot, 'session_a.json'), JSON.stringify(doc), 'utf8')
  await writeFile(path.join(sessionsRoot, 'request_dump_1.json'), '{"messages":[]}', 'utf8')
  await writeFile(path.join(sessionsRoot, 'session_bad.json'), '{oops', 'utf8')

  const detection = await detect(home)
  assert.equal(detection.source, 'daedalus')
  assert.equal(detection.homeExists, true)
  assert.equal(detection.sessions.length, 1)
  const s = detection.sessions[0]
  assert.equal(s.id, 'sess_1')
  assert.equal(s.title, 'Fix the bug')
  assert.equal(s.turns, 1)
  assert.equal(s.messages, 3)
  assert.equal(s.model, 'test-model')
  assert.equal(s.createdAt, Date.parse('2026-08-01T10:00:00Z'))
  assert.ok(!detection.sessions.some((x) => x.file.includes('request_dump')))
  assert.equal(detection.errors.length, 1)
  assert.match(detection.errors[0].scope, /session_bad/)
})

test('detect：session_id 缺失回退文件名 stem；超大文件记 error 跳过', async (t) => {
  const home = await makeTempHome(t)
  const sessionsRoot = path.join(home, 'sessions')
  await mkdir(sessionsRoot, { recursive: true })
  await writeFile(path.join(sessionsRoot, 'session_stem.json'), JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }), 'utf8')
  await writeFile(path.join(sessionsRoot, 'session_big.json'), 'x'.repeat(1024), 'utf8')

  const detection = await detect(home, { maxSessionBytes: 100 })
  assert.equal(detection.sessions.length, 1)
  assert.equal(detection.sessions[0].id, 'session_stem')
  assert.equal(detection.errors.length, 1)
  assert.match(detection.errors[0].error, /too large/)
})

test('detect：嵌套技能、MEMORY_.md 备份不扫描、SOUL.md 记为 instructions', async (t) => {
  const home = await makeTempHome(t)
  const skillsRoot = path.join(home, 'skills')
  await mkdir(path.join(skillsRoot, 'devops', 'deploy-k8s'), { recursive: true })
  await writeFile(path.join(skillsRoot, 'devops', 'deploy-k8s', 'SKILL.md'),
    '---
name: deploy-k8s
description: Deploy to k8s
---

# Steps
', 'utf8')
  const memoriesRoot = path.join(home, 'memories')
  await mkdir(memoriesRoot, { recursive: true })
  const memContent = '§ 记住部署流程
'
  const userContent = '§ 我是李四
'
  await writeFile(path.join(memoriesRoot, 'MEMORY.md'), memContent, 'utf8')
  await writeFile(path.join(memoriesRoot, 'MEMORY_.md'), '§ 备份
', 'utf8')
  await writeFile(path.join(memoriesRoot, 'USER.md'), userContent, 'utf8')
  const soulContent = '# SOUL
Be kind.
'
  await writeFile(path.join(home, 'SOUL.md'), soulContent, 'utf8')

  const detection = await detect(home)
  assert.equal(detection.skills.length, 1)
  const skill = detection.skills[0]
  assert.equal(skill.id, 'deploy-k8s')
  assert.equal(skill.name, 'deploy-k8s')
  assert.equal(skill.compatible, true)
  assert.equal(skill.frontmatterName, 'deploy-k8s')
  assert.equal(skill.digest, digestText('---
name: deploy-k8s
description: Deploy to k8s
---

# Steps
'))

  assert.equal(detection.memories.length, 2)
  const mem = detection.memories.find((m) => m.id === 'MEMORY.md')
  const user = detection.memories.find((m) => m.id === 'USER.md')
  assert.ok(mem && user)
  assert.equal(mem.kind, 'daedalus-memory')
  assert.equal(user.kind, 'daedalus-user')
  assert.equal(mem.bytes, Buffer.byteLength(memContent, 'utf8'))
  assert.equal(mem.digest, digestText(memContent))

  assert.equal(detection.instructions.length, 1)
  assert.equal(detection.instructions[0].id, 'SOUL.md')
  assert.equal(detection.instructions[0].kind, 'daedalus-soul')
  assert.equal(detection.instructions[0].digest, digestText(soulContent))
  assert.deepEqual(detection.errors, [])
})

test('detect：home 不存在 → homeExists=false，空数组无错', async (t) => {
  const base = await makeTempHome(t)
  const detection = await detect(path.join(base, 'nope'))
  assert.equal(detection.homeExists, false)
  assert.deepEqual(detection.sessions, [])
  assert.deepEqual(detection.skills, [])
  assert.deepEqual(detection.memories, [])
  assert.deepEqual(detection.instructions, [])
  assert.deepEqual(detection.errors, [])
})
