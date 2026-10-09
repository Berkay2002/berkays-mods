import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit, Timer } from 'claude-code'

const tail = atom({ plugin: 'limit-resume', key: 'tail' } as const, '')

const RESUME_TEXT = 'Continue. The usage limit has reset.'
const NUDGE_TEXT = 'Usage limit has reset. Continue your task.'
// Wait a minute past the reset so the first request lands in the new window.
const GRACE_MS = 60_000
// When a turn dies on a rate limit but no window reports a reset time, try again this much later.
const UNKNOWN_RESET_MS = 30 * 60_000
// The hint tail stays empty below this 5h percentage.
const WARN_PERCENT = 80
const MINUTE = 60_000
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

type Pending = { cutAt: number; resetsAt: number; isGuessed: boolean }
type Saved = { pending: Pending | null; handled: number[]; workers: string[] }
type Agent = { pid?: number; sessionId?: string; name?: string; status?: string }

// Module state: starts over on a reload; what must survive one lives in $.store.
let sessionId = ''
let limits: readonly SessionRateLimit[] = []
let saved: Saved = { pending: null, handled: [], workers: [] }
let timer: Timer | undefined
let ticker: Timer | undefined
let isBusy = false
let lastAnswerAt = 0

function key() {
  return `session:${sessionId}`
}

function save($: EngineInterface) {
  return $.store.set(key(), saved)
}

