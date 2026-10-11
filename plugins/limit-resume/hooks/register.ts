import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit, Timer } from 'claude-code'

const tail = atom({ plugin: 'limit-resume', key: 'tail' } as const, '')

const RESUME_TEXT = 'Continue. The usage limit has reset.'
const NUDGE_TEXT = 'Usage limit has reset. Continue your task.'
// Wait a minute past the reset so the first request lands in the new window (the default; usage-window.json can change it).
const GRACE_MS = 60_000
// When a turn dies on a rate limit but no window reports a reset time, try again this much later.
const UNKNOWN_RESET_MS = 30 * 60_000
// The hint tail stays empty below this 5h percentage.
const WARN_PERCENT = 80
const MINUTE = 60_000
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// isPause: the 5h window reached usage-window.json's pausePercent before the engine cut the session.
type Pending = { cutAt: number; resetsAt: number; isGuessed: boolean; isPause?: boolean }
// ~/.claude/usage-window.json, machine-local and optional; every field is optional.
type UsageWindow = {
  warnPercent: number | null
  pausePercent: number
  resumeDelayMs: number
  until: number | null
  untilText: string
  peers: string[]
}
// warnedFor: the 5h reset whose window already had its warnPercent toast.
type Saved = { pending: Pending | null; handled: number[]; workers: string[]; warnedFor?: number }
type Agent = { pid?: number; sessionId?: string; name?: string; status?: string }

// Module state: starts over on a reload; what must survive one lives in $.store.
let sessionId = ''
let limits: readonly SessionRateLimit[] = []
let saved: Saved = { pending: null, handled: [], workers: [] }
let timer: Timer | undefined
let ticker: Timer | undefined
let isBusy = false
let lastAnswerAt = 0
// Re-read from disk on every event that uses it, so edits apply without a restart. null: no file, today's behaviour.
let usageWindow: UsageWindow | null = null
let paths: { config: string; limits: string; isWindows: boolean } | undefined
let lastPublished = ''

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

const slash = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')

async function locate($: EngineInterface) {
  if (paths) return paths
  const orEmpty = (v: Promise<string | undefined>) => v.then(s => s ?? '', () => '')
  const isWindows = (await orEmpty($.env.get('OS'))) === 'Windows_NT'
  const userProfile = await orEmpty($.env.get('USERPROFILE'))
  const homeVar = await orEmpty($.env.get('HOME'))
  // `||`: an empty variable falls through. On Windows HOME can be a network drive; USERPROFILE is the real one.
  const home = slash(isWindows ? userProfile || homeVar : homeVar || userProfile)
  if (!home) return undefined
  paths = { config: `${home}/.claude/usage-window.json`, limits: `${home}/.claude/usage/limits.json`, isWindows }
  return paths
}

function parseWindow(text: string): UsageWindow | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
  const until = typeof o.until === 'string' ? Date.parse(o.until) : NaN
  return {
    warnPercent: num(o.warnPercent) ?? null,
    pausePercent: Math.min(100, Math.max(1, num(o.pausePercent) ?? 100)),
    resumeDelayMs: Math.max(0, num(o.resumeDelayMinutes) ?? GRACE_MS / MINUTE) * MINUTE,
    until: Number.isNaN(until) ? null : until,
    untilText: Number.isNaN(until) ? '' : String(o.until),
    peers: Array.isArray(o.peers) ? o.peers.filter((p): p is string => typeof p === 'string' && p !== '') : [],
  }
}

// Reads the config again; a scheduled resume moves with an edited delay.
async function loadWindow($: EngineInterface) {
  const where = await locate($)
  const text = where
    ? await $.fs.read(where.config).then(
        t => (typeof t === 'string' ? t : null),
        () => null,
      )
    : null
  const before = saved.pending ? resumeAt(saved.pending) : null
  usageWindow = text === null ? null : parseWindow(text)
  if (saved.pending && timer && before !== resumeAt(saved.pending)) await schedule($)
}

function windowEnded(now: number) {
  return usageWindow?.until != null && now >= usageWindow.until
}

function resumeAt(p: Pending) {
  return p.resetsAt + (usageWindow?.resumeDelayMs ?? GRACE_MS)
}

