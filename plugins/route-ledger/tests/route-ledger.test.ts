import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { bgLaunches, review } from '../hooks/register'
import type { LedgerEntry } from '../types'

const DAY = 86_400_000
const t = 1_000_000_000_000

// Mutable knobs a test turns after the hooks are registered.
const knobs = {
  sid: 'S1',
  bgFails: false,
  async: false, // Agent calls come back as async_launched
  agentId: 'AG1',
  deny: false,
  resolved: undefined as string | undefined,
  gate: Promise.resolve() as Promise<void>, // 'slow' Agent calls wait on it
}
const db = new Map<string, unknown>()

function world(on: On, main = 'sonnet') {
  knobs.sid = 'S1'
  knobs.bgFails = false
  knobs.async = false
  knobs.agentId = 'AG1'
  knobs.deny = false
  knobs.resolved = undefined
  knobs.gate = Promise.resolve()
  db.clear()
  const clock = mock.clock(on, { now: t })
  on('store.get', (_$, e) => ({ value: db.get(e.key) }))
  on('store.set', (_$, e) => {
    db.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...db.keys()] }))
  on('store.delete', (_$, e) => {
    db.delete(e.key)
    return { value: undefined }
  })
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  mock.env(on, { HOME: '/home/me' })
  on('session.cwd', () => ({ value: '/proj/app' }))
  on('session.id', () => ({ value: knobs.sid }))
  on('session.model', () => ({ value: main }))
  on('session.repo', () => ({ value: { root: '/repos/berkays-mods', remote: null, internal: false, repository: null } }) as never)
  on('command.register', () => ({ value: { command: 'routing-review' } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('fs.read', (_$, e) => {
    if (/reviewer.md$/.test(e.path)) return { value: '---\nname: reviewer\nmodel: opus\neffort: medium\n---\nReview.' }
    return { value: '' }
  })
  // The tool itself: a foreground Agent completes with usage, a background one is async_launched, a failing one
  // is flagged by its description.
  on('tool.call', async (_$, e) => {
    if (e.tool === 'Agent') {
      if (knobs.deny) return { deny: 'nope' } as never
      if (/^slow/.test(e.description)) await knobs.gate
      if (/fail/.test(e.description)) return { result: {}, text: 'boom', isError: true } as never
      if (knobs.async)
        return { result: { status: 'async_launched', agentId: knobs.agentId, resolvedModel: knobs.resolved, outputFile: '/o' } } as never
      return {
        result: { status: 'completed', totalDurationMs: 4000, totalTokens: 1500, resolvedModel: knobs.resolved },
      } as never
    }
    return (knobs.bgFails ? { result: {}, text: 'exit 1', isError: true } : { result: {}, text: '' }) as never
  })
  return clock
}

const ledger = async (_$: Engine, sid = 'S1') => db.get('ledger:' + sid) as LedgerEntry[]
const agent = ($: Engine, input: object) =>
  $.tool.call({ tool: 'Agent', description: 'd', prompt: 'SECRET', ...input } as never)
const bash = ($: Engine, command: string) => $.tool.call({ tool: 'Bash', command } as never)
const review$ = ($: Engine, args: string) =>
  $.command.run({
    command: 'routing-review',
    args,
    origin: { kind: 'composer' } as never,
    presentation: { isFullscreen: false, columns: 120 },
  })

const done = (agentId: string, reason: 'answer' | 'aborted' | 'error', durationMs: number) =>
  ({
    answer: '',
    durationMs,
    isAborted: reason === 'aborted',
    turnId: 't',
    agentId,
    reason,
    usage: { model: 'm', input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 9, cache_creation_input_tokens: 9 },
  }) as never

test('Agent launch: model, effort, label, repo, outcome; the prompt is never stored', async ($, on) => {
  const c = world(on)
  await agent($, { description: 'Fix the parser', model: 'haiku', effort: 'xhigh' })
  await c.settle()
  const [e] = await ledger($)
  expect(e).toMatchObject({
    kind: 'subagent',
    sid: 'S1',
    repo: 'berkays-mods',
    model: 'haiku',
    effort: 'xhigh',
    label: 'Fix the parser',
    ok: true,
    ms: 4000,
    tokens: 1500,
  })
  expect(JSON.stringify(await ledger($))).not.toContain('SECRET')
})

test('Agent: an errored run is recorded as an error; the label is clipped to 80 chars', async ($, on) => {
  const c = world(on)
  await agent($, { description: 'fail ' + 'x'.repeat(100), model: 'sonnet', effort: 'high' })
  await c.settle()
  const [e] = await ledger($)
  expect(e!.ok).toBe(false)
  expect(e!.label.length).toBe(80)
})

test('Agent: frontmatter supplies model and effort; no model uses the main model; fork is skipped', async ($, on) => {
  const c = world(on, 'claude-sonnet-5-5')
  await agent($, { description: 'a', subagent_type: 'reviewer' })
  await agent($, { description: 'b', subagent_type: 'general-purpose' })
  await agent($, { description: 'c', subagent_type: 'fork', effort: 'max' })
  await c.settle()
  const all = await ledger($)
  expect(all.map(x => [x.label, x.agent, x.model, x.effort])).toEqual([
    ['a', 'reviewer', 'opus', 'medium'],
    ['b', 'general-purpose', 'sonnet', undefined],
  ])
})

test('async_launched Agent: no outcome at launch; its own turn.complete fills ok, duration and tokens', async ($, on) => {
  const c = world(on)
  knobs.async = true
  await agent($, { description: 'bg job', model: 'sonnet', effort: 'high' })
  await c.settle()
  expect((await ledger($))[0]).toMatchObject({ agentId: 'AG1', running: true })
  expect((await ledger($))[0]!.ok).toBeUndefined()
  expect((await ledger($))[0]!.tokens).toBeUndefined()
  await $.turn.complete(done('OTHER', 'answer', 1)) // not ours
  await $.turn.complete(done('AG1', 'answer', 5000))
  await c.settle()
  const [e] = await ledger($)
  expect(e).toMatchObject({ ok: true, ms: 5000, tokens: 150 })
  expect(e!.running).toBeUndefined()
})

test('async Agent: an aborted run is an error', async ($, on) => {
  const c = world(on)
  knobs.async = true
  await agent($, { description: 'bg job', model: 'sonnet', effort: 'high' })
  await $.turn.complete(done('AG1', 'aborted', 10))
  await c.settle()
  expect((await ledger($))[0]!.ok).toBe(false)
})

test('a still-running background subagent is not the earlier run of a retry; a finished one is', async ($, on) => {
  const c = world(on)
  knobs.async = true
  knobs.agentId = 'A1'
  await agent($, { description: 'running job', model: 'sonnet', effort: 'medium' })
  await agent($, { description: 'running job', model: 'opus', effort: 'high' }) // the first is still running
  knobs.agentId = 'A2'
  await agent($, { description: 'finished job', model: 'sonnet', effort: 'medium' })
  await $.turn.complete(done('A2', 'answer', 1))
  await agent($, { description: 'finished job', model: 'opus', effort: 'low' })
  await c.settle()
  const [r1, r2, f1, f2] = await ledger($)
  expect([r1, r2].map(x => !!x!.retried)).toEqual([false, false])
  expect(f1).toMatchObject({ retried: true, escalatedTo: 'opus@low' })
  expect(f2!.retried).toBeUndefined()
})

test('parallel launches with the same label in one turn are not retries', async ($, on) => {
  const c = world(on)
  let release!: () => void
  knobs.gate = new Promise<void>(r => (release = r))
  const a = agent($, { description: 'slow scan', model: 'haiku', effort: 'low' })
  const b = agent($, { description: 'slow scan', model: 'sonnet', effort: 'high' })
  await c.settle()
  release()
  await Promise.all([a, b])
  await c.settle()
  expect((await ledger($)).map(x => [!!x.retried, x.escalatedTo])).toEqual([
    [false, undefined],
    [false, undefined],
  ])
})

test('escalation uses the model the run really had (resolvedModel)', async ($, on) => {
  const c = world(on)
  await agent($, { description: 'job', model: 'sonnet', effort: 'high' })
  knobs.resolved = 'claude-opus-5-5'
  await agent($, { description: 'job', model: 'sonnet', effort: 'high' }) // asked Sonnet, got Opus
  await c.settle()
  const [a, b] = await ledger($)
  expect(b!.model).toBe('opus')
  expect(a!.escalatedTo).toBe('opus@high')
})

test('a refused Agent call leaves no entry', async ($, on) => {
  const c = world(on)
  knobs.deny = true
  await agent($, { description: 'denied', model: 'opus', effort: 'max' })
  await c.settle()
  expect(await ledger($)).toEqual([])
})

test('bg launches: every claude --bg segment with name, agent, advisor; other commands ignored', async ($, on) => {
  const c = world(on)
  await bash(
    $,
    'claude --bg --model sonnet --effort high -n "route ledger" --advisor opus "do it" && claude --background --agent reviewer -n=second',
  )
  await bash($, 'claude --model opus --effort max')
  await bash($, 'ls -la && git status')
  await c.settle()
  const all = await ledger($)
  expect(all.map(x => [x.kind, x.label, x.agent, x.model, x.effort, x.advisor, x.ok])).toEqual([
    ['bg', 'route ledger', undefined, 'sonnet', 'high', 'opus', undefined],
    ['bg', 'second', 'reviewer', 'opus', 'medium', undefined, undefined],
  ])
})

test('bg launch with no --model counts as Opus', async ($, on) => {
  const c = world(on)
  await bash($, 'claude --bg --effort high --name solo')
  await c.settle()
  expect((await ledger($)).map(x => [x.label, x.model])).toEqual([['solo', 'opus']])
})

test('bg parsing is quote-aware: flags and `claude` inside a quoted prompt or another command are ignored', () => {
  expect(bgLaunches('claude --bg --model sonnet "use head -n PASSWORD then --effort max"')).toEqual([{ model: 'sonnet' }])
  expect(bgLaunches(`claude --bg -n 'my label' --effort high 'x --model opus'`)).toEqual([{ name: 'my label', effort: 'high' }])
  expect(bgLaunches('claude --bg --name="a b" --agent=reviewer')).toEqual([{ name: 'a b', agent: 'reviewer' }])
  expect(bgLaunches('git commit -m "docs: claude --bg usage"')).toEqual([])
  expect(bgLaunches('echo claude --bg --model opus')).toEqual([])
  expect(bgLaunches('FOO=1 "C:\\bin\\claude.exe" --background -n x')).toEqual([{ name: 'x' }])
  expect(bgLaunches('/usr/local/bin/claude --bg && claude --bg -n b; ls')).toEqual([{}, { name: 'b' }])
  expect(bgLaunches('claude --model opus "a; b | c"')).toEqual([]) // not background
  expect(bgLaunches(`bash -c "claude --bg -n inner 'x -n no'"`)).toEqual([{ name: 'inner' }])
})

test('bg: the prompt text never becomes the label', async ($, on) => {
  const c = world(on)
  await bash($, 'claude --bg --model sonnet "use head -n PASSWORD then"')
  await c.settle()
  expect((await ledger($))[0]).toMatchObject({ label: '', model: 'sonnet' })
})

test('bg: a later failing part of the command does not erase the launch; a lone failing launch does', async ($, on) => {
  const c = world(on)
  knobs.bgFails = true
  await bash($, 'claude --bg -n kept && false')
  await bash($, 'claude --bg -n lone')
  await c.settle()
  expect((await ledger($)).map(x => x.label)).toEqual(['kept'])
})

test('retry in the same session marks the earlier entry; higher on the ladder is an escalation', async ($, on) => {
  const c = world(on)
  await agent($, { description: 'Port the Parser!', model: 'sonnet', effort: 'high' })
  await agent($, { description: 'port the parser', model: 'sonnet', effort: 'high' }) // retry, same rung
  await agent($, { description: 'PORT  the parser', model: 'opus', effort: 'medium' }) // escalation
  await agent($, { description: 'unrelated', model: 'haiku', effort: 'low' })
  await c.settle()
  const [a, b, d, u] = await ledger($)
  expect(a).toMatchObject({ retried: true })
  expect(a!.escalatedTo).toBeUndefined()
  expect(b).toMatchObject({ retried: true, escalatedTo: 'opus@medium' })
  expect(d!.retried).toBeUndefined()
  expect(u!.retried).toBeUndefined()
})

test('effort within a model escalates; a step down does not; other sessions do not match', async ($, on) => {
  const c = world(on)
  await agent($, { description: 'job', model: 'sonnet', effort: 'medium' })
  await agent($, { description: 'job', model: 'sonnet', effort: 'high' })
  await agent($, { description: 'job', model: 'sonnet', effort: 'low' })
  knobs.sid = 'S2'
  await agent($, { description: 'job', model: 'opus', effort: 'max' })
  await c.settle()
  const all = [...(await ledger($)), ...(await ledger($, 'S2'))]
  expect(all.map(x => x.escalatedTo)).toEqual(['sonnet@high', undefined, undefined, undefined])
  expect(all.map(x => !!x.retried)).toEqual([true, true, false, false])
})

test('a session keeps its newest 2000 entries', async ($, on) => {
  const c = world(on)
  const seed = Array.from({ length: 2000 }, (_, i) => ({
    id: `s${i}`,
    ts: t,
    sid: 'old',
    repo: 'r',
    kind: 'bg',
    model: 'haiku',
    label: `n${i}`,
  }))
  db.set('ledger:S1', seed)
  await agent($, { description: 'newest', model: 'haiku', effort: 'low' })
  await c.settle()
  const all = await ledger($)
  expect(all.length).toBe(2000)
  expect(all[0]!.label).toBe('n1')
  expect(all.at(-1)).toMatchObject({ label: 'newest', ok: true })
})

test('each session writes its own key; review merges them', async ($, on) => {
  const c = world(on)
  await agent($, { description: 'mine', model: 'sonnet', effort: 'high' })
  knobs.sid = 'S2'
  await agent($, { description: 'theirs', model: 'haiku', effort: 'low' })
  await c.settle()
  expect([...db.keys()].sort()).toEqual(['ledger:S1', 'ledger:S2'])
  expect((await ledger($, 'S1')).map(x => x.label)).toEqual(['mine'])
  expect((await ledger($, 'S2')).map(x => x.label)).toEqual(['theirs'])
  const out = (await review$($, '')).text
  expect(out).toContain('2 launches')
  expect(out).toContain('sonnet@high')
  expect(out).toContain('haiku@low')
})

test('session.start prunes sessions that fell out of the newest 2000', async ($, on) => {
  world(on)
  const mk = (ts: number, n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `${ts}-${i}`, ts: ts + i, sid: 'x', repo: 'r', kind: 'bg', model: 'haiku', label: '' }))
  db.set('ledger:old', mk(1000, 1500))
  db.set('ledger:mid', mk(100_000, 1500))
  db.set('ledger:new', mk(200_000, 1500))
  await $.session.start({ cwd: '/proj/app', surface: 'terminal', isInteractive: true })
  expect([...db.keys()].sort()).toEqual(['ledger:mid', 'ledger:new'])
})

