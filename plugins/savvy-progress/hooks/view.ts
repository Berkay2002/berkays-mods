// The view pane: what one subagent or background session is doing, as lines of text.

import type { SessionMessage } from 'claude-code'

const MAX_LINES = 2000

// `claude logs` prints a terminal recording: keep the text, drop colors and cursor moves.
export const logLines = (raw: string): string[] => {
  const text = raw
    .replace(/\x1b\[(\d*)C/g, (_, n: string) => ' '.repeat(Number(n) || 1))
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '')
  const out: string[] = []
  for (const l of text.split('\n')) {
    // A carriage return mid-line redrew the line: the last write is what showed.
    const line = (l.replace(/\r+$/, '').split('\r').pop() ?? '')
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
      .replace(/\s+$/, '')
      // Right-aligned status and the prompt box's rules are sized to its terminal, not this pane.
      .replace(/(\S) {3,}/g, '$1  ')
      .replace(/─{4,}/g, '───')
    if (/^[─\s]+$/.test(line)) continue
    if (line === '' && (out.length === 0 || out[out.length - 1] === '')) continue
    out.push(line)
  }
  while (out[out.length - 1] === '') out.pop()
  return out.slice(-MAX_LINES)
}

const KEYS = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'skill', 'prompt']

/** A tool call in a few words: its first telling argument. */
export const brief = (input: Record<string, unknown>): string => {
  const k = KEYS.find(k => typeof input[k] === 'string' && input[k])
  const v = k ? String(input[k]) : JSON.stringify(input)
  return v.replace(/\s+/g, ' ').trim()
}

/** An agent's transcript as lines: prompts `❯`, replies `●`, tool calls `⎿` (in flight `…`, failed `✗`). */
export const messageLines = (msgs: readonly SessionMessage[]): string[] => {
  const out: string[] = []
  const block = (mark: string, text: string, max = Infinity) => {
    const lines = text.trim().split('\n')
    out.push('')
    lines.slice(0, max).forEach((l, i) => out.push(`${i ? '  ' : mark + ' '}${l.replace(/\s+$/, '')}`))
    if (lines.length > max) out.push(`  … ${lines.length - max} more lines`)
  }
  for (const m of msgs) {
    if (m.role === 'user') {
      if (m.text.trim() && !m.toolResults?.length) block('❯', m.text, 8)
      continue
    }
    if (m.text.trim()) block('●', m.text)
    for (const u of m.toolUses) out.push(`${u.isError ? '✗' : u.text === undefined ? '…' : '⎿'} ${u.tool}(${brief(u.input)})`)
  }
  while (out[0] === '') out.shift()
  return out.slice(-MAX_LINES)
}

/** Hard-wraps each line to `width`, at a space when one is near; the pane then shows the tail that fits. */
export const wrapLines = (lines: readonly string[], width: number): string[] => {
  const w = Math.max(10, width)
  const out: string[] = []
  for (const line of lines) {
    let s = line
    while (s.length > w) {
      let k = s.lastIndexOf(' ', w)
      if (k < w / 2) k = w
      out.push(s.slice(0, k))
      s = '  ' + s.slice(k).replace(/^ /, '')
    }
    out.push(s)
  }
  return out
}