// The window ends before this resume would: nothing will fire.
function isPastUntil(p: Pending) {
  return usageWindow?.until != null && resumeAt(p) >= usageWindow.until
}

// Under an hour away counts down; further out reads as a clock time.
function resumeLabel(p: Pending, now: number) {
  const left = resumeAt(p) - now
  if (isPastUntil(p)) return `no resume · window ends ${when(usageWindow!.until!, now)}`
  if (p.isGuessed) return `retries ~${hhmm(resumeAt(p))}`
  return left < 60 * MINUTE ? `resumes in ${duration(left)}` : `resumes ${when(resumeAt(p), now)}`
}

async function refreshStatus($: EngineInterface) {
  const now = await $.clock.now()
  const p = saved.pending
  if (p) {
    const n = saved.workers.length
    // A pause is a real alert: it keeps the pinned notice, and the hint tail stays empty.
    $.ui.status(`⏸ ${p.isPause ? 'paused' : 'limit'} · ${resumeLabel(p, now)}${n ? ` · ${plural(n, 'worker')}` : ''}`)
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

// The 5h window at or past usage-window.json's pausePercent (below 100): pause before the engine cuts.
function pauseReset(rows: readonly SessionRateLimit[]) {
  const pausePercent = usageWindow?.pausePercent ?? 100
  if (pausePercent >= 100) return null
  const five = rows.find(r => r.kind === 'five_hour')
  return five && five.percentUsed >= pausePercent ? resetOf(five) : null
}

async function markCut($: EngineInterface, isRateLimitError: boolean) {
  const now = await $.clock.now()
  let resetsAt = exhaustedReset(limits)
  let isGuessed = false
  let isPause = false
  if (resetsAt === null) {
    resetsAt = pauseReset(limits)
    isPause = resetsAt !== null
  }
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
  const pending: Pending = isPause ? { cutAt: now, resetsAt, isGuessed, isPause } : { cutAt: now, resetsAt, isGuessed }
  saved = { ...saved, pending }
  await save($)
  await schedule($)
  if (isFirstHit) {
    const five = limits.find(r => r.kind === 'five_hour')
    const head = isPause ? `Usage window: 5h at ${five?.percentUsed ?? '?'}% · pausing` : 'Usage limit reached'
    const resume = isPastUntil(pending)
      ? `no resume, the window ends ${hhmm(usageWindow!.until!)}`
      : `${isGuessed ? 'retrying around' : 'resuming at'} ${hhmm(resumeAt(pending))}`
    $.ui.toast(`${head} · ${resume}`)
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

  // The run is over: no resume and no nudges after usage-window.json's `until`.
  await loadWindow($)
  if (windowEnded(await $.clock.now())) {
    await refreshStatus($)
    $.ui.toast(`Usage window ended at ${usageWindow!.untilText}: not resuming`)
    return
  }

  // Someone already got this session going again after the cut: leave it alone.
  // After a pause Claude answers once more (stopping its workers), so only a running turn counts there.
  const isResumed = isBusy || (!p.isPause && lastAnswerAt > p.cutAt)
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

function isNearLimit(five: SessionRateLimit | undefined) {
  const warn = usageWindow?.warnPercent
  return warn != null && five !== undefined && five.percentUsed >= warn
}

// The 5h window reached warnPercent: one toast per window (per 5h reset).
async function warnIfNear($: EngineInterface) {
  const five = limits.find(r => r.kind === 'five_hour')
  if (saved.pending || !isNearLimit(five)) return
  const reset = resetOf(five) ?? 0
  if (saved.warnedFor === reset) return
  saved = { ...saved, warnedFor: reset }
  await save($)
  $.ui.toast(`Usage window: 5h at ${five!.percentUsed}% · warn peers (near limit)`)
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

// The usage-window line of the note for Claude: none without a config.
function windowLine(rows: readonly SessionRateLimit[], now: number) {
  const w = usageWindow
  if (!w) return null
  if (windowEnded(now)) return `Usage window ended at ${w.untilText}: stop all work and workers.`
  const five = rows.find(r => r.kind === 'five_hour')
  const peers = w.peers.length ? ` Peers: ${w.peers.join(', ')}.` : ''
  const p = saved.pending
  if (p?.isPause) {
    const resume = isPastUntil(p)
      ? `no auto-resume, the window ends at ${w.untilText}`
      : `auto-resume at ${hhmm(resumeAt(p))}`
    return `Usage window: 5h at ${five?.percentUsed ?? '?'}% (pause at ${w.pausePercent}%). Pause now: stop your workers and peers per the Usage window rule in CLAUDE.md; ${resume}.${peers}`
  }
  if (isNearLimit(five)) return `Usage window: 5h at ${five!.percentUsed}%, warn peers (NEAR LIMIT) per CLAUDE.md.${peers}`
  const until = w.until === null ? '' : `, ends ${when(w.until, now)}`
  return `Usage window: pause at ${w.pausePercent}% of 5h${until}.${peers}`
}

// The active window, for /limits.
function windowReport(now: number) {
  const w = usageWindow
  if (!w) return null
  if (windowEnded(now)) return `Window ended ${when(w.until!, now)} · no auto-resume`
  const parts = [
    ...(w.warnPercent === null ? [] : [`Window: warn at ${w.warnPercent}%`]),
    `${w.warnPercent === null ? 'Window: pause' : 'pause'} at ${w.pausePercent}%`,
    `resume reset +${duration(w.resumeDelayMs)}`,
  ]
  if (w.until !== null) parts.push(`ends ${when(w.until, now)}`)
  if (w.peers.length) parts.push(`peers ${w.peers.join(', ')}`)
  return parts.join(' · ')
}

// ~/.claude/usage/limits.json, for other sessions and scripts: a tmp file, then a rename over the old one.
async function publish($: EngineInterface, rows: readonly SessionRateLimit[]) {
  const where = await locate($)
  if (!where) return
  const row = (kind: SessionRateLimit['kind']) => {
    const r = rows.find(x => x.kind === kind)
    return r ? { percentUsed: r.percentUsed, resetsAt: r.resetsAt ?? null } : null
  }
  const body = { fiveHour: row('five_hour'), week: row('seven_day') }
  if (!body.fiveHour && !body.week) return
  const unchanged = JSON.stringify(body)
  if (unchanged === lastPublished) return
  lastPublished = unchanged
  const text = `${JSON.stringify({ ...body, updatedAt: new Date(await $.clock.now()).toISOString() }, null, 2)}\n`
  const tmp = `${where.limits}.${sessionId || 'session'}.tmp`
  try {
    await $.fs.write(tmp, text)
    const native = (p: string) => p.replace(/\//g, '\\')
    const argv = where.isWindows
      ? ['cmd', '/c', 'move', '/y', native(tmp), native(where.limits)]
      : ['mv', '-f', tmp, where.limits]
    const { exitCode } = await $.process.run(argv, { timeoutMs: 5_000 })
    // The rename failed: a plain write still beats a stale file.
    if (exitCode !== 0) await $.fs.write(where.limits, text)
  } catch {
    lastPublished = ''
  }
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
  const w = windowReport(now)
  if (w) lines.push(w)
  return lines.join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    sessionId = await $.session.id()
    const stored = (await $.store.get(key())) as Saved | undefined
    if (stored && Array.isArray(stored.handled) && Array.isArray(stored.workers)) saved = stored
    limits = (await $.session.usage()).rateLimits
    await loadWindow($)
    await publish($, limits)
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
    await loadWindow($)
    await publish($, limits)
    return { text: limitsReport(limits, await $.clock.now()) }
  })

  on('session.measure', async ($, e, next) => {
    limits = e.rateLimits
    if (e.changed.includes('rateLimits')) {
      await loadWindow($)
      await publish($, limits)
      await markCut($, false)
      await warnIfNear($)
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
    const rows = (await $.session.usage()).rateLimits
    await loadWindow($)
    const lines = [usageLine(rows), windowLine(rows, await $.clock.now())].filter((l): l is string => l !== null)
    return lines.length ? next({ ...e, context: [...(e.context ?? []), ...lines] }) : next(e)
  })
}