const row = (o: Partial<LedgerEntry>): LedgerEntry =>
  ({ id: 'x', ts: t, sid: 's', repo: 'r', kind: 'subagent', model: 'sonnet', effort: 'high', label: 'l', ...o }) as LedgerEntry

test('review: table per model@effort and agent, medians, recent escalations, day window', () => {
  const entries = [
    row({ ts: t - 20 * DAY, label: 'ancient' }), // outside 14d
    row({ ok: true, tokens: 1000, ms: 60_000 }),
    row({ ok: true, tokens: 3000, ms: 120_000 }),
    row({ ok: false, retried: true, escalatedTo: 'opus@medium', label: 'hard job' }),
    row({ model: 'opus', effort: 'medium', agent: 'reviewer', kind: 'bg', label: 'bg1' }),
  ]
  const out = review(entries, 14, t)
  const lines = out.split('\n')
  expect(lines[0]).toContain('4 launches')
  expect(lines[0]).toContain('bg sessions have none')
  expect(lines[1]).toMatch(/^model@effort\s+agent\s+n\s+ok\s+err\s+retry\s+esc\s+tok~\s+time~$/)
  expect(lines[2]).toMatch(/^sonnet@high\s+-\s+3\s+2\s+1\s+1\s+1\s+2\.0k\s+1m30s$/)
  expect(lines[3]).toMatch(/^opus@medium\s+reviewer\s+1\s+0\s+0\s+0\s+0\s+-\s+-$/)
  expect(out).toContain('Recent escalations:\n- hard job: sonnet@high -> opus@medium')
  expect(out).not.toContain('ancient')
  expect(review([], 14, t)).toBe('routing-review: no launches in the last 14d')
})

test('/routing-review runs with a day count and defaults to 14', async ($, on) => {
  const c = world(on)
  await $.session.start({ cwd: '/proj/app', surface: 'terminal', isInteractive: true })
  await agent($, { description: 'job', model: 'sonnet', effort: 'high' })
  await c.settle()
  expect((await review$($, '')).text).toContain('last 14d, 1 launches')
  expect((await review$($, '3')).text).toContain('last 3d, 1 launches')
  await c.advance(5 * DAY)
  expect((await review$($, '3')).text).toBe('routing-review: no launches in the last 3d')
})

test('/routing-review days: negative, zero and junk fall back to 14', async ($, on) => {
  const c = world(on)
  await agent($, { description: 'job', model: 'sonnet', effort: 'high' })
  await c.settle()
  for (const a of ['-5', '0', 'abc']) expect((await review$($, a)).text).toContain('last 14d')
})
