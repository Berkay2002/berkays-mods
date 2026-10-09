import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { bgLaunches, parseWorktrees } from '../hooks/bg'
import { crab, spriteOf, tierOf } from '../hooks/register'
import { SPRITE_H, SPRITE_W, toText } from '../hooks/sprite'

describe('claude-config crew', () => {
  test('scout, builder and reviewer are tiers of their own; savvy tiers still work; anything else is other', async () => {
    expect(tierOf('scout')).toBe('scout')
    expect(tierOf('builder')).toBe('builder')
    expect(tierOf('reviewer')).toBe('reviewer')
    expect(tierOf('some-plugin:reviewer')).toBe('reviewer')
    expect(tierOf('savvy-careful')).toBe('careful')
    expect(tierOf('careful')).toBe('other')
    expect(tierOf('Explore')).toBe('other')
  })

  test('each crew crab wears its own costume', async () => {
    const drawn = ['scout', 'builder', 'reviewer', 'orchestrator', 'other'].map(c => crab(0, 0, c))
    expect(new Set(drawn).size).toBe(5)
    expect(crab(0, 0, 'builder', false, true)).toContain('class="c-builder run"')
  })
})

describe('terminal crabs', () => {
  const TIERS = ['scout', 'builder', 'reviewer', 'orchestrator', 'other', 'fable', 'heavy', 'careful', 'medium', 'light', 'explore']

  test('every tier is Clawd, three lines of SPRITE_W columns, and the crew hold props of their own', async () => {
    for (const t of TIERS)
      for (const f of [0, 1]) {
        const lines = toText(spriteOf(t, f)).split('\n')
        expect(lines).toHaveLength(SPRITE_H)
        for (const l of lines) expect(l.length).toBe(SPRITE_W)
        expect(lines[1]!.startsWith('▝▜██████▀')).toBe(true)
      }
    const crew = ['scout', 'builder', 'reviewer', 'orchestrator', 'other'].map(t => toText(spriteOf(t)))
    expect(new Set(crew).size).toBe(5)
    // Other holds nothing; a prop is drawn in its tier's color, the body in Claude orange.
    expect(toText(spriteOf('other')).split('\n').every(l => l.endsWith('  '))).toBe(true)
    expect(spriteOf('builder')[0]).toEqual([
      { text: ' ▐▛███▛█ ', fg: '#D97757' },
      { text: '▜▀', fg: '#E07B39' },
    ])
  })

  test('every tier has a second frame: the feet walk', async () => {
    for (const t of TIERS) {
      const [a, b] = [toText(spriteOf(t, 0)), toText(spriteOf(t, 1))]
      expect(b).not.toBe(a)
      expect(b.split('\n')[2]).not.toBe(a.split('\n')[2])
    }
  })
})

describe('background sessions', () => {
  test('reads the launch flags and the worktree list', async () => {
    expect(bgLaunches('claude --bg --model sonnet --effort high -n x --agent builder "do it"')).toEqual([
      { model: 'sonnet', effort: 'high', name: 'x', agent: 'builder' },
    ])
    expect(bgLaunches('claude --name=y --bg "--model opus"')).toEqual([{ name: 'y' }])
    expect(bgLaunches('git status')).toEqual([])
    expect(parseWorktrees('worktree /r\nHEAD a\nbranch refs/heads/main\n\nworktree /w/x\nHEAD b\nbranch refs/heads/feat-x\n')).toEqual([
      { path: '/r', branch: 'main' },
      { path: '/w/x', branch: 'feat-x' },
    ])
  })
})

// The agents list: this session, one worker in a linked worktree (Windows spelling), one unrelated session.
const AGENTS = JSON.stringify([
  { pid: 1, cwd: '/repo', kind: 'interactive', sessionId: 'self', name: 'me', status: 'busy' },
  { pid: 2, cwd: 'E:\\Dev\\repo-wt\\x', kind: 'background', sessionId: 'w', name: 'x', status: 'busy', state: 'working' },
  { pid: 3, cwd: 'C:\\elsewhere', kind: 'background', sessionId: 'u', name: 'unrelated', status: 'idle', state: 'done' },
])
const WORKTREES = 'worktree /repo\nHEAD a\nbranch refs/heads/main\n\nworktree E:/Dev/repo-wt/x\nHEAD b\nbranch refs/heads/feat-x\n'

const world = (on: On, calls: string[][] = [], agents = AGENTS) => {
  const clock = mock.clock(on, { now: 1_000 })
  const out = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as never
  const panes: string[] = []
  on('session.id', () => ({ value: 'self' }))
  on('session.repo', () => ({ value: { root: '/repo', remote: null, internal: false, repository: null } }) as never)
  on('env.get', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'agents-info' } }))
  on('tool.register', () => ({ value: undefined }) as never)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('ui.open', (_$, e) => {
    panes.push(e.id)
    return { value: { isPlaced: true } } as never
  })
  on('ui.close', (_$, e) => {
    panes.splice(panes.indexOf(e.id), 1)
    return { value: undefined } as never
  })
  on('ui.panes', () => ({ value: panes.map(id => ({ id })) }) as never)
  on('tool.call', () => ({ result: {}, text: '' }) as never)
  on('process.run', (_$, e) => {
    calls.push([...e.argv])
    return out(e.argv[0] === 'claude' ? agents : WORKTREES)
  })
  return clock
}

