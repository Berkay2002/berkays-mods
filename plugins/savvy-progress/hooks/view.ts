// The view pane: what one subagent or background session is doing, as styled lines.

import type { SessionMessage } from 'claude-code'

import type { ViewLine } from '../types'

const MAX_LINES = 2000

// `claude logs` prints a terminal recording: keep the text, drop colors and cursor moves.
// Only the fallback for a background session whose transcript cannot be found.
export const logLines = (raw: string): ViewLine[] => {
  const text = raw
    .replace(/\x1b\[(\d*)C/g, (_, n: string) => ' '.repeat(Number(n) || 1))
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '')
  const out: ViewLine[] = []
  for (const l of text.split('\n')) {
    // A carriage return mid-line redrew the line: the last write is what showed.
    const line = (l.replace(/\r+$/, '').split('\r').pop() ?? '')
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
      .replace(/\s+$/, '')
      // Right-aligned status and the prompt box's rules are sized to its terminal, not this pane.
      .replace(/(\S) {3,}/g, '$1  ')
      .replace(/─{4,}/g, '───')
    if (/^[─\s]+$/.test(line)) continue
    if (line === '' && (out.length === 0 || out[out.length - 1]!.kind === 'gap')) continue
    out.push(line === '' ? { kind: 'gap', text: '' } : { kind: 'log', text: line })
  }
  while (out[out.length - 1]?.kind === 'gap') out.pop()
  return out.slice(-MAX_LINES)
}

type Use = { tool_use_id: string; tool: string; input: Record<string, unknown>; text?: string; isError?: true }
type Block = { type?: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; is_error?: boolean }

/**
 * A session transcript file (JSONL, one content block per entry) as `$.session.messages()` rows: replies,
 * tool calls marked answered or failed by their results, and the person's prompts (not the engine's own
 * `<tag>` messages, meta rows, compaction summaries or sidechains). A partial first line, from reading only the tail, is skipped.
 */
export const transcriptMessages = (jsonl: string): SessionMessage[] => {
  const msgs: SessionMessage[] = []
  const uses = new Map<string, Use>()
  for (const raw of jsonl.split('\n')) {
    let o: { type?: string; isMeta?: boolean; isSidechain?: boolean; isCompactSummary?: boolean; message?: { content?: unknown } }
    try {
      o = JSON.parse(raw)
    } catch {
      continue
    }
    if (!o || typeof o !== 'object' || o.isMeta || o.isSidechain || o.isCompactSummary) continue
    const c = o.message?.content
    const blocks: Block[] = typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? c : []
    const text = blocks
      .filter(b => b.type === 'text' && typeof b.text === 'string')
      .map(b => b.text)
      .join('\n')
    if (o.type === 'assistant') {
      const toolUses = blocks
        .filter(b => b.type === 'tool_use' && b.id && b.name)
        .map(b => {
          const u: Use = { tool_use_id: b.id!, tool: b.name!, input: (b.input as Record<string, unknown>) ?? {} }
          uses.set(u.tool_use_id, u)
          return u
        })
      if (text.trim() || toolUses.length) msgs.push({ role: 'assistant', text, toolUses })
    } else if (o.type === 'user') {
      for (const b of blocks) {
        const u = b.type === 'tool_result' && b.tool_use_id ? uses.get(b.tool_use_id) : undefined
        if (!u) continue
        u.text = ''
        if (b.is_error) u.isError = true
      }
      if (text.trim() && !text.trimStart().startsWith('<')) msgs.push({ role: 'user', text, toolUses: [] })
    }
  }
  return msgs
}

const KEYS = ['description', 'command', 'file_path', 'path', 'pattern', 'url', 'query', 'skill', 'prompt']

/** A tool call in a few words: its first telling argument. */
export const brief = (input: Record<string, unknown>): string => {
  const k = KEYS.find(k => typeof input[k] === 'string' && input[k])
  const v = k ? String(input[k]) : JSON.stringify(input)
  return v.replace(/\s+/g, ' ').trim()
}

/** `mcp__server__tool` reads as `tool (server)`. */
const toolName = (t: string): string => {
  const m = /^mcp__(.+?)__(.+)$/.exec(t)
  return m ? `${m[2]} (${m[1]!.replace(/^plugin_[^_]+_/, '')})` : t
}

/** An agent's transcript as lines: prompts, replies, and one line per tool call, a gap before each block. */
export const messageLines = (msgs: readonly SessionMessage[]): ViewLine[] => {
  const out: ViewLine[] = []
  const block = (kind: 'user' | 'text', text: string, max = Infinity) => {
    const lines = text.trim().split('\n')
    if (out.length) out.push({ kind: 'gap', text: '' })
    // Only a block's first line carries the mark.
    lines.slice(0, max).forEach((l, i) => out.push({ kind, text: l.replace(/\s+$/, ''), ...(i ? { isCont: true } : {}) }))
    if (lines.length > max) out.push({ kind, text: `… ${lines.length - max} more lines`, isCont: true })
  }
  for (const m of msgs) {
    if (m.role === 'user') {
      if (m.text.trim() && !m.toolResults?.length) block('user', m.text, 6)
      continue
    }
    if (m.text.trim()) block('text', m.text)
    // Tool calls run on under the reply that led to them; after a prompt they start a block of their own.
    else if (m.toolUses.length && out[out.length - 1]?.kind === 'user') out.push({ kind: 'gap', text: '' })
    for (const u of m.toolUses)
      out.push({ kind: u.isError ? 'error' : u.text === undefined ? 'pending' : 'tool', tool: toolName(u.tool), text: brief(u.input) })
  }
  return out.slice(-MAX_LINES)
}

/**
 * Wraps prose, prompt and log lines to `width`, at a space when one is near, marking the continuations; a
 * tool line stays one row (the pane truncates it). The pane then shows the tail that fits.
 */
export const wrapLines = (lines: readonly ViewLine[], width: number): ViewLine[] => {
  const w = Math.max(10, width)
  const out: ViewLine[] = []
  for (const line of lines) {
    if (line.kind !== 'text' && line.kind !== 'user' && line.kind !== 'log') {
      out.push(line)
      continue
    }
    let s = line.text
    let isCont = false
    while (s.length > w) {
      let k = s.lastIndexOf(' ', w)
      if (k < w / 2) k = w
      out.push({ ...line, text: s.slice(0, k), ...(isCont ? { isCont } : {}) })
      s = s.slice(k).replace(/^ /, '')
      isCont = true
    }
    out.push({ ...line, text: s, ...(isCont ? { isCont } : {}) })
  }
  return out
}
