import type { EngineInterface, Register } from 'claude-code'

const GAP_MS = 10 * 60_000
const DAY_MS = 24 * 60 * 60_000
const STALE_LOCK_MS = 2 * 60_000 // a git lock older than this is not a concurrent session
const LAST_PULL = 'last-pull' // { at: ms, error: string }: when we last pulled and what it said
const NOTIFIED = 'notified' // Notified: what the last notices were about, so an unchanged state stays quiet

type Notified = { settings: string; local: boolean; pull: string; at: number } // at: when a notice last went out

// Set by a failed pull at session start; handed to Claude with the first prompt's context.
let note: string | undefined

type Run = { exitCode: number; stdout: string; stderr: string }

const slash = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
const firstLine = (r: Run) =>
  ((r.stderr || r.stdout).split(/\r?\n/).find(l => l.trim()) ?? `exit ${r.exitCode}`).trim()
// A concurrent session is pulling or committing: not worth telling anyone. A lock left behind for minutes is a real failure.
async function isLockRace($: EngineInterface, w: Where, r: Run, now: number) {
  if (!/index\.lock|another git process/i.test(r.stderr + r.stdout)) return false
  // Ask git where the lock is: in a worktree `.git` is a file and the lock lives elsewhere.
  const where = await run($, ['git', '-C', w.shared, 'rev-parse', '--path-format=absolute', '--git-path', 'index.lock'], 5000)
  const lock = where.stdout.trim().split('\n')[0].trim()
  if (where.exitCode !== 0 || !lock) return false // cannot check: report it rather than hide it
  try {
    const { mtimeMs } = await $.fs.stat(lock)
    return now - mtimeMs < STALE_LOCK_MS
  } catch {
    return true // gone already: the other git finished
  }
}

function tell($: EngineInterface, text: string, forClaude = false) {
  $.ui.log(text)
  $.ui.toast(text)
  if (forClaude) note = text
}

// A timeout rejects; report it like a failed exit.
async function run($: EngineInterface, argv: string[], timeoutMs: number, env?: Record<string, string>): Promise<Run> {
  try {
    return await $.process.run(argv, { timeoutMs, env })
  } catch (err) {
    return { exitCode: 1, stdout: '', stderr: err instanceof Error ? err.message : String(err) }
  }
}

type Where = { claudeDir: string; shared: string; isWindows: boolean }

