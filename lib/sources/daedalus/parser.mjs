// SPDX-License-Identifier: Apache-2.0
// lib/sources/daedalus/parser.mjs — Daedalus 源解析器（五源迁移向导）。
//
// Daedalus（Nous Research Python agent）数据根 ~/.daedalus 是 git checkout，
// 代码与数据混放；迁移范围只取数据区：
//   - sessions/session_*.json：完整会话 JSON（messages: user/assistant/tool，
//     OpenAI 兼容 tool_calls / tool_call_id）。request_dump_*.json 是原始 API
//     请求转储，不是会话——永不读取。
//   - skills/：嵌套分类目录（skills/<category>/<name>/SKILL.md）。
//   - memories/MEMORY.md + USER.md：§ 分隔记忆条目文件（内容原样迁移）。
//     MEMORY_.md 是备份文件，不扫描。
//   - SOUL.md：agent 人格/指令文件。
// 只读白名单只含这四条路径：auth.json / .env / config.yaml / checkpoints/ /
// gateway/ / 源码等凭据与内部状态一律不在白名单内。

import { existsSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { assertAllowedRead, digestText, emptyDetection, recordError, truncateText } from '../contract.mjs'
import { classifySkill, skipSkillEntry } from '../../skill-migrate.mjs'

export const source = 'daedalus'

/** 单会话文件大小上限（超出 → 记录 error，跳过）。 */
export const DEFAULT_SESSION_MAX_BYTES = 64 * 1024 * 1024

function isMissingError(err) {
  return err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')
}

/** Daedalus 数据根定位（$DAEDALUS_HOME / ~/.daedalus）。 */
export function locateHome(env = process.env, home = homedir()) {
  const raw = env.DAEDALUS_HOME
  if (typeof raw === 'string' && raw.trim().length > 0) return path.resolve(raw)
  return path.join(home, '.daedalus')
}

/** 只读白名单：仅 sessions / skills / memories / SOUL.md 四条路径。 */
export function whitelist(home) {
  return [
    path.join(home, 'sessions'),
    path.join(home, 'skills'),
    path.join(home, 'memories'),
    path.join(home, 'SOUL.md'),
  ]
}

/** 从 user 消息 content 提取纯文本（string 或 block 数组）。 */
function userText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' && typeof b.text === 'string' ? b.text : ''))
      .join('\n')
  }
  return ''
}

function parseTimeSafe(value) {
  if (typeof value !== 'string') return undefined
  const n = Date.parse(value)
  return Number.isFinite(n) ? n : undefined
}

/** 扫描单个会话文件 → 会话条目（解析失败/超大 → 记录 error 并跳过）。 */
async function scanSessionFile(file, roots, detection, maxBytes, signal) {
  let info
  try {
    info = await stat(assertAllowedRead(roots, file), { ...(signal ? { signal } : {}) })
  } catch (err) {
    if (isMissingError(err)) return null
    if (signal?.aborted) throw err
    recordError(detection, 'session:' + file, err)
    return null
  }
  if (info.size > maxBytes) {
    recordError(detection, 'session:' + file, new Error(
      'session file too large (' + info.size + ' bytes > ' + maxBytes + ')'))
    return null
  }
  let doc
  try {
    doc = JSON.parse(await readFile(assertAllowedRead(roots, file), { encoding: 'utf8', ...(signal ? { signal } : {}) }))
  } catch (err) {
    if (signal?.aborted) throw err
    recordError(detection, 'session:' + file, err)
    return null
  }
  const messages = Array.isArray(doc?.messages) ? doc.messages : []
  const userMsgs = messages.filter((m) => m && m.role === 'user')
  const firstUser = userMsgs.find((m) => userText(m.content).trim().length > 0)
  const id = (typeof doc?.session_id === 'string' && doc.session_id)
    || path.basename(file).replace(/\.json$/i, '')
  return {
    id,
    file,
    title: truncateText(userText(firstUser?.content)),
    turns: userMsgs.length,
    messages: messages.length,
    model: typeof doc?.model === 'string' && doc.model ? doc.model : '',
    createdAt: parseTimeSafe(doc?.session_start),
    bytes: info.size,
  }
}

/** 扫描 sessions/（只取 session_*.json；request_dump_* 永不读取）。 */
async function scanSessions(sessionsRoot, detection, roots, maxBytes, signal) {
  const out = []
  if (signal?.aborted) return out
  let entries
  try {
    entries = await readdir(sessionsRoot, { withFileTypes: true, ...(signal ? { signal } : {}) })
  } catch (err) {
    if (isMissingError(err)) return out
    if (signal?.aborted) throw err
    recordError(detection, 'sessions', err)
    return out
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const entry of entries) {
    if (signal?.aborted) return out
    if (!entry.isFile()) continue
    if (!/^session_.*\.json$/i.test(entry.name)) continue
    const item = await scanSessionFile(path.join(sessionsRoot, entry.name), roots, detection, maxBytes, signal)
    if (item) out.push(item)
  }
  return out
}

