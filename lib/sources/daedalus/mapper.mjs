// SPDX-License-Identifier: Apache-2.0
// lib/sources/daedalus/mapper.mjs — Daedalus 源映射器（五源迁移向导，纯函数）。
//
// 清单 → 迁移计划：
//   - sessions → import-session（daedalus/convert.mjs 转换，provider 'daedalus'；
//     幂等走 imports.json，按 turns 增量续写）。
//   - skills → copy（兼容）或 convert-copy（不兼容，补合成 frontmatter）。
//   - memories（MEMORY.md / USER.md）→ append-section（AGENTS.md 管理段）。
//   - instructions（SOUL.md）→ append-section。

import { readFileSync } from 'node:fs'
import { assertAllowedRead, planKey } from '../contract.mjs'
import { defaultAgentsMdPath } from '../../agmd-section.mjs'
import { skillTargetPath, kebabName } from '../../skill-migrate.mjs'
import { whitelist } from './parser.mjs'

/**
 * 映射 Daedalus 检测清单为迁移计划。
 * @param source - 'daedalus'。
 * @param detection - daedalus/parser.mjs 的 detect() 输出。
 * @param opts - { skillsDir, agentsMdPath }。
 * @returns { plans, errors }。
 */
export function mapSource(source, detection, opts = {}) {
  const plans = []
  const errors = []
  const agentsMdPath = opts.agentsMdPath ?? defaultAgentsMdPath()
  const skillsDir = opts.skillsDir
  const roots = whitelist(detection.home)

  for (const session of detection.sessions ?? []) {
    plans.push({
      key: planKey(source, 'session', session.id),
      from: source,
      kind: 'session',
      action: 'import-session',
      provider: source,
      source: { file: session.file, sessionId: session.id, turns: session.turns, importKey: session.file },
      target: {},
      title: session.title,
      ...(session.model ? { model: session.model } : {}),
    })
  }

  for (const skill of detection.skills ?? []) {
    plans.push({
      key: planKey(source, 'skill', skill.id),
      from: source,
      kind: 'skill',
      action: skill.compatible ? 'copy' : 'convert-copy',
      source: { file: skill.file, dir: skill.dir, name: skill.name },
      target: skillsDir ? { path: skillTargetPath(skillsDir, kebabName(skill.name)) } : {},
      digest: skill.digest,
    })
  }

  for (const memory of detection.memories ?? []) {
    try {
      const content = readFileSync(assertAllowedRead(roots, memory.file), 'utf8')
      plans.push({
        key: planKey(source, 'memory', memory.id),
        from: source,
        kind: 'memory',
        action: 'append-section',
        source: { file: memory.file, kind: memory.kind },
        target: { path: agentsMdPath },
        content,
        digest: memory.digest,
      })
    } catch (err) {
      errors.push('memory:' + memory.file + ': ' + String((err && err.message) || err))
    }
  }

  for (const instruction of detection.instructions ?? []) {
    try {
      const content = readFileSync(assertAllowedRead(roots, instruction.file), 'utf8')
      plans.push({
        key: planKey(source, 'instruction', instruction.id),
        from: source,
        kind: 'instruction',
        action: 'append-section',
        source: { file: instruction.file, kind: instruction.kind },
        target: { path: agentsMdPath },
        content,
        digest: instruction.digest,
      })
    } catch (err) {
      errors.push('instruction:' + instruction.file + ': ' + String((err && err.message) || err))
    }
  }

  return { plans, errors }
}