// undefined: not this device's shared config (a private CLAUDE_CONFIG_DIR, or no checkout).
async function locate($: EngineInterface): Promise<Where | undefined> {
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  // `||`: an empty variable falls through. On Windows a corporate HOME can be a network drive; USERPROFILE is the real one.
  const home = slash(
    isWindows
      ? (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || ''
      : (await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || '',
  )
  const claudeDir = `${home}/.claude`
  const shared = `${claudeDir}/shared`
  // Hindsight and other private configs set CLAUDE_CONFIG_DIR; they are not this device's shared config.
  const cfg = await $.env.get('CLAUDE_CONFIG_DIR')
  if (cfg && slash(cfg).toLowerCase() !== claudeDir.toLowerCase()) return
  if (!(await $.fs.exists(`${shared}/.git`))) return
  return { claudeDir, shared, isWindows }
}

// The installer records this same hash after it has applied settings.shared.json.
async function settingsState($: EngineInterface, w: Where) {
  const hash = await run($, ['git', '-C', w.shared, 'hash-object', 'settings.shared.json'], 5000)
  if (hash.exitCode !== 0) return { stale: false, hash: '', installed: '' }
  const current = hash.stdout.trim()
  const installed = await $.fs.read(`${w.claudeDir}/claude-config.installed`).then(
    t => String(t).trim(),
    () => '',
  )
  return { stale: installed !== current, hash: current, installed }
}

async function localChanges($: EngineInterface, w: Where) {
  const git = (...args: string[]) => run($, ['git', '-C', w.shared, ...args], 5000)
  const dirty = (await git('status', '--porcelain')).stdout.trim() !== ''
  const ahead = Number((await git('rev-list', '--count', '@{u}..HEAD')).stdout.trim()) || 0 // no upstream: errors, reads 0
  return { dirty, ahead }
}

async function sync($: EngineInterface) {
  const w = await locate($)
  if (!w) return

  // Read-then-write: two sessions starting together may both pull; a pull is idempotent.
  const now = await $.clock.now()
  const last = (await $.store.get(LAST_PULL)) as { at?: number } | undefined
  if (typeof last?.at === 'number' && now - last.at < GAP_MS) return

  const prev = (((await $.store.get(NOTIFIED)) as Partial<Notified> | undefined) ?? {}) as Partial<Notified>
  const pull = await run($, ['git', '-C', w.shared, 'pull', '--ff-only', '-q'], 15_000, {
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
  })
  const raced = pull.exitCode !== 0 && (await isLockRace($, w, pull, now))
  const pullError = raced ? (prev.pull ?? '') : pull.exitCode !== 0 ? firstLine(pull) : ''
  await $.store.set(LAST_PULL, { at: now, error: pullError })

  const { dirty, ahead } = await localChanges($, w)
  const s = await settingsState($, w)
  const state = { settings: s.stale ? s.hash : '', local: dirty || ahead > 0, pull: pullError }

  // A new or changed state is announced at once; an unchanged bad one again after a day.
  const again = now - (prev.at ?? 0) > DAY_MS
  let told = false
  if (state.pull && (state.pull !== prev.pull || again)) {
    tell($, `claude-config pull failed: ${state.pull}`, true)
    told = true
  }
  if (state.local && (!prev.local || again)) {
    const host = (await $.env.get('COMPUTERNAME')) || (await $.env.get('HOSTNAME')) || 'this device'
    tell($, `claude-config has local changes on ${host}; push them`)
    told = true
  }
  if (state.settings && (state.settings !== prev.settings || again)) {
    tell($, 'Shared settings changed: run /config-sync apply')
    told = true
  }
  await $.store.set(NOTIFIED, { ...state, at: told ? now : (prev.at ?? now) })
}

async function apply($: EngineInterface) {
  const w = await locate($)
  if (!w) return 'config-sync: ~/.claude/shared is not a git checkout here, or CLAUDE_CONFIG_DIR is set to a private config; nothing to apply.'
  const argv = w.isWindows
    ? ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', `${w.shared}/install.ps1`]
    : ['bash', `${w.shared}/install.sh`]
  const r = await run($, argv, 300_000) // plugin installs can be slow
  return r.exitCode === 0
    ? 'Applied new shared settings (backup in ~/.claude/backups)'
    : `claude-config install failed: ${firstLine(r)}`
}

async function status($: EngineInterface) {
  const w = await locate($)
  if (!w) return 'config-sync: ~/.claude/shared is not a git checkout here, or CLAUDE_CONFIG_DIR is set to a private config.'
  const last = (await $.store.get(LAST_PULL)) as { at?: number; error?: string } | undefined
  const pull =
    typeof last?.at !== 'number'
      ? 'not pulled yet'
      : `${Math.round(((await $.clock.now()) - last.at) / 60_000)} min ago, ${last.error ? `failed: ${last.error}` : 'ok'}`
  const s = await settingsState($, w)
  const { dirty, ahead } = await localChanges($, w)
  const local = [dirty && 'uncommitted changes', ahead > 0 && `${ahead} unpushed commit${ahead === 1 ? '' : 's'}`].filter(Boolean)
  return [
    `Last pull: ${pull}`,
    `Settings: ${s.hash ? (s.stale ? `changed (installed ${s.installed || 'none'}, current ${s.hash}); run /config-sync apply` : `up to date (${s.hash})`) : 'cannot hash settings.shared.json'}`,
    `Local: ${local.length ? local.join(', ') : 'clean'}`,
  ].join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    note = undefined
    const result = await next(e)
    await $.command.register({
      name: 'config-sync',
      description: 'Show the claude-config sync status, or apply new shared settings',
      argumentHint: '[apply]',
    })
    // Off the critical path: a slow or offline pull must not hold up the session starting.
    void sync($).catch(err => tell($, `claude-config sync failed: ${err instanceof Error ? err.message : String(err)}`))
    return result
  })

  on('command.run', { command: 'config-sync' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'apply') return { text: await apply($) }
    if (arg === '') return { text: await status($) }
    return { text: 'Usage: /config-sync or /config-sync apply' }
  })

  on('prompt.context', async ($, e, next) => {
    const r = await next(e)
    return note ? { ...r, blocks: [...r.blocks, { name: 'configSync', text: note }] } : r
  })
}
