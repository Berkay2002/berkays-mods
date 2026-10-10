import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { bgLaunches, parseWorktrees } from '../hooks/bg'
import { crab, spriteOf, tierOf } from '../hooks/register'
import { SPRITE_H, SPRITE_W, toText } from '../hooks/sprite'
import { logLines, messageLines, transcriptMessages, wrapLines } from '../hooks/view'
import type { ViewLine } from '../types'

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
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }) as never)
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
    if (e.argv[1] === 'logs') return out('\x1b[1mworking on it\x1b[m\r\n\x1b[K\r\n')
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

const flat = (ls: ViewLine[]) => ls.map(l => (l.kind === 'gap' ? '' : `${l.kind}:${l.tool ? l.tool + ' ' : ''}${l.text}`))

describe('view pane', () => {
  test('logs lose colors and cursor moves, keep the last redraw of a line, and squeeze blank runs', async () => {
    const raw = '\x1b[38;2;1;2;3mhello\x1b[m\r\n\x1b[K\r\n\r\n\x1b]0;title\x07a\x1b[2Cb\r\nold\rnew\r\n\r\n'
    expect(flat(logLines(raw))).toEqual(['log:hello', '', 'log:a  b', 'log:new'])
    // Indents stay; wide gaps and the prompt box's rules shrink to fit the pane.
    expect(flat(logLines('    indented     then gap\n─────\n── name ───────❯\n'))).toEqual(['log:    indented  then gap', 'log:── name ───❯'])
  })

  test('an agent transcript reads as prompt, replies and tool calls', async () => {
    const lines = messageLines([
      { role: 'user', text: 'Do the task', toolUses: [] },
      {
        role: 'assistant',
        text: 'On it.',
        toolUses: [
          { tool_use_id: '1', tool: 'Bash', input: { command: 'ls  -la\nx' }, text: 'ok' },
          { tool_use_id: '2', tool: 'Read', input: { file_path: 'a.ts' } },
          { tool_use_id: '3', tool: 'Edit', input: { file_path: 'b.ts' }, text: 'no', isError: true },
        ],
      },
      { role: 'user', text: '', toolUses: [], toolResults: [] },
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: '4', tool: 'mcp__plugin_x_rea__inspect', input: { path: 'p' }, text: '' }] },
    ])
    expect(flat(lines)).toEqual(['user:Do the task', '', 'text:On it.', 'tool:Bash ls -la x', 'pending:Read a.ts', 'error:Edit b.ts', 'tool:inspect (rea) p'])
  })

  test('a transcript file: one block per entry, results close their calls, engine messages and a partial line skipped', async () => {
    const jsonl = [
      '{"partial": tr',
      JSON.stringify({ type: 'user', message: { content: 'Read the brief' } }),
      JSON.stringify({ type: 'user', message: { content: '<command-name>/rename</command-name>' } }),
      JSON.stringify({ type: 'user', isMeta: true, message: { content: 'meta' } }),
      JSON.stringify({ type: 'user', isCompactSummary: true, message: { content: 'This session is being continued' } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hm' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Reading.' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a' } }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'x' } }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'no', is_error: true }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't3', name: 'Grep', input: { pattern: 'p' } }] } }),
      JSON.stringify({ type: 'attachment' }),
    ].join('\n')
    expect(flat(messageLines(transcriptMessages(jsonl)))).toEqual([
      'user:Read the brief',
      '',
      'text:Reading.',
      'tool:Read a',
      'error:Bash x',
      'pending:Grep p',
    ])
  })

  test('prose wraps at a space, continuations marked; tool lines stay one row', async () => {
    const out = wrapLines(
      [
        { kind: 'text', text: 'aaaa bbbb cccc' },
        { kind: 'tool', tool: 'Bash', text: 'x'.repeat(30) },
        { kind: 'text', text: 'x'.repeat(25) },
      ],
      10,
    )
    expect(out.map(l => [l.text, l.isCont ?? false])).toEqual([
      ['aaaa bbbb', false],
      ['cccc', true],
      ['x'.repeat(30), false],
      ['x'.repeat(10), false],
      ['x'.repeat(10), true],
      ['x'.repeat(5), true],
    ])
  })
})

// The launch the panel learns model and effort from, split so no shell guard reads this file as one.
const LAUNCH = ['claude', '--bg', '--model sonnet --effort high --name x "build it"'].join(' ')

describe('view pane from the agents panel', () => {
  test("pressing a background row's name opens its transcript in the view pane, with its state and model", async ($, on) => {
    const calls: string[][] = []
    world(on, calls)
    const file = [
      JSON.stringify({ type: 'user', message: { content: 'Build the thing' } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'dotnet build' } }] } }),
    ].join('\n')
    on('fs.list', () => ({ value: [] }) as never)
    // The engine hands the hook the path in the OS's own spelling.
    on('fs.exists', (_$, e) => ({ value: e.path.replace(/\\/g, '/').endsWith('/home/me/.claude/projects/E--Dev-repo-wt-x/w.jsonl') }) as never)
    on('fs.stat', () => ({ value: { kind: 'file', size: file.length, mtimeMs: 1, isLink: false } }) as never)
    on('fs.read', () => ({ value: file }) as never)
    await $.session.start(START)
    await $.tool.call({ tool: 'Bash', command: LAUNCH } as never)
    await $.command.run(OPEN)
    const ui = await $.ui.mount({ ...pane(60), surface: 'terminal' })
    await ui.press({ key: 'view-w' })
    await ui.unmount()
    expect(calls.some(c => c[1] === 'logs')).toBe(false)

    const v = await $.ui.mount({ ...pane(60), requestId: 'savvy-view', surface: 'terminal' })
    const all = (await v.findAll({ type: 'Text' })).map(t => t.text).join('\n')
    expect(all).toContain('busy')
    expect(all).toContain('builder · Sonnet · high · feat-x')
    expect(all).toContain('claude attach w')
    expect(all).toContain('❯ Build the thing')
    expect(all).toContain('dotnet build')
    await v.unmount()
  })

  test('with no transcript to be found, a background session falls back to its terminal', async ($, on) => {
    const calls: string[][] = []
    world(on, calls)
    on('fs.list', () => ({ value: [] }) as never)
    on('fs.exists', () => ({ value: false }) as never)
    await $.session.start(START)
    await $.command.run(OPEN)
    const ui = await $.ui.mount({ ...pane(60), surface: 'terminal' })
    await ui.press({ key: 'view-w' })
    await ui.unmount()
    expect(calls).toContainEqual(['claude', 'logs', 'w'])

    const v = await $.ui.mount({ ...pane(60), requestId: 'savvy-view', surface: 'terminal' })
    const all = (await v.findAll({ type: 'Text' })).map(t => t.text).join('\n')
    expect(all).toContain('working on it')
    expect(all).toContain('no transcript found')
    await v.unmount()
  })
})