const pane = (bodyColumns: number) =>
  ({
    plugin: 'savvy-progress',
    component: 'Pane',
    props: { title: 'Agents', isFocused: false, bodyColumns, placement: 'dock' } as never,
    requestId: 'savvy-agents',
    viewport: { columns: bodyColumns + 2, rows: 30 } as never,
  }) as const

const START = { cwd: '/repo', surface: 'terminal', isInteractive: true } as const
const OPEN = { command: 'agents-info', args: '', origin: { kind: 'composer' } as never, presentation: undefined as never }

describe('agents panel', () => {
  test('terminal: only the related background session shows, with the builder crab and its launch flags', async ($, on) => {
    const calls: string[][] = []
    world(on, calls)
    await $.session.start(START)
    expect(calls).toEqual([]) // nothing open, nothing polled
    await $.tool.call({ tool: 'Bash', command: 'claude --bg --model sonnet --effort high --name x "build it"' } as never)
    await $.command.run(OPEN)
    expect(calls.map(c => c[0])).toEqual(['claude', 'git'])

    const ui = await $.ui.mount({ ...pane(60), surface: 'terminal' })
    const nodes = await ui.findAll({ type: 'Text' })
    const all = nodes.map(t => t.text).join('\n')
    expect(all).toContain('Background · 1')
    expect(all).toContain('builder · Sonnet · high')
    expect(all).toContain('busy · feat-x')
    expect(all).toContain('x')
    expect(all).not.toContain('unrelated')
    // The crab is Clawd in quadrant blocks, with the builder's hammer in the builder's color.
    expect(all).toContain('▝▜██████▀')
    expect(nodes.some(t => (t.props as { color?: string }).color === '#E07B39')).toBe(true)
    await ui.unmount()
  })

  // The pane's glyphs and colors, as drawn now: the crab is colored Text runs.
  const crabs = async (ui: { findAll: (q: { type: string }) => Promise<{ text: string; props: unknown }[]> }) =>
    JSON.stringify((await ui.findAll({ type: 'Text' })).map(t => [t.text, (t.props as { color?: string }).color]))

  test('a busy session animates while the pane is open', async ($, on) => {
    const clock = world(on)
    await $.session.start(START)
    await $.tool.call({ tool: 'Bash', command: 'claude --bg --model sonnet --name x "build it"' } as never)
    await $.command.run(OPEN)
    const ui = await $.ui.mount({ ...pane(60), surface: 'terminal' })
    const first = await crabs(ui)
    await clock.advance(500)
    const second = await crabs(ui)
    expect(second).not.toBe(first)
    await clock.advance(500)
    expect(await crabs(ui)).toBe(first)
    await ui.unmount()
  })

  test('a finished session does not animate, and nothing ticks with the pane closed', async ($, on) => {
    const done = JSON.stringify([{ pid: 2, cwd: 'E:\\Dev\\repo-wt\\x', kind: 'background', sessionId: 'w', name: 'x', status: 'idle', state: 'done' }])
    const quiet = world(on, [], done)
    await $.session.start(START)
    await $.command.run(OPEN)
    const ui = await $.ui.mount({ ...pane(60), surface: 'terminal' })
    const first = await crabs(ui)
    await quiet.advance(1500)
    expect(await crabs(ui)).toBe(first)
    await ui.unmount()
  })

  test('a busy session with the pane closed does not tick', async ($, on) => {
    const clock = world(on)
    await $.session.start(START)
    await $.tool.call({ tool: 'Bash', command: 'claude --bg --model sonnet --name x "build it"' } as never)
    await $.command.run(OPEN)
    const ui = await $.ui.mount({ ...pane(60), surface: 'terminal' })
    const first = await crabs(ui)
    await $.command.run(OPEN) // closes the pane
    await clock.advance(500)
    expect(await crabs(ui)).toBe(first)
    await ui.unmount()
  })

  test('desktop: a Background section of SVG rows, no cost for them', async ($, on) => {
    world(on)
    await $.session.start(START)
    await $.command.run(OPEN)
    const ui = await $.ui.mount({ ...pane(60), surface: 'desktop' })
    const rows = await ui.findAll({ type: 'Svg' })
    const bgRow = rows.find(r => String((r.props as { source?: string }).source).includes('>x</text>'))
    expect(bgRow).toBeDefined()
    expect(String((bgRow!.props as { source?: string }).source)).toContain('feat-x')
    expect(String((bgRow!.props as { source?: string }).source)).not.toContain('≈$')
    await ui.unmount()
  })

  test('the bar counts background sessions and draws the orchestrator in text', async ($, on) => {
    world(on)
    await $.session.start(START)
    await $.tool.call({ tool: 'mcp__savvy-progress__progress', title: 'job', total: 2, phase: 'delegate' } as never)
    await $.command.run(OPEN)
    const ui = await $.ui.mount({
      plugin: 'savvy-progress',
      component: 'AbovePrompt',
      props: { bodyColumns: 100, hasSurvey: false } as never,
      surface: 'terminal',
      viewport: { columns: 102, rows: 30 } as never,
    })
    expect((await ui.find({ key: 'savvy-agents' }))?.text).toBe('×1')
    const nodes = await ui.findAll({ type: 'Text' })
    expect(nodes.some(t => t.text.includes('▝▜██████▀'))).toBe(true)
    await ui.unmount()
  })

  test('a session nobody launched shows with an unknown model', async ($, on) => {
    world(on)
    await $.session.start(START)
    await $.command.run(OPEN)
    const ui = await $.ui.mount({ ...pane(60), surface: 'terminal' })
    const all = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')
    expect(all).toContain('session · —')
    await ui.unmount()
  })
})
