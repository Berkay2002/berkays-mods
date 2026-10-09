import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Contact, Worker } from '../types'
import {
  asksForYou,
  bodyOf,
  contactFor,
  contactKey,
  cut,
  gitOf,
  isWorker,
  lastOf,
  lookOf,
  parseAgents,
  senderOf,
  sortWorkers,
  stateOf,
  summaryOf,
  age,
} from './lib'

const PANE = 'workers'
const TITLE = 'Workers'
const EVERY_MS = 30_000
const GONE_FOR_MS = 12 * 3600_000
const NARROW = 50

const contacts = atom({ plugin: 'workers', key: 'contacts' } as const, {})
const rows = atom({ plugin: 'workers', key: 'rows' } as const, [])
const others = atom({ plugin: 'workers', key: 'others' } as const, 0)
const updatedAt = atom({ plugin: 'workers', key: 'updatedAt' } as const, 0)
const showAll = atom({ plugin: 'workers', key: 'showAll' } as const, false)
const error = atom({ plugin: 'workers', key: 'error' } as const, null)
const isOpen = atom({ plugin: 'workers', key: 'isOpen' } as const, false)

async function git($: EngineInterface, cwd: string, args: string[]): Promise<string | null> {
  try {
    const r = await $.process.run(['git', '-C', cwd, ...args], { timeoutMs: 5000 })
    return r.exitCode === 0 ? r.stdout.trim() : null
  } catch {
    return null
  }
}

async function gitInfo($: EngineInterface, cwd: string) {
  const branch = await git($, cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (branch === null) return { branch: null, ahead: null, dirty: null }
  const [ahead, status] = await Promise.all([
    git($, cwd, ['rev-list', '--count', 'main..HEAD']),
    git($, cwd, ['status', '--porcelain']),
  ])
  return {
    branch,
    ahead: ahead === null ? null : Number(ahead),
    dirty: status === null ? null : status.split('\n').filter(Boolean).length,
  }
}

let tick: { cancel: () => void } | null = null
let isRefreshing = false

async function refresh($: EngineInterface): Promise<number> {
  if (isRefreshing) return (await read($, rows)).length
  isRefreshing = true
  try {
    const self = await $.session.id()
    const repo = await $.session.repo()
    let agentsOut: string
    try {
      const r = await $.process.run(['claude', 'agents', '--json'], { timeoutMs: 10_000 })
      if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `exit ${r.exitCode}`)
      agentsOut = r.stdout
    } catch (err) {
      await update($, error, () => `Could not list sessions: ${cut(String(err), 100)}`)
      await update($, updatedAt, () => Date.now())
      return (await read($, rows)).length
    }
    const known = await read($, contacts)
    const all = await read($, showAll)
    const now = Date.now()
    const agents = parseAgents(agentsOut).filter(a => a.sessionId !== self)
    const picked = agents.filter(a => all || isWorker(a, known, repo?.root ?? null)).slice(0, 24)
    const live: Worker[] = await Promise.all(
      picked.map(async a => ({
        name: a.name,
        pid: a.pid,
        sessionId: a.sessionId,
        cwd: a.cwd,
        state: stateOf(a.status),
        waitingFor: a.waitingFor ?? null,
        ...(await gitInfo($, a.cwd)),
      })),
    )
    // Workers this session talked to that are no longer running.
    const names = new Set(agents.map(a => a.name))
    const gone: Worker[] = Object.entries(known)
      .filter(([key, c]) => !key.startsWith('pid:') && !names.has(key) && now - c.at < GONE_FOR_MS)
      .map(([name]) => ({
        name,
        pid: 0,
        sessionId: '',
        cwd: '',
        state: 'gone',
        waitingFor: null,
        branch: null,
        ahead: null,
        dirty: null,
      }))
    const list = [...live, ...gone]
    await update($, rows, () => list)
    await update($, others, () => agents.length - live.length)
    await update($, error, () => null)
    await update($, updatedAt, () => now)
    // Only real workers count toward the status line, also while the pane shows every session.
    const workerIds = new Set(agents.filter(a => isWorker(a, known, repo?.root ?? null)).map(a => a.sessionId))
    const isReal = (w: Worker) => w.state === 'gone' || workerIds.has(w.sessionId)
    const needs = list.filter(w => isReal(w) && lookOf(w, contactFor(known, w)).rank === 0).length
    $.ui.status(needs > 0 ? `${needs} worker${needs === 1 ? ' needs' : 's need'} you` : undefined)
    return list.length
  } finally {
    isRefreshing = false
  }
}

async function openPane($: EngineInterface): Promise<void> {
  await $.ui.open({ id: PANE, title: TITLE })
  await update($, isOpen, () => true)
  tick?.cancel()
  tick = $.clock.every(EVERY_MS, () => void refresh($))
}

