import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Identity } from '../types'

// The name this process last applied with /rename. Survives hot reloads,
// not restarts, so a fresh process renames once and a reload does not.
const applied = atom({ plugin: 'identity-keeper', key: 'applied' } as const, null)

// "You are brf-app-reading, a background worker ..." -> brf-app-reading.
// Hyphenated names only, so "You are Claude Code" never matches.
const ROLE = /\bYou are ([a-z0-9]+(?:-[a-z0-9]+)+)\b/i
const ENVELOPE = /<cross-session-message from="([^"]+)"(?: from-name="([^"]+)")?/

const FIRST_PROMPT_MAX = 1000
const CARD_PROMPT_MAX = 600

const keyFor = async ($: EngineInterface) => `id:${await $.session.id()}`

const load = async ($: EngineInterface): Promise<Identity> =>
  ((await $.store.get(await keyFor($))) as Identity | undefined) ?? {}

const save = async ($: EngineInterface, patch: Partial<Identity>) => {
  const key = await keyFor($)
  const prev = ((await $.store.get(key)) as Identity | undefined) ?? {}
  await $.store.set(key, { ...prev, ...patch })
}

export const roleCard = (id: Identity): string | null => {
  if (!id.name) return null
  const lines = [`[identity-keeper] You are ${id.name}. Keep this name and role after the compaction.`]
  if (id.firstPrompt) {
    const brief =
      id.firstPrompt.length > CARD_PROMPT_MAX
        ? `${id.firstPrompt.slice(0, CARD_PROMPT_MAX)}...`
        : id.firstPrompt
    lines.push(`Your original instructions: ${brief}`)
  }
  if (id.orchestrator) {
    const who = id.orchestrator.name ? `${id.orchestrator.name} at ` : ''
    lines.push(`Orchestrator: ${who}${id.orchestrator.address} (latest address it wrote from).`)
  }
  return lines.join('\n')
}

export const describe = (id: Identity): string => {
  if (!id.name) return 'No name kept for this session'
  const source = id.source === 'rename' ? '/rename' : 'first prompt'
  const lines = [`Name: ${id.name} (from ${source})`]
  if (id.orchestrator) {
    const who = id.orchestrator.name ? `${id.orchestrator.name} · ` : ''
    lines.push(`Orchestrator: ${who}${id.orchestrator.address}`)
  }
  lines.push('Role card: active after each compaction')
  return lines.join('\n')
}

type Mode = 'set' | 'restore' | 'silent'

// Runs /rename once the session is idle. $.command.run rejects inside a hook
// the turn waits on, so it goes out on a timer, outside the dispatch.
// `silent` re-applies a name that most likely never changed, so no toast.
const rename = ($: EngineInterface, name: string, mode: Mode) => {
  $.clock.after(0, () => {
    $.command
      .run({ command: 'rename', args: name })
      .then(async () => {
        await update($, applied, () => name)
        if (mode === 'set') $.ui.toast(`Renamed to ${name}`)
        if (mode === 'restore') $.ui.toast(`Name restored · ${name}`)
      })
      .catch(async () => {
        const { isFilled } = await $.prompt.fill({ text: `/rename ${name}` })
        if (!isFilled) return
        $.ui.toast(mode === 'set' ? `Press Enter to rename to ${name}` : `Press Enter to restore name ${name}`)
      })
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({
      name: 'identity',
      description: "Show this session's kept name and role card, or forget them",
      argumentHint: '[forget]',
    })
    const { name } = await load($)
    if (name && (await read($, applied)) !== name) rename($, name, 'restore')
    return result
  })

  on('command.run', { command: 'identity' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'forget') {
      const id = await load($)
      if (!id.name && !id.firstPrompt && !id.orchestrator) return { text: 'Nothing kept for this session' }
      await $.store.delete(await keyFor($))
      await update($, applied, () => null)
      return { text: 'Forgot the name and role card for this session' }
    }
    if (arg !== '') return { text: 'Usage: /identity or /identity forget' }
    return { text: describe(await load($)) }
  })

  // The person's own /rename: remember it. Our own run never reaches here.
  on('command.run', { command: 'rename' }, async ($, e, next) => {
    const result = await next(e)
    const name = e.args.trim()
    if (name) {
      await save($, { name, source: 'rename' })
      await update($, applied, () => name)
    }
    return result
  })

  on('prompt.submit', async ($, e, next) => {
    const kind = e.origin.kind
    if (kind === 'plugin' || kind === 'task-notification') return next(e)

    const id = await load($)
    if (id.firstPrompt === undefined) {
      const patch: Partial<Identity> = { firstPrompt: e.text.slice(0, FIRST_PROMPT_MAX) }
      const match = id.name ? null : ROLE.exec(e.text.slice(0, 300))
      if (match?.[1]) {
        patch.name = match[1]
        patch.source = 'first-prompt'
      }
      await save($, patch)
      if (patch.name) rename($, patch.name, 'set')
    }
    return next(e)
  })

  on('session.receive', async ($, e, next) => {
    if (e.agentId === undefined) {
      const match = ENVELOPE.exec(e.text)
      if (match?.[1]) {
        await save($, { orchestrator: { address: match[1], name: match[2] } })
      }
    }
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.trigger === 'precompute' || e.agentId !== undefined || result.skip !== undefined) {
      return result
    }

    const id = await load($)
    const card = roleCard(id)
    if (!card || !id.name) return result
    const name = id.name

    // After the compaction is in place: the card as a user row the person does
    // not see as typed, then the name again in case the compaction dropped it.
    $.clock.after(0, () => {
      $.session
        .append({ message: { type: 'user', content: [{ type: 'text', text: card }] } })
        .then(appended => {
          if (appended.deny === undefined) $.ui.toast('Role card restored after compaction')
        })
        .catch(() => undefined)
      rename($, name, 'silent')
    })

    return result
  })
}
