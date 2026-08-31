// daedalus-mapper.test.mjs — Daedalus 源映射器：会话 import-session、技能 copy/convert-copy、记忆/SOUL.md 管理段。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { mapSource } from '../../lib/sources/daedalus/mapper.mjs'
import { detect } from '../../lib/sources/daedalus/parser.mjs'
import { skillTargetPath, kebabName } from '../../lib/skill-migrate.mjs'
import { digestText, planKey } from '../../lib/sources/contract.mjs'
import { defaultAgentsMdPath } from '../../lib/agmd-section.mjs'

async function makeTempHome(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'daedalus-move-map-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  return dir
}

test('mapSource：sessions → import-session（provider/importKey/turns/title/model）', async (t) => {
  const home = await makeTempHome(t)
  const sessionsRoot = path.join(home, 'sessions')
  await mkdir(sessionsRoot, { recursive: true })
  const doc = {
    session_id: 'sess_1',
    model: 'test-model',
    session_start: '2026-08-01T10:00:00Z',
    messages: [
      { role: 'user', content: 'Fix the bug' },
      { role: 'assistant', content: 'Done' },
      { role: 'user', content: 'And more' },
    ],
  }
  await writeFile(path.join(sessionsRoot, 'session_a.json'), JSON.stringify(doc), 'utf8')

  const detection = await detect(home)
  const { plans, errors } = mapSource('daedalus', detection, { skillsDir: 'D:\\dsh\\skills' })
  assert.deepEqual(errors, [])
  const p = plans.find((x) => x.kind === 'session')
  assert.ok(p)
  assert.equal(p.action, 'import-session')
  assert.equal(p.provider, 'daedalus')
  assert.equal(p.from, 'daedalus')
  assert.equal(p.key, planKey('daedalus', 'session', 'sess_1'))
  assert.equal(p.source.importKey, path.join(sessionsRoot, 'session_a.json'))
  assert.equal(p.source.sessionId, 'sess_1')
  assert.equal(p.source.turns, 2)
  assert.equal(p.title, 'Fix the bug')
  assert.equal(p.model, 'test-model')
})

test('mapSource：skills → copy/convert-copy，target 用 kebab 名', async (t) => {
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
  await mkdir(path.join(skillsRoot, 'qa', 'smoke-tests'), { recursive: true })
  await writeFile(path.join(skillsRoot, 'qa', 'smoke-tests', 'SKILL.md'),
    '---
name: smoke-tests
---

# Run smoke tests
', 'utf8')

  const detection = await detect(home)
  const skillsDir = 'D:\\dsh\\skills'
  const { plans, errors } = mapSource('daedalus', detection, { skillsDir })
  assert.deepEqual(errors, [])

  const skills = plans.filter((p) => p.kind === 'skill')
  assert.equal(skills.length, 2)
  const copy = skills.find((p) => p.action === 'copy')
  const convert = skills.find((p) => p.action === 'convert-copy')
  assert.ok(copy && convert)
  assert.equal(copy.key, 'daedalus:skill:deploy-k8s')
  assert.equal(convert.key, 'daedalus:skill:smoke-tests')
  assert.equal(copy.target.path, skillTargetPath(skillsDir, 'deploy-k8s'))
  assert.equal(kebabName('deploy-k8s'), 'deploy-k8s')
  assert.equal(copy.digest, detection.skills.find((s) => s.id === 'deploy-k8s').digest)
})

test('mapSource：memories → append-section，content 非空、MEMORY/USER 独立段 key', async (t) => {
  const home = await makeTempHome(t)
  const memoriesRoot = path.join(home, 'memories')
  await mkdir(memoriesRoot, { recursive: true })
  const memContent = '§ 条目一
§ 条目二
'
  const userContent = '§ 用户偏好
'
  await writeFile(path.join(memoriesRoot, 'MEMORY.md'), memContent, 'utf8')
  await writeFile(path.join(memoriesRoot, 'USER.md'), userContent, 'utf8')
  const soulContent = '# SOUL
Be kind.
'
  await writeFile(path.join(home, 'SOUL.md'), soulContent, 'utf8')

  const detection = await detect(home)
  const agentsMdPath = 'D:\\dsh\\AGENTS.md'
  const { plans, errors } = mapSource('daedalus', detection, { agentsMdPath })
  assert.deepEqual(errors, [])

  const memories = plans.filter((p) => p.kind === 'memory')
  assert.equal(memories.length, 2)
  const mem = memories.find((p) => p.source.file.endsWith('MEMORY.md'))
  const user = memories.find((p) => p.source.file.endsWith('USER.md'))
  assert.ok(mem && user)
  assert.equal(mem.action, 'append-section')
  assert.equal(mem.target.path, agentsMdPath)
  assert.equal(mem.content, memContent)
  assert.equal(mem.digest, digestText(memContent))
  assert.equal(mem.key, 'daedalus:memory:MEMORY.md')
  assert.equal(user.key, 'daedalus:memory:USER.md')
  assert.notEqual(mem.key, user.key, 'MEMORY.md 与 USER.md 各一个独立段 key')
  assert.equal(mem.source.kind, 'daedalus-memory')
  assert.equal(user.source.kind, 'daedalus-user')

  const instr = plans.find((p) => p.kind === 'instruction')
  assert.ok(instr)
  assert.equal(instr.action, 'append-section')
  assert.equal(instr.content, soulContent)
  assert.equal(instr.source.kind, 'daedalus-soul')
  assert.equal(instr.key, 'daedalus:instruction:SOUL.md')
})

test('mapSource：agentsMdPath 缺省 defaultAgentsMdPath', async (t) => {
  const home = await makeTempHome(t)
  const memoriesRoot = path.join(home, 'memories')
  await mkdir(memoriesRoot, { recursive: true })
  await writeFile(path.join(memoriesRoot, 'MEMORY.md'), '§ x
', 'utf8')

  const detection = await detect(home)
  const { plans } = mapSource('daedalus', detection, {})
  const mem = plans.find((p) => p.kind === 'memory')
  assert.equal(mem.target.path, defaultAgentsMdPath())
})

test('mapSource：memory 越界/缺失读取失败跳过并记 errors', () => {
  const home = 'D:\\daedalus-home'
  const detection = {
    source: 'daedalus',
    home,
    skills: [],
    memories: [
      { id: 'MEMORY.md', file: path.join(home, 'config.yaml'), kind: 'daedalus-memory', bytes: 0, digest: 'x' },
      { id: 'USER.md', file: path.join(home, 'memories', 'USER.md'), kind: 'daedalus-user', bytes: 0, digest: 'y' },
    ],
  }
  const { plans, errors } = mapSource('daedalus', detection, { skillsDir: path.join(home, 'out', 'skills') })
  assert.deepEqual(plans, [])
  assert.equal(errors.length, 2)
  assert.match(errors[0], /读取越界/)
  assert.match(errors[1], /ENOENT/)
})
