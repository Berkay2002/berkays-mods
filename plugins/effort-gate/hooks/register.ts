import type { EngineInterface, Register } from 'claude-code'

const HIGH = new Set(['xhigh', 'max'])
// Allowlist: only a model that names Sonnet, Haiku or Fable (alias or full id) is not Opus. Everything else
// (opus, best, default, opusplan, an id we do not know) is held to the Opus rule.
const isOpus = (m?: string) => !!m && (/opus/i.test(m) || !/sonnet|haiku|fable/i.test(m))

// First `key: value` of the file's frontmatter, unquoted.
function front(text: string, key: string) {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? ''
  const v = new RegExp(`^${key}` + String.raw`:\s*(.+?)\s*$`, 'm').exec(block)?.[1]
  return v?.replace(/^["']|["']$/g, '')
}

// Project agents shadow user agents. A missing file is just "no frontmatter".
async function agentFile(
  $: EngineInterface,
  agent: string,
): Promise<{ model?: string; effort?: string }> {
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
export function split(cmd: string): { segs: Tok[][]; open: boolean } {
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
  return { segs: segs.filter(s => s.length), open: q !== null }
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
  for (const seg of split(cmd).segs) {
    let i = 0
    while (i < seg.length && !seg[i]!.quoted && /^[A-Za-z_]\w*=/.test(seg[i]!.text)) i++
    const word = seg[i]?.text.split(/[\\/]/).pop() ?? ''
    if (SHELL.test(word)) {
      const k = seg.findIndex((t, n) => n > i && !t.quoted && /^(?:-[a-z]*c|-command|\/c)$/i.test(t.text))
      if (k >= 0) {
        const rest = seg.slice(k + 1)
        out.push(...bgLaunches(rest.length === 1 ? rest[0]!.text : rest.map(t => (t.quoted ? JSON.stringify(t.text) : t.text)).join(' ')))
      }
      continue
    }
    if (!/^claude(?:\.(?:exe|cmd|ps1))?$/i.test(word)) continue
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

// The tokenizer is precise but cannot read every shell form (loops, wrappers, $( ), Start-Process, a stray apostrophe,
// a launch inside a string handed to iex/eval/python -c). So a loose count on the text also looks for `claude ... --bg`;
// more of those than the tokenizer parsed launches (or any, with an unclosed quote) means the command is refused as
// unreadable. A prompt or commit message that merely mentions `claude --bg` trips it too; that is accepted.
const CLAUDE_WORD = /(?<![A-Za-z0-9_.-])claude(?:\.(?:exe|cmd|ps1)|(?![\w.-]))(?=[\s\S]*?--(?:bg|background)\b)/gi

export function analyze(cmd: string, tool: 'Bash' | 'PowerShell'): { launches: BgLaunch[]; unreadable: boolean } {
  // A line continuation is `\` in Bash and a backtick in PowerShell; in the other shell it is just a character.
  const joined = cmd.replace(tool === 'Bash' ? /\\\r?\n/g : /`\r?\n/g, ' ')
  const launches = bgLaunches(joined)
  // One normalized copy to count in: quotes deleted (cl"au"de), separators and newlines blanked. Every `claude` word
  // with a `--bg` anywhere later counts (the lookahead consumes nothing, so they do not eat each other). Each parsed
  // launch is one such word, so a hidden launch always makes the count exceed the parsed ones.
  const flat = joined.replace(/["']/g, '').replace(/[;|&\r\n]/g, ' ')
  const hits = flat.match(CLAUDE_WORD)?.length ?? 0
  const unreadable = hits > launches.length || (split(joined).open && hits > 0)
  return { launches, unreadable }
}

// A value the shell would expand or run: not what the gate can compare.
const unresolvable = (v?: string) => !!v && /^[$%]|[(`]/.test(v)

async function mainModel($: EngineInterface) {
  try {
    return await $.session.model()
  } catch {
    return 'opus' // not exposed: treat the inherited model as Opus
  }
}

const approval = { plugin: 'effort-gate', key: 'approved' } as const

const deny = (what: string, effort: string) => ({
  decision: 'deny' as const,
  reason: `effort-gate: Opus@${effort} for ${what} needs the user's explicit OK. Ask the user in chat; their reply must mention Opus and xhigh/max (e.g. 'ok opus xhigh'). Otherwise use opus@high or sonnet@xhigh.`,
})

// A guard that throws would otherwise be skipped and the call allowed.
const failClosed = (_$: unknown, e: unknown, next: { called: boolean } & ((e: never) => unknown)) =>
  next.called ? next(e as never) : { decision: 'deny' as const, reason: 'effort-gate: check failed' }

export const register: Register = on => {
  // Only the user's own typing (terminal or Remote Control) sets or clears the approval, until their next prompt.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'composer' || e.origin.kind === 'bridge') {
      const ok = /\bopus\b/i.test(e.text) && /\b(xhigh|x-high|extra[ -]?high|max)\b/i.test(e.text)
      await $.state.set(approval, ok)
    }
    return next(e)
  })

  on('tool.check', { tool: 'Agent' }, async ($, e, next) => {
    const i = (e.input ?? {}) as { model?: string; effort?: string; subagent_type?: string }
    if (i.subagent_type === 'fork') return next(e) // forks inherit the parent; not gated
    const def = i.subagent_type ? await agentFile($, i.subagent_type) : {}
    let model = i.model ?? def.model
    if (!model || model === 'inherit') model = await mainModel($)
    const effort = (i.effort ?? def.effort)?.toLowerCase()
    if (!(isOpus(model) && effort && HIGH.has(effort))) return next(e)
    return (await $.state.get(approval)).value ? next(e) : deny('a subagent', effort)
  }).catch(failClosed)

  for (const tool of ['Bash', 'PowerShell'] as const) {
    on('tool.check', { tool }, async ($, e, next) => {
      const cmd = String((e.input as { command?: string })?.command ?? '')
      const { launches, unreadable } = analyze(cmd, tool)
      if (unreadable)
        return {
          decision: 'deny' as const,
          reason: "effort-gate: can't read this claude --bg launch; run it as a plain `claude --bg --model X --effort Y ...` command.",
        }
      for (const f of launches) {
        if (unresolvable(f.model) || unresolvable(f.effort))
          return {
            decision: 'deny' as const,
            reason: "effort-gate: can't resolve the --model/--effort of this claude --bg launch (variable or substitution); write the values out.",
          }
        if (f.agent && /[\/\\]|\.\./.test(f.agent))
          return {
            decision: 'deny' as const,
            reason: 'effort-gate: --agent must be a plain agent name (no path), so its frontmatter can be checked.',
          }
        const def = f.agent ? await agentFile($, f.agent) : {}
        const model = f.model ?? def.model
        // No model (or `inherit`) means the worker silently inherits Opus: make the orchestrator pick one.
        if (!model || model === 'inherit')
          return {
            decision: 'deny' as const,
            reason: 'effort-gate: a background session needs an explicit --model (and --effort), or an --agent whose frontmatter sets them. Without it the worker inherits Opus.',
          }
        const effort = (f.effort ?? def.effort)?.toLowerCase()
        // An Opus session with no effort of its own takes it from settings, which can say xhigh/max.
        if (isOpus(model) && !effort)
          return {
            decision: 'deny' as const,
            reason: 'effort-gate: an Opus background session needs an explicit --effort (or an --agent whose frontmatter sets it); the default can come from settings.',
          }
        if (isOpus(model) && effort && HIGH.has(effort) && !(await $.state.get(approval)).value)
          return deny('a background session', effort)
      }
      return next(e)
    }).catch(failClosed)
  }
}
