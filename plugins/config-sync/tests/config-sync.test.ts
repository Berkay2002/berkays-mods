import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const SHARED = 'C:/Users/me/.claude/shared'
const NOW = Date.parse('2026-10-09T10:00:00Z')
const HASH = 'abc123'
const PULL = ['git', '-C', SHARED, 'pull', '--ff-only', '-q']
const SETTINGS_CHANGED = 'Shared settings changed: run /config-sync apply'

// The engine hands fs paths over in the host's separators.
const fwd = (p: string) => p.split('\\').join('/')

type Result = { exitCode?: number; stderr?: string; stdout?: string }
type Opts = {
  env?: Record<string, string>
  hasRepo?: boolean
  installed?: string // contents of claude-config.installed; undefined = file missing
  fail?: Record<string, Result> // by git subcommand or 'install'
  dirty?: boolean
  ahead?: number
  stored?: Record<string, unknown>
  lockPath?: string // where git says index.lock is (a worktree's lives outside shared/.git)
  lockAge?: number // ms; an index.lock of that age exists in .git
}

function world(on: On, o: Opts = {}) {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { HOME: 'C:\\Users\\me', OS: 'Windows_NT', COMPUTERNAME: 'DESKTOP', ...o.env })
  mock.store(on, o.stored)
  const seen = { argv: [] as string[][], envs: [] as unknown[], logs: [] as string[], toasts: [] as string[] }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('prompt.context', (_$, e) => ({ blocks: e.blocks }))
  on('fs.exists', (_$, e) => ({ value: (o.hasRepo ?? true) && fwd(e.path) === `${SHARED}/.git` }))
  on('fs.read', (_$, e) => {
    if (o.installed !== undefined && fwd(e.path) === 'C:/Users/me/.claude/claude-config.installed') return { value: o.installed }
    throw new Error('ENOENT')
  })
  on('ui.log', (_$, e) => {
    seen.logs.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('process.run', (_$, e) => {
    const argv = [...e.argv]
    seen.argv.push(argv)
    seen.envs.push(e.init?.env)
    const sub = /install\.(ps1|sh)$/.test(argv[argv.length - 1]) ? 'install' : argv[3]
    const f = o.fail?.[sub]
    let stdout = f?.stdout ?? ''
    if (!f) {
      if (sub === 'status') stdout = o.dirty ? ' M CLAUDE.md\n' : ''
      if (sub === 'rev-list') stdout = `${o.ahead ?? 0}\n`
      if (sub === 'hash-object') stdout = `${HASH}\n`
      if (sub === 'rev-parse') stdout = `${o.lockPath ?? `${SHARED}/.git/index.lock`}\n`
    }
    return {
      value: { exitCode: f ? (f.exitCode ?? 1) : 0, stdout, stderr: f?.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  on('fs.stat', (_$, e) => {
    if (o.lockAge !== undefined && fwd(e.path) === (o.lockPath ?? `${SHARED}/.git/index.lock`))
      return { value: { kind: 'file' as const, size: 0, mtimeMs: NOW - o.lockAge, isLink: false } }
    throw new Error('ENOENT')
  })
  settle = () => clock.settle()
  return { clock, seen }
}

let settle = async () => {}
// The sync runs after session.start has returned; let it finish.
const start = async ($: Engine) => {
  await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
  await settle()
}
const cmd = async ($: Engine, args = '') =>
  (
    await $.command.run({
      command: 'config-sync',
      args,
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 120 },
    })
  ).text
const ranInstaller = (argv: string[][]) => argv.some(a => /install\.(ps1|sh)$/.test(a[a.length - 1]))
const context = async ($: Engine) =>
  (await $.prompt.context({ blocks: [{ name: 'userEmail', text: 'x' }] })).blocks.map(b => b.text)

test('skips a private config dir', async ($, on) => {
  const { seen } = world(on, { env: { CLAUDE_CONFIG_DIR: 'D:\\hindsight\\cfg' } })
  await start($)
  expect(seen.argv).toEqual([])
})

test('skips when ~/.claude/shared is not a git checkout', async ($, on) => {
  const { seen } = world(on, { hasRepo: false })
  await start($)
  expect(seen.argv).toEqual([])
})

test('CLAUDE_CONFIG_DIR equal to ~/.claude still runs', async ($, on) => {
  const { seen } = world(on, { env: { CLAUDE_CONFIG_DIR: 'C:\\Users\\me\\.claude\\' }, installed: HASH })
  await start($)
  expect(seen.argv[0]).toEqual(PULL)
})

test('Windows prefers USERPROFILE over a corporate HOME; empty values fall through', async ($, on) => {
  const { seen } = world(on, { env: { HOME: 'H:\\', USERPROFILE: 'C:\\Users\\me' }, installed: HASH })
  await start($)
  expect(seen.argv[0]).toEqual(PULL)
})

test('an empty USERPROFILE falls through to HOME', async ($, on) => {
  const { seen } = world(on, { env: { USERPROFILE: '' }, installed: HASH })
  await start($)
  expect(seen.argv[0]).toEqual(PULL)
})

test('pull runs without prompting for credentials', async ($, on) => {
  const { seen } = world(on, { installed: HASH })
  await start($)
  expect(seen.envs[0]).toEqual({ GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' })
})

test('quiet when pulled, clean and the installed hash matches; never runs the installer', async ($, on) => {
  const { seen } = world(on, { installed: `${HASH}\n` })
  await start($)
  expect(seen.argv[0]).toEqual(PULL)
  expect(ranInstaller(seen.argv)).toBe(false)
  expect(seen.logs).toEqual([])
  expect(seen.toasts).toEqual([])
  expect(await context($)).toEqual(['x'])
})

test('hash mismatch: one notice, the installer is not run', async ($, on) => {
  const { seen } = world(on, { installed: 'old' })
  await start($)
  expect(seen.argv).toContainEqual(['git', '-C', SHARED, 'hash-object', 'settings.shared.json'])
  expect(ranInstaller(seen.argv)).toBe(false)
  expect(seen.logs).toEqual([SETTINGS_CHANGED])
  expect(seen.toasts).toEqual([SETTINGS_CHANGED])
})

test('a missing marker file counts as changed', async ($, on) => {
  const { seen } = world(on, { installed: undefined })
  await start($)
  expect(seen.logs).toEqual([SETTINGS_CHANGED])
})

test('throttles the pull to one per 10 minutes', async ($, on) => {
  const { seen, clock } = world(on, { installed: HASH })
  await start($)
  const first = seen.argv.length
  await clock.advance(9 * 60_000)
  await start($)
  expect(seen.argv.length).toBe(first)
  await clock.advance(61_000)
  await start($)
  expect(seen.argv.length).toBe(first * 2)
})

test('a recent pull in the store throttles a fresh process', async ($, on) => {
  const { seen } = world(on, { installed: HASH, stored: { 'last-pull': { at: NOW - 60_000, error: '' } } })
  await start($)
  expect(seen.argv).toEqual([])
})

test('the same state is not announced again after the throttle', async ($, on) => {
  const { seen, clock } = world(on, { installed: 'old', dirty: true })
  await start($)
  expect(seen.logs).toEqual(['claude-config has local changes on DESKTOP; push them', SETTINGS_CHANGED])
  await clock.advance(11 * 60_000)
  await start($)
  expect(seen.logs.length).toBe(2)
})

test('pull failure: notice with the first error line, a context note, and told once', async ($, on) => {
  const msg = 'claude-config pull failed: fatal: Not possible to fast-forward, aborting.'
  const { seen, clock } = world(on, {
    installed: HASH,
    fail: { pull: { exitCode: 128, stderr: '\nfatal: Not possible to fast-forward, aborting.\nhint: x' } },
  })
  await start($)
  expect(seen.logs).toEqual([msg])
  expect(seen.toasts).toEqual([msg])
  expect(await context($)).toEqual(['x', msg])
  await clock.advance(11 * 60_000)
  await start($)
  expect(seen.logs).toEqual([msg])
})

test('an index.lock race with another session is not announced', async ($, on) => {
  const { seen } = world(on, {
    installed: HASH,
    lockAge: 5000,
    fail: { pull: { exitCode: 128, stderr: "fatal: Unable to create '.../.git/index.lock': File exists." } },
  })
  await start($)
  expect(seen.logs).toEqual([])
  expect(await context($)).toEqual(['x'])
})

test('an index.lock left behind for minutes is reported as a pull failure', async ($, on) => {
  const { seen } = world(on, {
    installed: HASH,
    lockAge: 5 * 60_000,
    fail: { pull: { exitCode: 128, stderr: "fatal: Unable to create '.../.git/index.lock': File exists." } },
  })
  await start($)
  expect(seen.logs).toEqual(["claude-config pull failed: fatal: Unable to create '.../.git/index.lock': File exists."])
})

test('an unchanged bad state is announced again after a day, not before', async ($, on) => {
  const { seen, clock } = world(on, { installed: 'old' })
  await start($)
  expect(seen.logs).toEqual([SETTINGS_CHANGED])
  await clock.advance(23 * 60 * 60_000)
  await start($)
  expect(seen.logs.length).toBe(1)
  await clock.advance(2 * 60 * 60_000)
  await start($)
  expect(seen.logs).toEqual([SETTINGS_CHANGED, SETTINGS_CHANGED])
})

test('session.start does not wait for the pull', async ($, on) => {
  const { seen } = world(on, { installed: 'old' })
  await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
  expect(seen.logs).toEqual([]) // nothing yet: the sync is still in flight
  await settle()
  expect(seen.logs).toEqual([SETTINGS_CHANGED])
})

test('in a worktree the lock is found where git says it is', async ($, on) => {
  const { seen } = world(on, {
    installed: HASH,
    lockPath: 'C:/Users/me/.claude/shared-main/.git/worktrees/shared/index.lock',
    lockAge: 5 * 60_000,
    fail: { pull: { exitCode: 128, stderr: "fatal: Unable to create 'index.lock': File exists." } },
  })
  await start($)
  expect(seen.logs).toEqual(["claude-config pull failed: fatal: Unable to create 'index.lock': File exists."])
})

test('a dirty tree notices', async ($, on) => {
  const { seen } = world(on, { installed: HASH, dirty: true })
  await start($)
  expect(seen.logs).toEqual(['claude-config has local changes on DESKTOP; push them'])
})

test('unpushed commits notice', async ($, on) => {
  const { seen } = world(on, { installed: HASH, ahead: 2 })
  await start($)
  expect(seen.logs).toEqual(['claude-config has local changes on DESKTOP; push them'])
})

test('/config-sync apply runs the Windows installer and reports success', async ($, on) => {
  const { seen } = world(on, { installed: 'old' })
  expect(await cmd($, 'apply')).toBe('Applied new shared settings (backup in ~/.claude/backups)')
  expect(seen.argv.at(-1)).toEqual(['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', `${SHARED}/install.ps1`])
})

test('/config-sync apply runs install.sh off Windows', async ($, on) => {
  const { seen } = world(on, { env: { OS: '' }, installed: 'old' })
  await cmd($, 'apply')
  expect(seen.argv.at(-1)).toEqual(['bash', `${SHARED}/install.sh`])
})

test('/config-sync apply reports the installer first error line', async ($, on) => {
  world(on, { installed: 'old', fail: { install: { exitCode: 1, stderr: 'Install jq first.\nmore' } } })
  expect(await cmd($, 'apply')).toBe('claude-config install failed: Install jq first.')
})

test('/config-sync shows status; unknown arguments show usage', async ($, on) => {
  world(on, { installed: 'old', dirty: true, ahead: 1 })
  await start($)
  const text = await cmd($)
  expect(text).toContain('Last pull: 0 min ago, ok')
  expect(text).toContain('changed (installed old, current abc123); run /config-sync apply')
  expect(text).toContain('Local: uncommitted changes, 1 unpushed commit')
  expect(await cmd($, 'nope')).toBe('Usage: /config-sync or /config-sync apply')
})
