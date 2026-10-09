import type { EngineInterface, Register } from 'claude-code'

import type { LedgerEntry } from '../types'

const PREFIX = 'ledger:'
const CAP = 2000
const DAY = 86_400_000

const MODELS = ['haiku', 'sonnet', 'opus', 'fable']
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

// "claude-opus-5-5[1m]" -> "opus". `best` is Opus (as effort-gate reads it); anything unknown is kept as typed.
const family = (m: string) => {
  const s = m.toLowerCase()
  return MODELS.find(f => s.includes(f)) ?? (s === 'best' ? 'opus' : s)
}

// First `key: value` of the file's frontmatter, unquoted.
function front(text: string, key: string) {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? ''
  const v = new RegExp(`^${key}` + String.raw`:\s*(.+?)\s*$`, 'm').exec(block)?.[1]
  return v?.replace(/^["']|["']$/g, '')
}

// Project agents shadow user agents. A missing file is just "no frontmatter".
async function agentFile($: EngineInterface, agent: string): Promise<{ model?: string; effort?: string }> {
  const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || ''
  const cwd = await $.session.cwd()
  for (const dir of [`${cwd}/.claude/agents`, `${home}/.claude/agents`]) {
    try {
      const text = await $.fs.read(`${dir}/${agent}.md`)
      if (typeof text === 'string' && text) return { model: front(text, 'model'), effort: front(text, 'effort') }
    } catch {}
  }
  return {}
}

// ---- reading `claude ... --bg` out of a shell command ----

type Tok = { text: string; quoted: boolean } // quoted: the word began inside quotes (a prompt, never a flag)

// Splits a command into segments (at unquoted ; | & newline) of words (at unquoted whitespace).
// ponytail: no heredocs, backticks, $(...) or backslash escapes outside quotes; an odd apostrophe swallows the rest, which only hides flags.
export function split(cmd: string): Tok[][] {
  const segs: Tok[][] = [[]]
  let cur = ''
  let has = false
  let startQ = false
  let q: string | null = null
  const word = () => {
    if (has) segs[segs.length - 1]!.push({ text: cur, quoted: startQ })
    cur = ''
    has = false
    startQ = false
  }
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!
    if (q) {
      if (c === q) q = null
      else if (c === '\\' && q === '"' && cmd[i + 1] === '"') cur += cmd[++i]
      else cur += c
    } else if (c === '"' || c === "'") {
      if (!has) startQ = true
      has = true
      q = c
    } else if (c === '\n' || c === ';' || c === '|' || c === '&') {
      word()
      if (segs[segs.length - 1]!.length) segs.push([])
    } else if (/\s/.test(c)) word()
    else {
      cur += c
      has = true
    }
  }
  word()
  return segs.filter(s => s.length)
}

const VALUE_FLAGS: Record<string, 'model' | 'effort' | 'agent' | 'advisor' | 'name'> = {
  '--model': 'model',
  '--effort': 'effort',
  '--agent': 'agent',
  '--advisor': 'advisor',
  '--name': 'name',
  '-n': 'name',
}
export type BgLaunch = Partial<Record<(typeof VALUE_FLAGS)[string], string>>

const SHELL = /^(?:(?:ba|z|da|k|c)?sh|pwsh|powershell|cmd)(?:\.exe)?$/i

// Every `claude ... --bg/--background` segment. `claude` must be the segment's command word (after FOO=bar
// assignments; a path ending in claude or claude.exe is fine); flags are read only from unquoted words, and a
// quoted word counts only as the value right after a flag that takes one. `sh -c "..."` is read inside.
export function bgLaunches(cmd: string): BgLaunch[] {
  const out: BgLaunch[] = []
  for (const seg of split(cmd)) {
    let i = 0
    while (i < seg.length && !seg[i]!.quoted && /^[A-Za-z_]\w*=/.test(seg[i]!.text)) i++
    const word = seg[i]?.text.split(/[\\/]/).pop() ?? ''
    if (SHELL.test(word)) {
      const k = seg.findIndex((t, n) => n > i && !t.quoted && /^[-/](?:c|command)$/i.test(t.text))
      if (k >= 0) {
        const rest = seg.slice(k + 1)
        out.push(...bgLaunches(rest.length === 1 ? rest[0]!.text : rest.map(t => (t.quoted ? JSON.stringify(t.text) : t.text)).join(' ')))
      }
      continue
    }
    if (!/^claude(?:\.exe)?$/i.test(word)) continue
    const found: BgLaunch = {}
    let bg = false
    for (let j = i + 1; j < seg.length; j++) {
      const t = seg[j]!
      if (t.quoted) continue
      if (t.text === '--') break
      const m = /^(--[a-z-]+|-n)(?:=(.*))?$/i.exec(t.text)
      if (!m) continue
      if (m[1] === '--bg' || m[1] === '--background') {
        bg = true
        continue
      }
      const key = VALUE_FLAGS[m[1]!.toLowerCase()]
      if (!key) continue
      let v = m[2]
      const next = seg[j + 1]
      if (v === undefined && next && (next.quoted || !next.text.startsWith('-'))) {
        v = next.text
        j++
      }
      if (v !== undefined) found[key] = v
    }
    if (bg) out.push(found)
  }
  return out
}

// ---- ledger ----

async function mainModel($: EngineInterface) {
  try {
    return await $.session.model()
  } catch {
    return 'opus' // not exposed: treat the inherited model as Opus
  }
}

async function repoName($: EngineInterface) {
  let dir: string | undefined
  try {
    dir = (await $.session.repo())?.root
  } catch {}
  dir ??= await $.session.cwd()
  return dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || dir
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
const clip = (s: string) => s.slice(0, 80)
const tag = (model: string, effort?: string) => `${model}@${effort ?? '?'}`

// Higher on the ladder: model first, then effort within the same model (compared only when both are known).
function higher(a: LedgerEntry, b: LedgerEntry) {
  const ma = MODELS.indexOf(a.model)
  const mb = MODELS.indexOf(b.model)
  if (ma !== mb) return mb > ma
  const ea = EFFORTS.indexOf(a.effort ?? '')
  const eb = EFFORTS.indexOf(b.effort ?? '')
  return ea >= 0 && eb >= 0 && eb > ea
}

// The store is one file shared by every Claude Code process, so each session writes only its own key.
// Writes in this process run one after another, so parallel launches do not overwrite each other.
// ponytail: a session's whole entry list is rewritten per change (<= 2000 small entries).
let queue: Promise<unknown> = Promise.resolve()
const edit = (fn: () => Promise<void>) => {
  queue = queue.then(fn, fn).catch(() => {}) // never let a ledger problem reach the tool call
  return queue
}

const load = async ($: EngineInterface, key: string) => ((await $.store.get(key)) as LedgerEntry[] | undefined) ?? []

const change = ($: EngineInterface, key: string, fn: (all: LedgerEntry[]) => void) =>
  edit(async () => {
    const all = await load($, key)
    fn(all)
    await $.store.set(key, all.slice(-CAP))
  })

async function loadAll($: EngineInterface) {
  const keys = ((await $.store.keys()) as string[]).filter(k => k.startsWith(PREFIX))
  return (await Promise.all(keys.map(k => load($, k)))).flat().sort((a, b) => a.ts - b.ts)
}

// A retry is a later launch in the same session with the same label, once the earlier one has finished
// (a bg launch has no outcome to wait for). Escalated: the retry runs higher on the ladder.
function link(all: LedgerEntry[], entry: LedgerEntry) {
  const prev = all.find(x => x.id === entry.prev)
  delete entry.prev
  if (!prev) return
  prev.retried = true
  if (higher(prev, entry)) prev.escalatedTo = tag(entry.model, entry.effort)
}

type Launch = Pick<LedgerEntry, 'kind' | 'agent' | 'model' | 'effort' | 'advisor' | 'label' | 'running'>

// Appends the launch and returns once it is written. `now` links retries at once (bg); a subagent links when
// its outcome (and so its real model) is known.
async function launch($: EngineInterface, l: Launch, now: boolean) {
  const sid = await $.session.id()
  const key = PREFIX + sid
  const entry: LedgerEntry = {
    ...l,
    id: Math.random().toString(36).slice(2),
    ts: await $.clock.now(),
    sid,
    repo: await repoName($),
    label: clip(l.label),
  }
  await change($, key, all => {
    const k = norm(entry.label)
    if (k) {
      const prev = [...all].reverse().find(x => x.sid === sid && norm(x.label) === k)
      if (prev && !prev.running) entry.prev = prev.id
    }
    all.push(entry)
    if (now) link(all, entry)
  })
  return { key, id: entry.id }
}

type Ref = { key: string; id: string }

const finish = ($: EngineInterface, ref: Ref, patch: Partial<LedgerEntry>) =>
  change($, ref.key, all => {
    const entry = all.find(x => x.id === ref.id)
    if (!entry) return // already dropped by the cap
    Object.assign(entry, patch)
    if (!patch.agentId) delete entry.running // a background subagent runs on until its turn ends
    link(all, entry)
  })

const drop = ($: EngineInterface, refs: Ref[]) =>
  Promise.all(
    [...new Set(refs.map(r => r.key))].map(key =>
      change($, key, all => {
        const gone = new Set(refs.filter(r => r.key === key).map(r => r.id))
        all.splice(0, all.length, ...all.filter(x => !gone.has(x.id)))
      }),
    ),
  )

// Background subagents end later, in their own turns. In-process: agent ids whose outcome is awaited.
const watching = new Set<string>()

// Keeps the total near CAP: sessions whose newest entry is older than the CAPth newest entry overall go.
async function prune($: EngineInterface) {
  const keys = ((await $.store.keys()) as string[]).filter(k => k.startsWith(PREFIX))
  const lists = await Promise.all(keys.map(async k => [k, await load($, k)] as const))
  const ts = lists.flatMap(([, l]) => l.map(x => x.ts)).sort((a, b) => b - a)
  if (ts.length <= CAP) return
  const cutoff = ts[CAP - 1]!
  for (const [k, l] of lists) if (!l.length || l[l.length - 1]!.ts < cutoff) await $.store.delete(k)
}

// ---- review ----

const median = (xs: number[]) => {
  if (!xs.length) return undefined
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2)
}
const fmtTokens = (n?: number) => (n === undefined ? '-' : n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n))
const fmtMs = (n?: number) => {
  if (n === undefined) return '-'
  const s = Math.round(n / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

export function review(all: LedgerEntry[], days: number, now: number) {
  const entries = all.filter(x => x.ts >= now - days * DAY)
  if (!entries.length) return `routing-review: no launches in the last ${days}d`
  const groups = new Map<string, LedgerEntry[]>()
  for (const x of entries) {
    const k = `${tag(x.model, x.effort)}\t${x.agent ?? '-'}`
    groups.set(k, [...(groups.get(k) ?? []), x])
  }
  const rows = [['model@effort', 'agent', 'n', 'ok', 'err', 'retry', 'esc', 'tok~', 'time~']]
  for (const [k, g] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
    const [route, agent] = k.split('\t')
    rows.push([
      route!,
      agent!,
      String(g.length),
      String(g.filter(x => x.ok === true).length),
      String(g.filter(x => x.ok === false).length),
      String(g.filter(x => x.retried).length),
      String(g.filter(x => x.escalatedTo).length),
      fmtTokens(median(g.flatMap(x => (x.tokens === undefined ? [] : [x.tokens])))),
      fmtMs(median(g.flatMap(x => (x.ms === undefined ? [] : [x.ms])))),
    ])
  }
  const w = rows[0]!.map((_, i) => Math.max(...rows.map(r => r[i]!.length)))
  const out = [
    `routing-review: last ${days}d, ${entries.length} launches (ok/err/tok/time only where an outcome was seen: subagents; bg sessions have none, so ok+err < n)`,
    ...rows.map(r => r.map((c, i) => c.padEnd(w[i]!)).join('  ').trimEnd()),
  ]
  const esc = entries.filter(x => x.escalatedTo).slice(-5).reverse()
  if (esc.length) {
    out.push('', 'Recent escalations:')
    for (const x of esc) out.push(`- ${x.label}: ${tag(x.model, x.effort)} -> ${x.escalatedTo}`)
  }
  return out.join('\n')
}

// ---- hooks ----

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({
      name: 'routing-review',
      description: 'Per model@effort launches, outcomes, retries and escalations of delegated workers',
      argumentHint: '[days]',
    })
    try {
      await prune($)
    } catch {}
    return result
  })

  on('command.run', { command: 'routing-review' }, async ($, e) => {
    const days = Math.max(Number.parseFloat(e.args.trim()), 0) || 14
    return { text: review(await loadAll($), days, await $.clock.now()) }
  })

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    if (e.subagent_type === 'fork') return next(e) // forks inherit the parent; nothing to tune
    let ref: Ref | undefined
    try {
      const def = e.subagent_type ? await agentFile($, e.subagent_type) : {}
      let model = e.model ?? def.model
      if (!model || model === 'inherit') model = await mainModel($)
      ref = await launch(
        $,
        {
          kind: 'subagent',
          agent: e.subagent_type,
          model: family(model),
          effort: e.effort ?? def.effort,
          label: e.description ?? '',
          running: true,
        },
        false,
      )
    } catch {}
    const ran = await next(e)
    if (!ref) return ran
    try {
      if (ran.deny !== undefined) {
        await drop($, [ref]) // refused: nothing ran
        return ran
      }
      // Agent calls usually run in the background here: the result then says so and carries no usage.
      const r = (ran.result ?? {}) as {
        status?: string
        agentId?: string
        resolvedModel?: string
        totalDurationMs?: number
        totalTokens?: number
      }
      const patch: Partial<LedgerEntry> = r.resolvedModel ? { model: family(r.resolvedModel) } : {}
      if (ran.isError === true) patch.ok = false
      else if (r.status === 'completed') Object.assign(patch, { ok: true, ms: r.totalDurationMs, tokens: r.totalTokens })
      else if (r.status === 'async_launched' && r.agentId) {
        patch.agentId = r.agentId
        watching.add(r.agentId)
      }
      await finish($, ref, patch)
    } catch {}
    return ran
  })

  // The outcome of a background subagent: its own turns end here, carrying its agent id.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId || !watching.has(e.agentId)) return result
    try {
      const agentId = e.agentId
      const key = PREFIX + (await $.session.id())
      const u = e.usage
      await change($, key, all => {
        const entry = all.find(x => x.agentId === agentId)
        if (!entry) return
        delete entry.running
        entry.ok = e.reason === 'answer'
        entry.ms = (entry.ms ?? 0) + e.durationMs
        if (u) entry.tokens = (entry.tokens ?? 0) + u.input_tokens + u.output_tokens
        link(all, entry)
      })
    } catch {}
    return result
  })

  // bg outcomes: the parent cannot observe a background session and the worker's own mod cannot learn its `-n` name
  // or effort from the engine API, so background launches are recorded without ok/duration/tokens.
  for (const tool of ['Bash', 'PowerShell'] as const) {
    on('tool.call', { tool }, async ($, e, next) => {
      const refs: Ref[] = []
      let single = false
      try {
        const cmd = String(e.command ?? '')
        const launches = bgLaunches(cmd)
        single = launches.length > 0 && split(cmd).length === 1
        for (const f of launches) {
          const def = f.agent ? await agentFile($, f.agent) : {}
          refs.push(
            await launch(
              $,
              {
                kind: 'bg',
                agent: f.agent,
                model: family(f.model ?? def.model ?? 'opus'), // no --model: the default, treated as Opus
                effort: f.effort ?? def.effort,
                advisor: f.advisor,
                label: f.name ?? '',
              },
              true,
            ),
          )
        }
      } catch {}
      const ran = await next(e)
      // Denied: nothing ran. Errored: only when the claude segment was the whole command do we know it failed,
      // otherwise a later `&& failing-cmd` would wrongly erase a session that did start.
      if (refs.length && (ran.deny !== undefined || (single && ran.isError === true))) await drop($, refs)
      return ran
    })
  }
}
