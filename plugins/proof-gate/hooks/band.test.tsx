import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { sessions } from './sessions.mock'

const SURFACES = ['terminal', 'desktop'] as const

const env = (name: string, body: string) =>
  `<cross-session-message from="uds:/tmp/cc-socks/${name}.sock" from-name="${name}" from-mode="bypass">\n${body}\n</cross-session-message>`

const props = (bodyColumns: number) => ({
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns,
  scroll: { offset: 0, bodyRows: 9 },
  view: {},
})

function world(on: On) {
  const fills: string[] = []
  mock.clock(on, { now: 1_000_000 })
  mock.env(on, { HOME: '/Users/me' })
  on('session.receive', (_$, e) => ({ text: e.text }))
  on('session.send', () => ({ isDelivered: true }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('tool.list', () => ({ value: [] }))
  // The engine's own band: nothing of its own above the prompt.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })
  on('prompt.fill', (_$, e) => {
    fills.push(e.text)
    return { isFilled: true }
  })
  sessions(on)
  return { fills }
}

for (const surface of SURFACES) {
  test(`band is empty with nothing pending (${surface})`, async ($, on) => {
    world(on)
    const ui = await $.ui.mount({ plugin: 'proof-gate', surface, component: 'AbovePrompt', props: props(100) })
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
    expect(await ui.find({ key: 'engine' })).toBeDefined()
  })

  test(`band lists pending workers with buttons (${surface})`, async ($, on) => {
    const w = world(on)
    for (const n of ['brf-app-compare', 'brf-app-charts', 'brf-app-pdf', 'brf-app-ui']) {
      await $.session.receive({ origin: { kind: 'peer' }, text: env(n, `Shots: /tmp/${n}/a.png /tmp/${n}/b.png`) })
    }
    const ui = await $.ui.mount({ plugin: 'proof-gate', surface, component: 'AbovePrompt', props: props(100) })
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(9)
    expect(await ui.find({ text: '+1 more' })).toBeDefined()
    expect(await ui.find({ text: '2 files · just now' })).toBeDefined()

    await ui.press({ key: 'approve-uds:/tmp/cc-socks/brf-app-compare.sock' })
    await ui.press({ key: 'changes-uds:/tmp/cc-socks/brf-app-charts.sock' })
    expect(w.fills).toEqual(['Approved, merge compare', 'Tell charts: '])
  })

  test(`dismiss drops a worker from the band without filling the prompt (${surface})`, async ($, on) => {
    const w = world(on)
    for (const n of ['brf-app-compare', 'brf-app-charts']) {
      await $.session.receive({ origin: { kind: 'peer' }, text: env(n, `Shots: /tmp/${n}/a.png`) })
    }
    const ui = await $.ui.mount({ plugin: 'proof-gate', surface, component: 'AbovePrompt', props: props(100) })
    await ui.press({ key: 'dismiss-uds:/tmp/cc-socks/brf-app-compare.sock' })
    expect(w.fills).toEqual([])
    const again = await $.ui.mount({ plugin: 'proof-gate', surface, component: 'AbovePrompt', props: props(100) })
    expect(await again.findAll({ type: 'Button' })).toHaveLength(3)
    expect(await again.find({ key: 'dismiss-uds:/tmp/cc-socks/brf-app-charts.sock' })).toBeDefined()
  })
}
