import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { sessions } from './sessions.mock'

const env = (name: string, body: string) =>
  `Another Claude session sent a message:\n<cross-session-message from="uds:/tmp/cc-socks/1.sock" from-name="${name}" from-mode="bypass">\n${body}\n</cross-session-message>`

function world(on: On, opts: { hasSendUserFile?: boolean } = {}) {
  const sends: { to: string; text: string }[] = []
  const toasts: string[] = []
  let engineTail: string | undefined
  const files: string[][] = []
  const seen: { tail?: string } = {}
  on('session.send', (_$, e) => {
    sends.push({ to: e.to, text: e.text })
    return { isDelivered: true }
  })
  on('session.receive', (_$, e) => ({ text: e.text }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  // The engine's own hint line: records the tail it is handed.
  on('ui.render', { component: 'PromptHint' }, ($, e) => {
    seen.tail = e.props.tail
    return $.ui.resolve(e).Text({ children: [e.props.hint] })
  })
  mock.env(on, { HOME: '/Users/me' })
  mock.clock(on, { now: 1_000_000 })
  on('tool.list', () => ({
    value:
      opts.hasSendUserFile === false
        ? []
        : [{ name: 'SendUserFile', description: 'send', mcp: false }],
  }))
  on('tool.call', { tool: 'SendUserFile' }, (_$, e) => {
    files.push([...e.files])
    return { result: null, text: 'ok' }
  })
  sessions(on)
  /** The tail the engine would draw on the hint line, given one a hook above already set. */
  const tail = async ($: Engine, existing?: string) => {
    seen.tail = undefined
    await $.ui.mount({
      plugin: 'proof-gate',
      surface: 'terminal',
      component: 'PromptHint',
      props: { isDraft: false, isWorking: false, hint: '? for shortcuts', ...(existing ? { tail: existing } : {}) },
    })
    return seen.tail
  }
  return { sends, toasts, tail, files }
}

test("an orchestrator's message is never read as a worker's report", async ($, on) => {
  const w = world(on)
  await receive($, env('orchestrator', "If the drafts aren't finished yet, use the logo; commit when done. Shots: /tmp/a.png"))
  await receive($, env('unknown-session', 'All done, committed at abc1234.'))
  expect(w.sends).toHaveLength(0)
  expect(w.files).toHaveLength(0)
  expect(await w.tail($)).toBeUndefined()
})

const receive = ($: Engine, text: string) =>
  $.session.receive({ origin: { kind: 'peer' }, text })

test('a done message without proof gets one proof request', async ($, on) => {
  const w = world(on)
  const done = env('brf-app-compare', 'brf-app-compare is done: commit 67b3cc8 on branch worktree-compare.')
  await receive($, done)
  await receive($, done)

  expect(w.sends).toHaveLength(1)
  expect(w.sends[0]?.to).toBe('uds:/tmp/cc-socks/1.sock')
  expect(w.sends[0]?.text).toContain('send screenshots')
  expect(w.toasts).toContain('compare is done · proof requested')
})

test('a message that is not done, or is blocked, is left alone', async ($, on) => {
  const w = world(on)
  await receive($, env('brf-app-ui', 'Part 1 is not done yet, working on the chart.'))
  await receive($, env('brf-app-ui', 'I am blocked: need a decision on colors.'))
  await receive($, 'plain text with no envelope, done.')
  expect(w.sends).toHaveLength(0)
})

test('proof paths are sent to the person and the sender waits for approval', async ($, on) => {
  const w = world(on)
  await receive(
    $,
    env('brf-app-charts', 'Done: commit abc1234. Shots: /tmp/shots/desk.png and ~/shots/mobile.mp4 and rel/x.png'),
  )

  expect(w.sends).toHaveLength(0)
  expect(w.files).toEqual([['/tmp/shots/desk.png', '/Users/me/shots/mobile.mp4']])
  expect(w.toasts[0]).toBe('charts sent proof · 3 files')
  expect(await w.tail($)).toBe('charts to approve')

  await $.session.send({ to: 'brf-app-charts', text: 'note', origin: { kind: 'plugin', name: 'other' } } as never)
  expect(await w.tail($)).toBe('charts to approve')
})

test('a model send to the worker clears it from the hint tail', async ($, on) => {
  const w = world(on, { hasSendUserFile: false })
  await receive($, env('brf-app-pdf', 'Screenshots are in .claude/briefs/east/shots/ now.'))
  expect(w.files).toHaveLength(0)
  expect(await w.tail($)).toBe('pdf to approve')

  await $.session.send({ to: 'brf-app-pdf', text: 'Looks good, merging.', origin: { kind: 'model' } })
  expect(await w.tail($)).toBeUndefined()
})

test('a pre-existing tail is kept and appended to', async ($, on) => {
  const w = world(on, { hasSendUserFile: false })
  expect(await w.tail($, '1 agent')).toBe('1 agent')
  await receive($, env('brf-app-pdf', 'Screenshots are in .claude/briefs/east/shots/ now.'))
  expect(await w.tail($, '1 agent')).toBe('1 agent · pdf to approve')
})

test('the hint tail strips the shared prefix and caps at three names', async ($, on) => {
  const w = world(on, { hasSendUserFile: false })
  for (const n of ['compare', 'charts', 'reading', 'monthly', 'areas']) {
    await $.session.receive({
      origin: { kind: 'peer' },
      text: env(`brf-app-${n}`, `Shots: shots/${n}.png`).replace('1.sock', `${n}.sock`),
    })
  }
  expect(await w.tail($)).toBe('5 to approve · compare, charts, reading +2')
  expect(await w.tail($, 'other')).toBe('other · 5 to approve · compare, charts, reading +2')
})