async function touch($: EngineInterface, key: string, contact: Contact): Promise<void> {
  await update($, contacts, all => ({ ...all, [key]: contact }))
  if (await read($, isOpen)) void refresh($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'workers',
      description: 'Toggle the workers pane (/workers all: every session, /workers refresh)',
    })
    if (await read($, isOpen)) {
      // A reload keeps the pane but not the timer.
      await openPane($)
      void refresh($)
    } else if ((await refresh($)) > 0) {
      await openPane($)
    }
    return started
  })

  on('command.run', { command: 'workers' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'all') {
      const all = !(await read($, showAll))
      await update($, showAll, () => all)
      await openPane($)
      await refresh($)
      return { text: all ? 'Workers pane shows every session' : 'Workers pane shows workers only' }
    }
    if (arg === 'refresh') {
      await openPane($)
      await refresh($)
      return { text: 'Workers pane refreshed' }
    }
    if (await read($, isOpen)) {
      await $.ui.close({ id: PANE })
      return { text: 'Workers pane closed' }
    }
    await openPane($)
    await refresh($)
    return { text: 'Workers pane opened' }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    tick?.cancel()
    tick = null
    await update($, isOpen, () => false)
    return next(e)
  })

  on('session.send', async ($, e, next) => {
    const sent = await next(e)
    if (e.agentId === undefined && sent.isDelivered) {
      await touch($, contactKey(e.to), {
        text: bodyOf(e.text).slice(0, 200),
        at: Date.now(),
        dir: 'out',
        needsYou: false,
      })
    }
    return sent
  })

  on('session.receive', async ($, e, next) => {
    const received = await next(e)
    const isPeer = e.origin.kind === 'peer' || e.origin.kind === 'peer-send-message'
    const from = isPeer && e.agentId === undefined ? senderOf(e.text) : null
    if (from !== null) {
      const body = bodyOf(e.text)
      await touch($, from, { text: body.slice(0, 200), at: Date.now(), dir: 'in', needsYou: asksForYou(body) })
    }
    return received
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const known = await read($, contacts)
    const list = sortWorkers(await read($, rows), known)
    const at = await read($, updatedAt)
    const failed = await read($, error)
    const rest = await read($, others)
    const all = await read($, showAll)
    const now = Date.now()
    const width = Math.max(20, e.props.bodyColumns)
    const isNarrow = width < NARROW

    const footer = (
      <Box flexDirection="row" gap={2} marginTop={1}>
        <Button key="refresh" plain hotkey="r" label="Refresh" onPress={() => void refresh($)} />
        <Button
          key="all"
          plain
          hotkey="a"
          dimColor
          label={all ? 'Workers only' : 'All sessions'}
          onPress={async () => {
            await update($, showAll, v => !v)
            await refresh($)
          }}
        />
      </Box>
    )

    if (at === 0) {
      return (
        <Box flexDirection="column">
          <Text dimColor>Reading sessions…</Text>
        </Box>
      )
    }

    const summary = summaryOf(list, known, all ? 'session' : 'worker') + (rest > 0 && !isNarrow ? ` · ${rest} other` : '')
    const updated = `updated ${age(now - at)} ago`

    return (
      <Box flexDirection="column" width={width}>
        {isNarrow ? (
          <Box flexDirection="column">
            <Text bold wrap="truncate-end">{summary}</Text>
            <Text dimColor>{updated}</Text>
          </Box>
        ) : (
          <Box flexDirection="row" justifyContent="space-between" width={width}>
            <Text bold wrap="truncate-end">{cut(summary, width - updated.length - 2)}</Text>
            <Text dimColor>{updated}</Text>
          </Box>
        )}
        {failed !== null && (
          <Text color="error" wrap="truncate-end">
            ✕ {cut(failed, width - 2)}
          </Text>
        )}
        {list.length === 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>No workers yet</Text>
            <Text dimColor>Start some with /orchestrate</Text>
          </Box>
        )}
        {list.map(w => {
          const c = contactFor(known, w)
          const look = lookOf(w, c)
          const branch = gitOf(w)
          const right = isNarrow ? '' : branch
          const nameRoom = width - 2 - (right ? right.length + 2 : 0)
          const second = isNarrow && branch ? `${branch} · ` : ''
          const last = lastOf(w, c, now, width - 2 - second.length)
          return (
            <Box key={`w-${w.name}`} flexDirection="column" marginTop={1}>
              <Box flexDirection="row" justifyContent="space-between" width={width}>
                <Box flexDirection="row">
                  <Text color={look.color} dimColor={look.dim}>
                    {look.glyph}{' '}
                  </Text>
                  <Button
                    key={`tell-${w.name}`}
                    plain
                    label={cut(w.name, Math.max(4, nameRoom))}
                    dimColor={look.rank === 3}
                    onPress={() => void $.prompt.fill({ text: `Tell ${w.name}: ` })}
                  />
                </Box>
                {right !== '' && <Text dimColor>{right}</Text>}
              </Box>
              <Text dimColor wrap="truncate-end">
                {'  '}
                {second}
                {last}
              </Text>
            </Box>
          )
        })}
        {footer}
      </Box>
    )
  })
}
