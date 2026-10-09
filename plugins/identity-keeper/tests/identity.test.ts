import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { roleCard } from '../hooks/register'

const BRIEF =
  'You are brf-app-reading, a background worker orchestrated by the session brf-orchestrator. Read AGENTS.md, then your brief.'
const ENVELOPE =
  '<cross-session-message from="uds:/tmp/cc-socks/21428.sock" from-name="brf-orchestrator" from-mode="bypass">Part 1 merged.</cross-session-message>'
const SUMMARY = [{ role: 'user' as const, text: 'summary', toolUses: [] }]
const PRESENTATION = { isFullscreen: false, columns: 120 }
const ME = { kind: 'composer' as const }

// The engine beneath the plugin: a session id, /rename, compaction, the
// prompt box and toasts, each recorded. The role card's content is checked
// through roleCard; the engine lets session.append through, so its toast shows.
const world = (on: On, options: { renameFails?: boolean } = {}) => {
  const clock = mock.clock(on)
  mock.store(on)
  const seen = { renames: [] as string[], toasts: [] as string[], filled: [] as string[] }
  on('session.id', () => ({ value: 'test-session' }))
  on('command.run', { command: 'rename' }, (_$, e) => {
    if (options.renameFails && e.origin.kind === 'plugin') throw new Error('busy')
    seen.renames.push(e.args)
    return { text: '' }
  })
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('prompt.fill', (_$, e) => {
    seen.filled.push(e.text)
    return { isFilled: true }
  })
  on('session.receive', (_$, e) => ({ text: e.text }))
  on('session.compact', () => ({ messages: SUMMARY }))
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  const tick = async () => {
    await clock.advance(1)
    await clock.settle()
  }
  return { seen, tick }
}

test('role card carries the name, the brief and the orchestrator', () => {
  const card = roleCard({
    name: 'brf-app-reading',
    source: 'first-prompt',
    firstPrompt: BRIEF,
    orchestrator: { address: 'uds:/tmp/cc-socks/21428.sock', name: 'brf-orchestrator' },
  })
  expect(card).toContain('You are brf-app-reading.')
  expect(card).toContain('Read AGENTS.md')
  expect(card).toContain('brf-orchestrator at uds:/tmp/cc-socks/21428.sock')
  expect(roleCard({ firstPrompt: BRIEF })).toBeNull()
  expect(roleCard({ name: 'x-y', firstPrompt: 'a'.repeat(2000) })?.length).toBeLessThan(800)
})

test('learns the name from the first prompt, then re-applies it quietly after compaction', async ($, on) => {
  const { seen, tick } = world(on)

  await $.prompt.submit({ text: BRIEF, origin: ME, wait: false })
  await tick()
  expect(seen.renames).toEqual(['brf-app-reading'])
  expect(seen.toasts).toEqual(['Renamed to brf-app-reading'])

  await $.session.receive({ origin: { kind: 'peer-send-message' }, text: ENVELOPE })

  const result = await $.session.compact({ trigger: 'auto', messages: SUMMARY })
  expect(result.messages).toEqual(SUMMARY)
  await tick()

  expect(seen.renames).toEqual(['brf-app-reading', 'brf-app-reading'])
  // The name is re-applied silently; only the role card announces itself.
  expect(seen.toasts).toEqual(['Renamed to brf-app-reading', 'Role card restored after compaction'])
})

test('remembers a /rename the person runs and leaves precompute alone', async ($, on) => {
  const { seen, tick } = world(on)

  await $.command.run({ command: 'rename', args: 'brf-orchestrator', origin: ME, presentation: PRESENTATION })
  expect(seen.toasts).toEqual([])

  await $.session.compact({ trigger: 'precompute', messages: SUMMARY })
  await tick()
  expect(seen.renames).toEqual(['brf-orchestrator'])

  await $.session.compact({ trigger: 'manual', messages: SUMMARY })
  await tick()
  expect(seen.renames).toEqual(['brf-orchestrator', 'brf-orchestrator'])
})

test('ignores prompts without a hyphenated role name and stays quiet', async ($, on) => {
  const { seen, tick } = world(on)

  await $.prompt.submit({ text: 'You are Claude Code. Fix the bug.', origin: ME, wait: false })
  await tick()
  await $.session.compact({ trigger: 'auto', messages: SUMMARY })
  await tick()

  expect(seen.renames).toEqual([])
  expect(seen.toasts).toEqual([])
})

test('falls back to the prompt box when /rename cannot run', async ($, on) => {
  const { seen, tick } = world(on, { renameFails: true })

  await $.prompt.submit({ text: BRIEF, origin: ME, wait: false })
  await tick()

  expect(seen.filled).toEqual(['/rename brf-app-reading'])
  expect(seen.toasts).toEqual(['Press Enter to rename to brf-app-reading'])
})

test('/identity reports and forgets', async ($, on) => {
  const { tick } = world(on)
  const run = (args: string) =>
    $.command.run({ command: 'identity', args, origin: ME, presentation: PRESENTATION })

  expect((await run('')).text).toBe('No name kept for this session')

  await $.prompt.submit({ text: BRIEF, origin: ME, wait: false })
  await $.session.receive({ origin: { kind: 'peer-send-message' }, text: ENVELOPE })
  await tick()

  expect((await run('')).text).toBe(
    [
      'Name: brf-app-reading (from first prompt)',
      'Orchestrator: brf-orchestrator · uds:/tmp/cc-socks/21428.sock',
      'Role card: active after each compaction',
    ].join('\n'),
  )
  expect((await run('forget')).text).toBe('Forgot the name and role card for this session')
  expect((await run('')).text).toBe('No name kept for this session')
  expect((await run('forget')).text).toBe('Nothing kept for this session')
  expect((await run('what')).text).toBe('Usage: /identity or /identity forget')
})
