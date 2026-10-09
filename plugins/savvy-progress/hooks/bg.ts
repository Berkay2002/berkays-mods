// Background sessions (`claude --bg`) for the agents panel. Plugins cannot import each other, so these
// helpers are copies: parseAgents from plugins/workers/hooks/lib.ts, split and bgLaunches from
// plugins/effort-gate/hooks/register.ts (route-ledger carries the same parser).

import type { BgState } from '../types'

/** One entry of `claude agents --json`. `status` is busy/idle/waiting, `state` working/done/blocked; either may be absent. */
export type AgentEntry = {
  pid?: number
  cwd: string
  kind?: string
  sessionId: string
  name: string
  status?: string
  state?: string
}

export const parseAgents = (stdout: string): AgentEntry[] => {
  try {
    const list: unknown = JSON.parse(stdout)
    if (!Array.isArray(list)) return []
    return list.filter(
      (a): a is AgentEntry =>
        typeof a === 'object' && a !== null && typeof a.sessionId === 'string' && typeof a.name === 'string',
    )
  } catch {
    return []
  }
}

/** Waiting for you beats busy; a session that reports a status is read by it, one that does not by its state. */
export const bgState = (a: AgentEntry): BgState =>
  a.status === 'waiting' || a.state === 'blocked'
    ? 'waiting'
    : a.status === 'busy' || (a.status === undefined && a.state === 'working')
      ? 'busy'
      : 'idle'

// ---- reading `claude ... --bg` out of a shell command ----

type Tok = { text: string; quoted: boolean } // quoted: the word began inside quotes (a prompt, never a flag)

// Splits a command into segments (at unquoted ; | & newline) of words (at unquoted whitespace).
// ponytail: no heredocs, backticks, $(...) or backslash escapes outside quotes; an odd apostrophe swallows the rest, which only hides flags.
function split(cmd: string): Tok[][] {
  const segs: Tok[][] = [[]]
  let cur = ''
  let has = false
  let startQ = false
  let q: string | null = null
  const word = () => {
    if (has) segs[segs.length - 1]!.push({ text: cur, quoted: startQ })
    cur = ''
    has = false
    startQ = false
  }
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!
    if (q) {
      if (c === q) q = null
      else if (c === '\\' && q === '"' && cmd[i + 1] === '"') cur += cmd[++i]
      else cur += c
    } else if (c === '"' || c === "'") {
      if (!has) startQ = true
      has = true
      q = c
    } else if (c === '\n' || c === ';' || c === '|' || c === '&') {
      word()
      if (segs[segs.length - 1]!.length) segs.push([])
    } else if (/\s/.test(c)) word()
    else {
      cur += c
      has = true
    }
  }
  word()
  return segs.filter(s => s.length)
}

/** What a `claude --bg` launch asked for. */
export type Launch = { model?: string; effort?: string; agent?: string; name?: string }

const VALUE_FLAGS: Record<string, keyof Launch> = {
  '--model': 'model',
  '--effort': 'effort',
  '--agent': 'agent',
  '--name': 'name',
  '-n': 'name',
}

const SHELL = /^(?:(?:ba|z|da|k|c)?sh|pwsh|powershell|cmd)(?:\.exe)?$/i

// Every `claude ... --bg/--background` segment. `claude` must be the segment's command word (after FOO=bar
// assignments; a path ending in claude or claude.exe is fine); flags are read only from unquoted words, and a
// quoted word counts only as the value right after a flag that takes one. `sh -c "..."` is read inside.
export function bgLaunches(cmd: string): Launch[] {
  const out: Launch[] = []
  for (const seg of split(cmd)) {
    let i = 0
    while (i < seg.length && !seg[i]!.quoted && /^[A-Za-z_]\w*=/.test(seg[i]!.text)) i++
    const word = seg[i]?.text.split(/[\\/]/).pop() ?? ''
    if (SHELL.test(word)) {
      const k = seg.findIndex((t, n) => n > i && !t.quoted && /^(?:-[a-z]*c|-command|\/c)$/i.test(t.text))
      if (k >= 0) {
        const rest = seg.slice(k + 1)
        out.push(...bgLaunches(rest.length === 1 ? rest[0]!.text : rest.map(t => (t.quoted ? JSON.stringify(t.text) : t.text)).join(' ')))
      }
      continue
    }
    if (!/^claude(?:\.(?:exe|cmd|ps1))?$/i.test(word)) continue
    const found: Launch = {}
    let bg = false
    for (let j = i + 1; j < seg.length; j++) {
      const t = seg[j]!
      if (t.quoted) continue
      if (t.text === '--') break
      const m = /^(--[a-z-]+|-n)(?:=(.*))?$/i.exec(t.text)
      if (!m) continue
      if (m[1] === '--bg' || m[1] === '--background') {
        bg = true
        continue
      }
      const key = VALUE_FLAGS[m[1]!.toLowerCase()]
      if (!key) continue
      let v = m[2]
      const next = seg[j + 1]
      if (v === undefined && next && (next.quoted || !next.text.startsWith('-'))) {
        v = next.text
        j++
      }
      if (v !== undefined) found[key] = v
    }
    if (bg) out.push(found)
  }
  return out
}

// ---- which sessions belong to this repository ----

export type Worktree = { path: string; branch: string | null }

/** `git worktree list --porcelain`: blocks of `worktree <path>` / `branch refs/heads/<name>`. */
export const parseWorktrees = (porcelain: string): Worktree[] =>
  porcelain
    .split(/\r?\n\r?\n/)
    .map(block => ({
      path: /^worktree (.+)$/m.exec(block)?.[1]?.trim() ?? '',
      branch: /^branch refs\/heads\/(.+)$/m.exec(block)?.[1]?.trim() ?? null,
    }))
    .filter(w => w.path)

// Windows and git disagree on slashes, and on case; compare in one spelling.
const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

const worktreeOf = (cwd: string, trees: Worktree[]): Worktree | undefined => {
  const c = norm(cwd)
  return trees
    .filter(w => c === norm(w.path) || c.startsWith(norm(w.path) + '/'))
    .sort((a, b) => b.path.length - a.path.length)[0]
}

/** Related: launched from this session (by name), or running in a worktree of this repository. */
export const isRelated = (a: AgentEntry, trees: Worktree[], launched: Record<string, Launch>): boolean =>
  a.name.toLowerCase() in launched || worktreeOf(a.cwd, trees) !== undefined

/** The branch checked out where the session runs, from the one worktree list per poll. */
export const branchOf = (a: AgentEntry, trees: Worktree[]): string | undefined => worktreeOf(a.cwd, trees)?.branch ?? undefined

// ---- crab and label ----

const CREW = ['scout', 'builder', 'reviewer']

/** `--agent scout|builder|reviewer` picks that crab; else the model's family: haiku scout, sonnet builder, opus reviewer. */
export const tierFor = (l?: Launch): string => {
  const agent = l?.agent?.replace(/^[^:]*:/, '').toLowerCase() ?? ''
  if (CREW.includes(agent)) return agent
  const m = l?.model?.toLowerCase() ?? ''
  return /haiku/.test(m) ? 'scout' : /sonnet/.test(m) ? 'builder' : /opus/.test(m) ? 'reviewer' : 'other'
}

/** `sonnet` -> `Sonnet`; a full id is left to the caller's modelName. */
export const aliasLabel = (model: string): string | undefined =>
  /^[a-z]+$/i.test(model) ? model.charAt(0).toUpperCase() + model.slice(1).toLowerCase() : undefined