/** 递归扫描 skills/（嵌套分类目录，与 Hermes 布局一致）。 */
async function walkSkills(dir, detection, roots, signal) {
  const out = []
  if (signal?.aborted) return out
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true, ...(signal ? { signal } : {}) })
  } catch (err) {
    if (isMissingError(err)) return out
    if (signal?.aborted) throw err
    recordError(detection, 'skills:' + dir, err)
    return out
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const entry of entries) {
    if (signal?.aborted) return out
    if (skipSkillEntry(entry.name, entry.isDirectory())) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...(await walkSkills(full, detection, roots, signal)))
    } else if (entry.isFile() && entry.name === 'SKILL.md') {
      const item = await readSkill(full, detection, roots, signal)
      if (item) out.push(item)
    }
  }
  return out
}

/** 读取单个 SKILL.md → 技能条目（含兼容判定与 digest）。 */
async function readSkill(file, detection, roots, signal) {
  let content
  try {
    content = await readFile(assertAllowedRead(roots, file), { encoding: 'utf8', ...(signal ? { signal } : {}) })
  } catch (err) {
    if (isMissingError(err)) return null
    if (signal?.aborted) throw err
    recordError(detection, 'skill:' + file, err)
    return null
  }
  const dir = path.dirname(file)
  const name = path.basename(dir)
  const { compatible, name: fmName } = classifySkill(content)
  return {
    id: name,
    file,
    dir,
    name,
    compatible,
    digest: digestText(content),
    ...(fmName ? { frontmatterName: fmName } : {}),
  }
}

/** 扫描 memories/（MEMORY.md + USER.md；MEMORY_.md 备份不扫）。 */
async function scanMemories(memoriesRoot, detection, roots, signal) {
  const out = []
  if (signal?.aborted) return out
  for (const [fileName, kind] of [['MEMORY.md', 'daedalus-memory'], ['USER.md', 'daedalus-user']]) {
    if (signal?.aborted) return out
    const file = path.join(memoriesRoot, fileName)
    let info
    try {
      info = await stat(assertAllowedRead(roots, file), { ...(signal ? { signal } : {}) })
    } catch (err) {
      if (isMissingError(err)) continue
      if (signal?.aborted) throw err
      recordError(detection, 'memory:' + file, err)
      continue
    }
    let content
    try {
      content = await readFile(assertAllowedRead(roots, file), { encoding: 'utf8', ...(signal ? { signal } : {}) })
    } catch (err) {
      if (signal?.aborted) throw err
      recordError(detection, 'memory:' + file, err)
      continue
    }
    out.push({
      id: fileName,
      file,
      kind,
      bytes: info.size,
      digest: digestText(content),
    })
  }
  return out
}

/** 扫描 SOUL.md（agent 人格/指令文件）。 */
async function scanInstructions(soulFile, detection, roots, signal) {
  const out = []
  if (signal?.aborted) return out
  let info
  try {
    info = await stat(assertAllowedRead(roots, soulFile), { ...(signal ? { signal } : {}) })
  } catch (err) {
    if (isMissingError(err)) return out
    if (signal?.aborted) throw err
    recordError(detection, 'instructions:' + soulFile, err)
    return out
  }
  let content
  try {
    content = await readFile(assertAllowedRead(roots, soulFile), { encoding: 'utf8', ...(signal ? { signal } : {}) })
  } catch (err) {
    if (signal?.aborted) throw err
    recordError(detection, 'instructions:' + soulFile, err)
    return out
  }
  out.push({
    id: 'SOUL.md',
    file: soulFile,
    kind: 'daedalus-soul',
    bytes: info.size,
    digest: digestText(content),
  })
  return out
}

/**
 * 只读扫描 Daedalus 数据根（白名单内）。
 * @param home - Daedalus 数据根。
 * @param opts - { signal, maxSessionBytes }。
 * @returns 检测清单（sessions/skills/memories/instructions/errors）。
 */
export async function detect(home, { signal, maxSessionBytes = DEFAULT_SESSION_MAX_BYTES } = {}) {
  const detection = emptyDetection(source, home)
  const roots = whitelist(home)
  const [sessionsRoot, skillsRoot, memoriesRoot, soulFile] = roots
  detection.homeExists = existsSync(home)
  detection.sessions = await scanSessions(sessionsRoot, detection, roots, maxSessionBytes, signal)
  detection.skills = await walkSkills(skillsRoot, detection, roots, signal)
  detection.memories = await scanMemories(memoriesRoot, detection, roots, signal)
  detection.instructions = await scanInstructions(soulFile, detection, roots, signal)
  return detection
}
