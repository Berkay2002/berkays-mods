import type { Contact, Worker } from '../types'

/** One entry of `claude agents --json`. */
export type AgentEntry = {
  pid: number
  cwd: string
  kind?: string
  sessionId: string
  name: string
  status: string
  waitingFor?: string
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

/** `uds:/tmp/cc-socks/16932.sock` -> `pid:16932`; a plain name stays itself. */
export const contactKey = (address: string): string => {
  const sock = /cc-socks\/(\d+)\.sock/.exec(address)
  return sock ? `pid:${sock[1]}` : address.trim()
}

/**
 * Who sent a cross-session message, read off its envelope:
 * `<cross-session-message from="uds:..." from-name="brf-app-reading" ...>`.
 */
export const senderOf = (text: string): string | null => {
  const name = /from-name="([^"]+)"/.exec(text)
  if (name?.[1]) return name[1]
  const from = /from="([^"]+)"/.exec(text)?.[1]
  return from && from !== '...' ? contactKey(from) : null
}

/** The message body without the envelope tags, on one line. */
export const bodyOf = (text: string): string =>
  text
    .replace(/<\/?cross-session-message[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

export const asksForYou = (body: string): boolean =>
  /\b(approve|approval|decision|decide|blocked|waiting for)\b/i.test(body) || /\?\s*$/.test(body)

export const contactFor = (
  contacts: Record<string, Contact>,
  agent: { name: string; pid: number },
): Contact | undefined => {
  const byName = contacts[agent.name]
  const byPid = contacts[`pid:${agent.pid}`]
  if (byName && byPid) return byName.at >= byPid.at ? byName : byPid
  return byName ?? byPid
}

export const stateOf = (status: string): string =>
  status === 'busy' ? 'running' : status === 'waiting' ? 'blocked' : status

/**
 * A worker: a session this one has messaged or heard from, or one running
 * in a worktree of this session's repository.
 */
export const isWorker = (
  agent: AgentEntry,
  contacts: Record<string, Contact>,
  repoRoot: string | null,
): boolean =>
  contactFor(contacts, agent) !== undefined ||
  (repoRoot !== null && agent.cwd.startsWith(`${repoRoot}/.claude/worktrees/`))

export const age = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

/** Cuts to `width` cells, ending in … when cut. */
export const cut = (text: string, width: number): string =>
  width <= 0 ? '' : text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1)).trimEnd()}…`

/** The one glyph and theme color a worker shows, by what it needs. */
export type Look = { glyph: string; color?: string; dim: boolean; rank: number; label: string }

export const lookOf = (w: Worker, c: Contact | undefined): Look => {
  if (w.state === 'gone') return { glyph: '✕', color: 'error', dim: false, rank: 3, label: 'gone' }
  if (w.state === 'blocked' && w.waitingFor && /limit/i.test(w.waitingFor))
    return { glyph: '⏸', dim: false, rank: 1, label: 'paused by limit' }
  if (c?.needsYou || w.state === 'blocked')
    return { glyph: '▲', color: 'warning', dim: false, rank: 0, label: 'needs you' }
  if (w.state === 'running') return { glyph: '●', color: 'success', dim: false, rank: 1, label: 'running' }
  return { glyph: '○', dim: true, rank: 2, label: w.state }
}

export const sortWorkers = (list: Worker[], contacts: Record<string, Contact>): Worker[] =>
  [...list].sort((a, b) => {
    const ra = lookOf(a, contactFor(contacts, a)).rank
    const rb = lookOf(b, contactFor(contacts, b)).rank
    if (ra !== rb) return ra - rb
    const ta = contactFor(contacts, a)?.at ?? 0
    const tb = contactFor(contacts, b)?.at ?? 0
    return tb - ta || a.name.localeCompare(b.name)
  })

/** "4 workers · 2 running · 1 needs you", zero parts left out. */
export const summaryOf = (list: Worker[], contacts: Record<string, Contact>, noun = 'worker'): string => {
  const looks = list.map(w => lookOf(w, contactFor(contacts, w)))
  const count = (rank: number) => looks.filter(l => l.rank === rank && l.label !== 'paused by limit').length
  const parts = [`${list.length} ${noun}${list.length === 1 ? '' : 's'}`]
  const running = looks.filter(l => l.label === 'running').length
  const needs = count(0)
  const paused = looks.filter(l => l.label === 'paused by limit').length
  const gone = count(3)
  if (running) parts.push(`${running} running`)
  if (needs) parts.push(`${needs} need${needs === 1 ? 's' : ''} you`)
  if (paused) parts.push(`${paused} paused`)
  if (gone) parts.push(`${gone} gone`)
  return parts.join(' · ')
}

/** "worktree-ui +3 ~2": ahead and dirty counts, zeros left out. */
export const gitOf = (w: Worker): string =>
  w.branch === null ? '' : [w.branch, w.ahead ? `+${w.ahead}` : '', w.dirty ? `~${w.dirty}` : ''].filter(Boolean).join(' ')

/** The second line: the last message with its age, or what the session waits for. */
export const lastOf = (w: Worker, c: Contact | undefined, now: number, width: number): string => {
  const waiting = w.state === 'blocked' && w.waitingFor ? `waiting: ${w.waitingFor}` : ''
  if (!c) return cut(waiting || 'No messages yet', width)
  const when = ` · ${age(now - c.at)}`
  const body = `${c.dir === 'in' ? '' : 'you: '}${c.text}`
  return cut(body, width - when.length) + when
}
