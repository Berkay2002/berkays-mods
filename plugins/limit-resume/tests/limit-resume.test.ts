import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, SessionRateLimit } from 'claude-code'

const NOW = Date.parse('2026-10-05T10:00:00Z')
const RESET = Date.parse('2026-10-05T12:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()

const AGENTS = [
  { pid: 1, sessionId: 'me', name: 'brf-orchestrator', status: 'idle' },
  { pid: 21428, sessionId: 'ui-id', name: 'brf-app-ui', status: 'idle' },
  { pid: 3, sessionId: 'pdf-id', name: 'brf-app-pdf', status: 'busy' },
]

const CONFIG = 'C:/Users/me/.claude/usage-window.json'
const LIMITS = 'C:/Users/me/.claude/usage/limits.json'
// The engine hands fs paths over in the host's separators.
const fwd = (p: string) => p.split('\\').join('/')

// config.value is ~/.claude/usage-window.json's content (undefined: no file); a test may change it between events.
function world(on: On, limits: SessionRateLimit[], stored?: Record<string, unknown>, config: { value?: unknown } = {}) {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, stored)
  mock.env(on, { USERPROFILE: 'C:\\Users\\me', OS: 'Windows_NT' })
  const files = new Map<string, string>()
  const seen = { status: [] as (string | undefined)[], tail: undefined as string | undefined, toasts: [] as string[], prompts: [] as string[], sends: [] as unknown[], files, moves: [] as string[][] }
  on('fs.read', (_$, e) => {
    if (fwd(e.path) === CONFIG && config.value !== undefined) return { value: JSON.stringify(config.value) }
    throw new Error('ENOENT')
  })
  on('fs.write', (_$, e) => {
    files.set(fwd(e.path), e.text)
    return { value: undefined }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'me' }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200000 }, rateLimits: limits } }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('classic.StopFailure', () => ({}))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.status', ($, e) => {
    seen.status.push(e.text)
    return { value: undefined }
  })
  // The engine's own hint line: records the tail it is handed.
  on('ui.render', { component: 'PromptHint' }, ($, e) => {
    seen.tail = e.props.tail
    return $.ui.resolve(e).Text({ children: [e.props.hint] })
  })
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('prompt.submit', ($, e) => {
    seen.prompts.push(e.text)
    return { text: e.text, context: e.context }
  })
  on('session.send', ($, e) => {
    seen.sends.push(e.to)
    return { isDelivered: true as const }
  })
  on('process.run', (_$, e) => {
    const argv = [...e.argv]
    if (argv[0] === 'cmd') {
      seen.moves.push(argv)
      const [from, to] = [fwd(argv[4] ?? ''), fwd(argv[5] ?? '')]
      files.set(to, files.get(from) ?? '')
      files.delete(from)
      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    return {
      value: { exitCode: 0, stdout: JSON.stringify(AGENTS), stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  return { clock, seen }
}

// The tail the engine's hint line would draw, given one a hook above already set.
async function tailOf($: Engine, seen: { tail?: string }, existing?: string) {
  seen.tail = undefined
  const ui = await $.ui.mount({
    plugin: 'limit-resume',
    surface: 'terminal',
    component: 'PromptHint',
    props: { isDraft: false, isWorking: false, hint: '? for shortcuts', ...(existing ? { tail: existing } : {}) },
  })
  await ui.unmount()
  return seen.tail
}

const start = ($: Engine) => $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
const measure = ($: Engine, rateLimits: SessionRateLimit[]) =>
  $.session.measure({ context: { window: 200000 }, rateLimits, changed: ['rateLimits'] })

const cut: SessionRateLimit[] = [
  { kind: 'five_hour', percentUsed: 100, resetsAt: iso(RESET) },
  { kind: 'seven_day', percentUsed: 61 },
]

test('resumes itself and nudges idle workers once after the reset', async ($, on) => {
  const { clock, seen } = world(on, [])
  await start($)
  for (const to of ['brf-app-ui', 'brf-app-pdf']) {
    await $.session.send({ to, text: 'hi', origin: { kind: 'model' } })
  }
  await measure($, cut)
  expect(seen.status.at(-1)).toMatch(/^⏸ limit · resumes \d\d:\d\d · 2 workers$/)
  // While paused the hint line carries nothing.
  expect(await tailOf($, seen)).toBeUndefined()
  expect(seen.toasts.at(-1)).toMatch(/^Usage limit reached · resuming at \d\d:\d\d$/)

  // Within the last hour the status counts down.
  await clock.set(RESET - 30 * 60_000)
  expect(seen.status.at(-1)).toBe('⏸ limit · resumes in 31m · 2 workers')

  await clock.set(RESET + 59_000)
  expect(seen.prompts).toEqual([])

  await clock.advance(2_000)
  expect(seen.prompts).toEqual(['Continue. The usage limit has reset.'])
  // The busy worker is left alone; the idle one is addressed by session id (the event spells it as a string).
  expect(seen.sends.slice(2)).toEqual(['ui-id'])
  expect(seen.toasts.at(-1)).toBe('Resumed · 1 worker nudged')

  // The same reset reported again does not fire a second time.
  await measure($, cut)
  await clock.advance(3 * 60 * 60_000)
  expect(seen.prompts.length).toBe(1)
})

test('a session already resumed by hand is not prompted again', async ($, on) => {
  const { clock, seen } = world(on, [])
  await start($)
  await measure($, cut)
  await clock.set(RESET + 10_000)
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(60_000)
  expect(seen.prompts).toEqual([])
  expect(seen.toasts.at(-1)).toBe('Already running')
})

test('a rate-limit stop with no exhausted window still schedules from the 5h reset', async ($, on) => {
  const { clock, seen } = world(on, [{ kind: 'five_hour', percentUsed: 98, resetsAt: iso(RESET) }])
  await start($)
  await $.classic.StopFailure({ error: 'rate_limit' })
  expect(seen.status.at(-1)).toMatch(/^⏸ limit · resumes /)
  await clock.set(RESET + 61_000)
  expect(seen.prompts).toEqual(['Continue. The usage limit has reset.'])
})

test('a pending reset survives a reload through the store', async ($, on) => {
  const stored = { 'session:me': { pending: { cutAt: NOW, resetsAt: RESET, isGuessed: false }, handled: [], workers: [] } }
  const { clock, seen } = world(on, [], stored)
  await start($)
  await clock.set(RESET + 61_000)
  expect(seen.prompts).toEqual(['Continue. The usage limit has reset.'])
})

test('the hint tail shows only near the limit, and never as a notice', async ($, on) => {
  const { seen } = world(on, [])
  await start($)
  await measure($, [{ kind: 'five_hour', percentUsed: 50, resetsAt: iso(RESET) }])
  expect(await tailOf($, seen)).toBeUndefined()
  await measure($, [{ kind: 'five_hour', percentUsed: 86, resetsAt: iso(RESET) }])
  expect(await tailOf($, seen)).toMatch(/^5h 86% · resets \d\d:\d\d$/)
  expect(seen.status.at(-1)).toBeUndefined()
  // A tail another hook already set is kept and appended to.
  expect(await tailOf($, seen, '1 agent')).toMatch(/^1 agent · 5h 86% · resets \d\d:\d\d$/)
  await measure($, [{ kind: 'five_hour', percentUsed: 12, resetsAt: iso(RESET) }])
  expect(await tailOf($, seen)).toBeUndefined()
})

test('each prompt carries a one-line usage note', async ($, on) => {
  world(on, [
    { kind: 'five_hour', percentUsed: 42, resetsAt: iso(RESET) },
    { kind: 'seven_day', percentUsed: 61 },
  ])
  await start($)
  const r = await $.prompt.submit({ text: 'hello', wait: false, origin: { kind: 'composer' } })
  expect(r.context?.length).toBe(1)
  expect(r.context?.[0]).toMatch(/^Usage: 5h 42% \(resets \d\d:\d\d\), week 61%$/)
})

test('/limits lists both windows and the pending resume', async ($, on) => {
  world(on, cut)
  await start($)
  await measure($, cut)
  const r = await $.command.run({
    command: 'limits',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })
  const lines = (r.text ?? '').split('\n')
  expect(lines[0]).toMatch(/^5h 100% · resets \d\d:\d\d$/)
  expect(lines[1]).toBe('Week 61%')
  expect(lines[2]).toMatch(/^⏸ resumes \d\d:\d\d$/)
})

const at = (percentUsed: number): SessionRateLimit[] => [
  { kind: 'five_hour', percentUsed, resetsAt: iso(RESET) },
  { kind: 'seven_day', percentUsed: 61 },
]
const submit = ($: Engine) => $.prompt.submit({ text: 'hello', wait: false, origin: { kind: 'composer' } })
const limitsCommand = ($: Engine) =>
  $.command.run({ command: 'limits', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
const WINDOW = { pausePercent: 98, resumeDelayMinutes: 3, peers: ['vokko-vice', 'inkwell'] }

test('without usage-window.json 98% does not pause and nothing about a window is added', async ($, on) => {
  const { clock, seen } = world(on, at(98))
  await start($)
  await measure($, at(98))
  expect(seen.toasts).toEqual([])
  expect(seen.status.at(-1)).toBeUndefined()
  const r = await submit($)
  expect(r.context).toEqual([expect.stringMatching(/^Usage: 5h 98% \(resets \d\d:\d\d\), week 61%$/)])
  expect(((await limitsCommand($)).text ?? '').split('\n').length).toBe(3)
  // A cut still resumes one minute past the reset.
  await measure($, at(100))
  await clock.set(RESET + 59_000)
  expect(seen.prompts).toEqual(['hello'])
  await clock.advance(2_000)
  expect(seen.prompts).toEqual(['hello', 'Continue. The usage limit has reset.'])
})

test('the 5h window at pausePercent pauses once, and the note tells Claude to stop', async ($, on) => {
  const config: { value?: unknown } = {}
  const { seen } = world(on, at(98), undefined, config)
  await start($)
  await measure($, at(98))
  expect(seen.toasts).toEqual([])
  // An edit to the file applies on the next event, no restart.
  config.value = WINDOW
  await measure($, at(98))
  expect(seen.toasts).toEqual([expect.stringMatching(/^Usage window: 5h at 98% · pausing · resuming at \d\d:\d\d$/)])
  expect(seen.status.at(-1)).toMatch(/^⏸ paused · resumes \d\d:\d\d$/)
  const r = await submit($)
  expect(r.context?.[1]).toMatch(
    /^Usage window: 5h at 98% \(pause at 98%\)\. Pause now: stop your workers and peers per the Usage window rule in CLAUDE\.md; auto-resume at \d\d:\d\d\. Peers: vokko-vice, inkwell\.$/,
  )
  // Already pending: a higher reading does not pause again.
  await measure($, at(99))
  expect(seen.toasts.length).toBe(1)
})

test('a pause resumes at the reset plus resumeDelayMinutes, even after Claude answered', async ($, on) => {
  const { clock, seen } = world(on, at(98), undefined, { value: WINDOW })
  await start($)
  await measure($, at(98))
  await $.turn.complete({ answer: 'stopped workers', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.set(RESET + 3 * 60_000 - 1_000)
  expect(seen.prompts).toEqual([])
  await clock.advance(2_000)
  expect(seen.prompts).toEqual(['Continue. The usage limit has reset.'])
  expect(seen.toasts.at(-1)).toBe('Resumed')
})

test('nothing resumes after until, and the note says the run is over', async ($, on) => {
  const until = new Date(RESET + 30_000).toISOString()
  const { clock, seen } = world(on, [], undefined, { value: { ...WINDOW, until } })
  await start($)
  await $.session.send({ to: 'brf-app-ui', text: 'hi', origin: { kind: 'model' } })
  await measure($, at(100))
  expect(seen.toasts.at(-1)).toMatch(/^Usage limit reached · no resume, the window ends \d\d:\d\d$/)
  expect(seen.status.at(-1)).toMatch(/^⏸ limit · no resume · window ends \d\d:\d\d · 1 worker$/)
  await clock.set(RESET + 2 * 60 * 60_000)
  expect(seen.prompts).toEqual([])
  expect(seen.sends).toEqual(['brf-app-ui'])
  expect(seen.toasts.at(-1)).toBe(`Usage window ended at ${until}: not resuming`)
  const r = await submit($)
  expect(r.context?.at(-1)).toBe(`Usage window ended at ${until}: stop all work and workers.`)
  expect(((await limitsCommand($)).text ?? '').split('\n').at(-1)).toMatch(/^Window ended \d\d:\d\d · no auto-resume$/)
})

test('/limits shows the active window', async ($, on) => {
  world(on, at(42), undefined, { value: { ...WINDOW, until: new Date(RESET + 6 * 60 * 60_000).toISOString() } })
  await start($)
  const lines = ((await limitsCommand($)).text ?? '').split('\n')
  expect(lines.at(-1)).toMatch(/^Window: pause at 98% · resume reset \+3m · ends \d\d:\d\d · peers vokko-vice, inkwell$/)
})

test('the current limits are published to ~/.claude/usage/limits.json through a rename', async ($, on) => {
  const { clock, seen } = world(on, at(42))
  await start($)
  expect(JSON.parse(seen.files.get(LIMITS) ?? 'null')).toEqual({
    fiveHour: { percentUsed: 42, resetsAt: iso(RESET) },
    week: { percentUsed: 61, resetsAt: null },
    updatedAt: iso(NOW),
  })
  const native = (p: string) => p.split('/').join('\\')
  expect(seen.moves).toEqual([['cmd', '/c', 'move', '/y', native(`${LIMITS}.me.tmp`), native(LIMITS)]])
  expect([...seen.files.keys()]).toEqual([LIMITS])
  await clock.advance(60_000)
  await measure($, at(57))
  const after = JSON.parse(seen.files.get(LIMITS) ?? 'null')
  expect(after.fiveHour.percentUsed).toBe(57)
  expect(after.updatedAt).toBe(iso(NOW + 60_000))
})

test('warnPercent toasts once per window and the note asks to warn peers', async ($, on) => {
  const { seen } = world(on, at(91), undefined, { value: { ...WINDOW, warnPercent: 90 } })
  await start($)
  await measure($, at(89))
  expect(seen.toasts).toEqual([])
  await measure($, at(90))
  await measure($, at(91))
  expect(seen.toasts).toEqual(['Usage window: 5h at 90% · warn peers (near limit)'])
  const r = await submit($)
  expect(r.context?.[1]).toBe('Usage window: 5h at 91%, warn peers (NEAR LIMIT) per CLAUDE.md. Peers: vokko-vice, inkwell.')
  // The next window warns again.
  const next = iso(RESET + 5 * 60 * 60_000)
  await measure($, [{ kind: 'five_hour', percentUsed: 92, resetsAt: next }])
  expect(seen.toasts.length).toBe(2)
  // At pausePercent the pause takes over the note.
  await measure($, [{ kind: 'five_hour', percentUsed: 98, resetsAt: next }])
  expect(seen.toasts.at(-1)).toMatch(/^Usage window: 5h at 98% · pausing/)
})
