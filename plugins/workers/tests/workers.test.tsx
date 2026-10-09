import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { asksForYou, bodyOf, contactKey, cut, isWorker, senderOf } from '../hooks/lib'

const AGENTS = JSON.stringify([
  { pid: 1, cwd: '/repo', sessionId: 'self', name: 'brf-orchestrator', status: 'busy' },
  { pid: 29965, cwd: '/repo/.claude/worktrees/reading', sessionId: 'r', name: 'brf-app-reading', status: 'waiting', waitingFor: 'dialog open' },
  { pid: 2, cwd: '/repo/.claude/worktrees/ui', sessionId: 'u', name: 'brf-app-ui', status: 'idle' },
  { pid: 3, cwd: '/elsewhere', sessionId: 'x', name: 'unrelated', status: 'busy' },
])

const engine = (on: On, opened: string[], filled: string[] = [], agents = AGENTS) => {
  mock.clock(on, { now: 1_000 })
  const out = (stdout: string, exitCode = 0) => ({
    value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  })
  on('session.id', () => ({ value: 'self' }))
  on('session.repo', () => ({ value: { root: '/repo', remote: null, internal: false, repository: null } }) as never)
  on('command.register', () => ({ value: { command: 'workers' } }))
  on('command.run', () => ({ text: '' }))
  on('ui.open', (_$, e) => {
    if (!opened.includes(e.id)) opened.push(e.id)
    return { value: { isPlaced: true } } as never
  })
  on('ui.close', () => ({ value: undefined }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('prompt.fill', (_$, e) => {
    filled.push(e.text)
    return { isFilled: true, box: { text: e.text, cursor: e.text.length } } as never
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.receive', (_$, e) => ({ text: e.text }))
  on('session.send', () => ({ isDelivered: true }))
  on('process.run', (_$, e) => {
    const [cmd, , cwd, ...rest] = e.argv
    if (cmd === 'claude') return out(agents) as never
    if (rest[0] === 'rev-parse') return out(cwd === '/elsewhere' ? '' : `worktree-${cwd!.split('/').pop()}\n`, cwd === '/elsewhere' ? 128 : 0) as never
    if (rest[0] === 'rev-list') return out('3\n') as never
    if (rest[0] === 'status') return out(' M a.ts\n?? b.ts\n') as never
    return out('', 1) as never
  })
}

describe('lib', () => {
  test('reads the sender off the envelope', async () => {
    const text = '<cross-session-message from="uds:/tmp/cc-socks/29965.sock" from-name="brf-app-reading" from-mode="bypass">Part 1 committed. Merge?</cross-session-message>'
    expect(senderOf(text)).toBe('brf-app-reading')
    expect(senderOf('<cross-session-message from="uds:/tmp/cc-socks/42.sock">hi</cross-session-message>')).toBe('pid:42')
    expect(senderOf('plain text')).toBe(null)
    expect(bodyOf(text)).toBe('Part 1 committed. Merge?')
    expect(contactKey('uds:/tmp/cc-socks/7.sock')).toBe('pid:7')
    expect(contactKey('brf-app-ui')).toBe('brf-app-ui')
  })

  test('spots a question for the person', async () => {
    expect(asksForYou('Merge?')).toBe(true)
    expect(asksForYou('I am blocked on the schema')).toBe(true)
    expect(asksForYou('Need your approval for r2')).toBe(true)
    expect(asksForYou('Part 1 committed.')).toBe(false)
  })

  test('a worker is a contact or a worktree of this repo', async () => {
    const a = { pid: 3, cwd: '/elsewhere', sessionId: 'x', name: 'unrelated', status: 'busy' }
    expect(isWorker(a, {}, '/repo')).toBe(false)
    expect(isWorker(a, { 'pid:3': { text: '', at: 0, dir: 'out', needsYou: false } }, '/repo')).toBe(true)
    expect(isWorker({ ...a, cwd: '/repo/.claude/worktrees/ui' }, {}, '/repo')).toBe(true)
  })
})

const START = { cwd: '/repo', surface: 'terminal', isInteractive: true } as const
const SURFACES = ['terminal', 'desktop'] as const
const ASK =
  '<cross-session-message from="uds:/tmp/cc-socks/29965.sock" from-name="brf-app-reading">Part 1 done. Should I merge main into my branch?</cross-session-message>'

const pane = (bodyColumns: number) => ({
  plugin: 'workers',
  component: 'Pane',
  props: { title: 'Workers', isFocused: false, bodyColumns, placement: 'dock' } as never,
  requestId: 'workers',
  viewport: { columns: bodyColumns + 2, rows: 30 } as never,
}) as const

describe('pane', () => {
  test('cut ends in an ellipsis', async () => {
    expect(cut('hello world', 6)).toBe('hello…')
    expect(cut('hi', 6)).toBe('hi')
  })

  test('shows reading state before the first refresh', async ($, on) => {
    engine(on, [])
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...pane(80), surface })
      expect(await ui.find({ type: 'Text', text: 'Reading sessions…' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('populated: sorted, glyphs, git, last message, opens unasked', async ($, on) => {
    const opened: string[] = []
    const filled: string[] = []
    engine(on, opened, filled)
    await $.session.receive({ origin: { kind: 'peer' }, text: ASK })
    await $.session.start(START)
    expect(opened).toEqual(['workers'])

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...pane(80), surface })
      expect(await ui.find({ type: 'Text', text: '2 workers · 1 needs you' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^updated \d+s ago$/ })).toBeDefined()
      const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
      // Needs you first, then idle.
      const reading = texts.findIndex(t => t === 'worktree-reading +3 ~2')
      const ui2 = texts.findIndex(t => t === 'worktree-ui +3 ~2')
      expect(reading).toBeGreaterThan(-1)
      expect(ui2).toBeGreaterThan(reading)
      expect(texts).toContain('▲ ')
      expect(texts).toContain('○ ')
      expect(await ui.find({ type: 'Text', text: /Should I merge main into my branch\? · \d+s$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /unrelated/ })).toBeUndefined()
      expect(await ui.find({ key: 'refresh' })).toBeDefined()

      await ui.press({ key: 'tell-brf-app-reading' })
      expect(filled.at(-1)).toBe('Tell brf-app-reading: ')
      await ui.unmount()
    }
  })

  test('narrow: branch moves to the second line, text is cut', async ($, on) => {
    engine(on, [])
    await $.session.receive({ origin: { kind: 'peer' }, text: ASK })
    await $.session.start(START)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...pane(40), surface })
      const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
      expect(texts).not.toContain('worktree-reading +3 ~2')
      const line = texts.find(t => t.includes('worktree-reading +3 ~2 · '))
      expect(line).toBeDefined()
      expect(line!.length).toBeLessThanOrEqual(40)
      expect(line).toContain('…')
      await ui.unmount()
    }
  })

  test('empty: says so and points at /orchestrate', async ($, on) => {
    const opened: string[] = []
    engine(on, opened, [], JSON.stringify([{ pid: 1, cwd: '/repo', sessionId: 'self', name: 'me', status: 'busy' }]))
    await $.session.start(START)
    expect(opened).toEqual([])
    await $.command.run({ command: 'workers', args: '', origin: { kind: 'composer' } as never, presentation: undefined as never })
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...pane(80), surface })
      expect(await ui.find({ type: 'Text', text: 'No workers yet' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'Start some with /orchestrate' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('a sent message shows as yours; a vanished worker shows as gone', async ($, on) => {
    engine(on, [])
    await $.session.receive({
      origin: { kind: 'peer' },
      text: '<cross-session-message from="uds:/tmp/cc-socks/29965.sock" from-name="brf-app-reading">Waiting for your decision</cross-session-message>',
    })
    await $.session.start(START)
    await $.session.send({ to: 'brf-app-reading', text: 'Go ahead', origin: { kind: 'model' } })
    await $.session.send({ to: 'brf-app-old', text: 'Thanks', origin: { kind: 'model' } })
    const ui = await $.ui.mount({ ...pane(80), surface: 'terminal' })
    // brf-app-reading is still blocked on a dialog per claude agents, so it stays ▲.
    expect(await ui.find({ type: 'Text', text: /^ {2}you: Go ahead · \d+s$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '✕ ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /3 workers · 1 needs you · 1 gone/ })).toBeDefined()
    await ui.unmount()
  })
})
