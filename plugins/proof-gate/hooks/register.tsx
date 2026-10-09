import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ProofGatePending } from '../types'

const pending = atom({ plugin: 'proof-gate', key: 'pending' } as const, [] as ProofGatePending[])
const asked = atom({ plugin: 'proof-gate', key: 'asked' } as const, [] as string[])
const ASKED_KEEP = 200
const BAND_ROWS = 3
const STATUS_NAMES = 3

export const REQUEST =
  'Before I review: send screenshots (desktop and mobile width) or a short video showing the change, as file paths.'

const ENVELOPE = /<cross-session-message\b([^>]*)>([\s\S]*?)(?:<\/cross-session-message>|$)/
const DONE =
  /\b(is done|done:|done\.|i'?m done|all done|committed|finished|ready to (merge|review)|ready for review|merged (main )?into my branch)\b/i
const NOT_DONE = /\b(not (yet )?(done|finished|committed)|blocked|need a decision)\b/i
const MEDIA = /(?:https?:\/\/|~\/|\/|\.\/)?[\w@%+.\/~-]*\.(?:png|jpe?g|gif|webp|mp4|mov|webm)\b/gi
const SHOTS_DIR = /(?:^|[\s`'"(\/])(shots|screenshots)\//i

export type Sender = { name: string; address: string }

/** The sender and body of a cross-session delivery, or null when it names no sender. */
export function parse(text: string): (Sender & { body: string }) | null {
  const m = ENVELOPE.exec(text)
  if (!m) return null
  const attrs = m[1] ?? ''
  const address = /\bfrom="([^"]+)"/.exec(attrs)?.[1]
  if (!address) return null
  const name = /\bfrom-name="([^"]+)"/.exec(attrs)?.[1] ?? address
  return { name, address, body: m[2] ?? '' }
}

export function proofPaths(body: string): string[] {
  return [...new Set(body.match(MEDIA) ?? [])].filter(p => !/^https?:/i.test(p))
}

export function hasProof(body: string): boolean {
  return (body.match(MEDIA) ?? []).length > 0 || SHOTS_DIR.test(body)
}

export function readsDone(body: string): boolean {
  return DONE.test(body) && !NOT_DONE.test(body)
}

/**
 * Display names: a dash-ended prefix every name shares is dropped
 * (brf-app-compare, brf-app-charts -> compare, charts); a lone name loses
 * its leading project segments (brf-app-compare -> compare).
 */
export function shortNames(names: readonly string[]): string[] {
  if (names.length === 0) return []
  if (names.length === 1) {
    const only = names[0] ?? ''
    const tail = only.slice(only.lastIndexOf('-') + 1)
    return [tail.length >= 3 ? tail : only]
  }
  let prefix = names[0] ?? ''
  for (const n of names) while (!n.startsWith(prefix)) prefix = prefix.slice(0, -1)
  prefix = prefix.slice(0, prefix.lastIndexOf('-') + 1)
  return names.map(n => (n.length > prefix.length ? n.slice(prefix.length) : n))
}

export function statusLine(list: readonly ProofGatePending[]): string | undefined {
  if (list.length === 0) return undefined
  const short = shortNames(list.map(p => p.name))
  const shown = short.slice(0, STATUS_NAMES).join(', ')
  const more = short.length > STATUS_NAMES ? ` +${short.length - STATUS_NAMES}` : ''
  return `${list.length} to approve · ${shown}${more}`
}

export function ago(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000))
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`
}

function messageKey(s: Sender, body: string): string {
  const commit = /\b(?:commit|at)\s+`?([0-9a-f]{7,40})\b/i.exec(body)?.[1]
  if (commit) return `${s.address}#${commit}`
  let h = 5381
  for (let i = 0; i < body.length; i++) h = ((h << 5) + h + body.charCodeAt(i)) | 0
  return `${s.address}#${(h >>> 0).toString(36)}`
}

async function sendFiles($: EngineInterface, s: Sender, paths: string[]): Promise<number> {
  const home = await $.env.get('HOME')
  const files = paths
    .map(p => (p.startsWith('~/') && home ? home + p.slice(1) : p))
    .filter(p => p.startsWith('/'))
  if (files.length === 0) return 0
  try {
    const tools = await $.tool.list()
    if (!tools.some(t => t.name === 'SendUserFile')) return 0
    const r = await $.tool.call({
      tool: 'SendUserFile',
      files,
      caption: `${shortNames([s.name])[0]} · proof for review`,
      status: 'proactive',
    })
    return r.isError ? 0 : files.length
  } catch {
    return 0
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    $.ui.status(statusLine(await read($, pending)))
    return r
  })

  on('session.receive', async ($, e, next) => {
    const queued = await next(e)
    const msg = parse(e.text)
    if (!msg) return queued
    const { body } = msg
    const short = shortNames([msg.name])[0]

    if (hasProof(body)) {
      const paths = proofPaths(body)
      const at = await $.clock.now()
      const entry: ProofGatePending = { name: msg.name, address: msg.address, files: paths.length, at }
      const list = await update($, pending, l => [...l.filter(p => p.address !== msg.address), entry])
      $.ui.status(statusLine(list))
      await sendFiles($, msg, paths)
      const what = paths.length === 1 ? '1 file' : paths.length ? `${paths.length} files` : 'a folder'
      $.ui.toast(`${short} sent proof · ${what}`)
      return queued
    }

    if (!readsDone(body)) return queued

    const key = messageKey(msg, body)
    if ((await read($, asked)).includes(key)) return queued
    await update($, asked, l => [...l, key].slice(-ASKED_KEEP))

    const { isDelivered } = await $.session.send({ to: msg.address, text: REQUEST })
    $.ui.toast(isDelivered ? `${short} is done · proof requested` : `${short} is done · proof request not delivered`)
    return queued
  })

  on('session.send', async ($, e, next) => {
    const r = await next(e)
    if (e.origin.kind !== 'model' || !r.isDelivered) return r
    const before = await read($, pending)
    const left = before.filter(p => p.address !== e.to && p.name !== e.to)
    if (left.length !== before.length) {
      await update($, pending, () => left)
      $.ui.status(statusLine(left))
    }
    return r
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, pending)
    if (e.props.hasSurvey || list.length === 0) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const short = shortNames(list.map(p => p.name))
    const isNarrow = e.props.bodyColumns < 60
    const rows = list.slice(0, BAND_ROWS)
    const more = list.length - rows.length

    return (
      <Box flexDirection="column">
        {rows.map((p, i) => {
          const name = short[i] ?? p.name
          const files = p.files === 1 ? '1 file' : p.files ? `${p.files} files` : 'folder'
          const detail = isNarrow ? ago(now - p.at) : `${files} · ${ago(now - p.at)}`
          return (
            <Box key={`row-${p.address}`} flexDirection="row" gap={1}>
              <Text color="warning">▲</Text>
              <Box flexShrink={1}>
                <Text wrap="truncate-end">
                  {name} <Text dimColor>· {detail}</Text>
                </Text>
              </Box>
              <Button
                key={`approve-${p.address}`}
                label="Approve"
                variant="primary"
                onPress={() => $.prompt.fill({ text: `Approved, merge ${name}` })}
              />
              <Button
                key={`changes-${p.address}`}
                label="Ask changes"
                dimColor
                onPress={() => $.prompt.fill({ text: `Tell ${name}: ` })}
              />
              <Button
                key={`dismiss-${p.address}`}
                label="Dismiss"
                dimColor
                onPress={async () => {
                  const left = await update($, pending, l => l.filter(q => q.address !== p.address))
                  $.ui.status(statusLine(left))
                }}
              />
            </Box>
          )
        })}
        {more > 0 ? <Text dimColor>+{more} more</Text> : null}
      </Box>
    )
  })
}