function hhmm(ms: number) {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// "15:04" today, "Tue 09:00" on another day.
function when(ms: number, now: number) {
  const isToday = new Date(ms).toDateString() === new Date(now).toDateString()
  return isToday ? hhmm(ms) : `${DAYS[new Date(ms).getDay()]} ${hhmm(ms)}`
}

function duration(ms: number) {
  const minutes = Math.max(1, Math.ceil(ms / MINUTE))
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

function resetOf(row: SessionRateLimit | undefined) {
  const t = row?.resetsAt ? Date.parse(row.resetsAt) : NaN
  return Number.isNaN(t) ? null : t
}

function resumeAt(p: Pending) {
  return p.resetsAt + GRACE_MS
}

// Under an hour away counts down; further out reads as a clock time.
function resumeLabel(p: Pending, now: number) {
  const left = resumeAt(p) - now
  if (p.isGuessed) return `retries ~${hhmm(resumeAt(p))}`
  return left < 60 * MINUTE ? `resumes in ${duration(left)}` : `resumes ${when(resumeAt(p), now)}`
}

async function refreshStatus($: EngineInterface) {
  const now = await $.clock.now()
  const p = saved.pending
  if (p) {
    const n = saved.workers.length
    // A pause is a real alert: it keeps the pinned notice, and the hint tail stays empty.
    $.ui.status(`⏸ limit · ${resumeLabel(p, now)}${n ? ` · ${plural(n, 'worker')}` : ''}`)
    await update($, tail, () => '')
    return
  }
  // Clears a pause notice left from before the resume.
  $.ui.status(undefined)
  const five = limits.find(r => r.kind === 'five_hour')
  if (!five || five.percentUsed < WARN_PERCENT) {
    await update($, tail, () => '')
    return
  }
  const reset = resetOf(five)
  await update($, tail, () => `5h ${five.percentUsed}%${reset === null ? '' : ` · resets ${when(reset, now)}`}`)
}

async function schedule($: EngineInterface) {
  const p = saved.pending
  if (!p) return
  timer?.cancel()
  ticker?.cancel()
  const delay = Math.max(0, resumeAt(p) - (await $.clock.now()))
  timer = $.clock.after(delay, () => void fire($))
  ticker = $.clock.every(MINUTE, () => void refreshStatus($))
  await refreshStatus($)
}

// The window that is used up and resets last decides when work can go on.
function exhaustedReset(rows: readonly SessionRateLimit[]) {
  const times = rows
    .filter(r => r.percentUsed >= 100)
    .map(resetOf)
    .filter((t): t is number => t !== null)
  return times.length ? Math.max(...times) : null
}

async function markCut($: EngineInterface, isRateLimitError: boolean) {
  const now = await $.clock.now()
  let resetsAt = exhaustedReset(limits)
  let isGuessed = false
  if (resetsAt === null) {
    if (!isRateLimitError) return
    const fiveHour = resetOf(limits.find(r => r.kind === 'five_hour'))
    if (fiveHour !== null && fiveHour > now) {
      resetsAt = fiveHour
    } else {
      resetsAt = now + UNKNOWN_RESET_MS
      isGuessed = true
    }
  }
  if (saved.handled.includes(resetsAt)) return
  if (saved.pending && (saved.pending.resetsAt === resetsAt || (!isGuessed && saved.pending.resetsAt > resetsAt))) return
  const isFirstHit = saved.pending === null
  saved = { ...saved, pending: { cutAt: now, resetsAt, isGuessed } }
  await save($)
  await schedule($)
  if (isFirstHit) {
    $.ui.toast(`Usage limit reached · ${isGuessed ? 'retrying around' : 'resuming at'} ${hhmm(resetsAt + GRACE_MS)}`)
  }
}

async function listAgents($: EngineInterface): Promise<Agent[]> {
  try {
    const { exitCode, stdout } = await $.process.run(['claude', 'agents', '--json'], { timeoutMs: 15_000 })
    if (exitCode !== 0) return []
    const parsed: unknown = JSON.parse(stdout)
    return Array.isArray(parsed) ? (parsed as Agent[]) : []
  } catch {
    return []
  }
}

// A recipient is spelled as SendMessage spells it: a session name, a session id, or a uds:/.../<pid>.sock address.
function findAgent(agents: Agent[], address: string) {
  const pid = /cc-socks\/(\d+)\.sock/.exec(address)?.[1]
  return agents.find(
    a => a.name === address || a.sessionId === address || (pid !== undefined && String(a.pid) === pid),
  )
}

async function fire($: EngineInterface) {
  const p = saved.pending
  if (!p || saved.handled.includes(p.resetsAt)) return
  timer = undefined
  ticker?.cancel()
  ticker = undefined
  saved = { ...saved, pending: null, handled: [...saved.handled, p.resetsAt].slice(-20) }
  await save($)

  // Someone already got this session going again after the cut: leave it alone.
  const isResumed = isBusy || lastAnswerAt > p.cutAt
  if (!isResumed) {
    void $.prompt.submit({ text: RESUME_TEXT }).catch(() => undefined)
  }

  let nudged = 0
  if (saved.workers.length) {
    const agents = await listAgents($)
    const seen = new Set<string>()
    for (const address of saved.workers) {
      const agent = findAgent(agents, address)
      if (!agent?.sessionId || agent.sessionId === sessionId || seen.has(agent.sessionId)) continue
      seen.add(agent.sessionId)
      if (agent.status !== 'idle') continue
      const sent = await $.session.send({ to: { sessionId: agent.sessionId }, text: NUDGE_TEXT }).catch(() => null)
      if (sent?.isDelivered) nudged += 1
    }
  }

  await refreshStatus($)
  const head = isResumed ? 'Already running' : 'Resumed'
  $.ui.toast(nudged ? `${head} · ${plural(nudged, 'worker')} nudged` : head)
}

async function addWorker($: EngineInterface, address: string) {
  if (!address || saved.workers.includes(address)) return
  saved = { ...saved, workers: [...saved.workers, address].slice(-30) }
  await save($)
  if (saved.pending) await refreshStatus($)
}

function usageLine(rows: readonly SessionRateLimit[]) {
  const five = rows.find(r => r.kind === 'five_hour')
  const week = rows.find(r => r.kind === 'seven_day')
  if (!five && !week) return null
  const parts: string[] = []
  if (five) {
    const reset = resetOf(five)
    parts.push(`5h ${five.percentUsed}%${reset === null ? '' : ` (resets ${hhmm(reset)})`}`)
  }
  if (week) parts.push(`week ${week.percentUsed}%`)
  return `Usage: ${parts.join(', ')}`
}

function limitsReport(rows: readonly SessionRateLimit[], now: number) {
  const lines: string[] = []
  for (const [kind, label] of [['five_hour', '5h'], ['seven_day', 'Week']] as const) {
    const row = rows.find(r => r.kind === kind)
    if (!row) continue
    const reset = resetOf(row)
    lines.push(`${label} ${row.percentUsed}%${reset === null ? '' : ` · resets ${when(reset, now)}`}`)
  }
  if (!lines.length) lines.push('No usage reading yet')
  const p = saved.pending
  const n = saved.workers.length
  lines.push(
    p
      ? `⏸ ${resumeLabel(p, now)}${n ? ` · ${plural(n, 'worker')} to nudge` : ''}`
      : `No resume pending${n ? ` · ${plural(n, 'worker')} known` : ''}`,
  )
  return lines.join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    sessionId = await $.session.id()
    const stored = (await $.store.get(key())) as Saved | undefined
    if (stored && Array.isArray(stored.handled) && Array.isArray(stored.workers)) saved = stored
    limits = (await $.session.usage()).rateLimits
    await $.command.register({ name: 'limits', description: 'Show usage windows and any pending resume', immediate: true })
    if (saved.pending && !saved.handled.includes(saved.pending.resetsAt)) await schedule($)
    else await refreshStatus($)
    return next(e)
  })

  // The 5h reading rides the hint line as a dim tail, after any tail another hook already set.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const line = await read($, tail)
    if (!line) return next(e)
    return next({ ...e, props: { ...e.props, tail: e.props.tail ? `${e.props.tail} · ${line}` : line } })
  })

  on('command.run', { command: 'limits' }, async $ => {
    limits = (await $.session.usage()).rateLimits
    return { text: limitsReport(limits, await $.clock.now()) }
  })

  on('session.measure', async ($, e, next) => {
    limits = e.rateLimits
    if (e.changed.includes('rateLimits')) {
      await markCut($, false)
      if (!saved.pending) await refreshStatus($)
    }
    return next(e)
  })

  on('classic.StopFailure', async ($, e, next) => {
    if (e.error === 'rate_limit') await markCut($, true)
    return next(e)
  })

  on('turn.start', ($, e, next) => {
    isBusy = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      isBusy = false
      if (e.reason === 'answer') lastAnswerAt = await $.clock.now()
    }
    return next(e)
  })

  on('session.send', async ($, e, next) => {
    const result = await next(e)
    if (e.origin.kind === 'model' && e.agentId === undefined && result.isDelivered) await addWorker($, e.to)
    return result
  })

  on('session.receive', async ($, e, next) => {
    // Peer deliveries carry the sender in their envelope; best effort, the text format is the engine's.
    const from = e.agentId === undefined ? /from="([^"]+)"/.exec(e.text)?.[1] : undefined
    if (from) await addWorker($, from)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.turnId !== undefined) return next(e)
    const line = usageLine((await $.session.usage()).rateLimits)
    return line ? next({ ...e, context: [...(e.context ?? []), line] }) : next(e)
  })
}
