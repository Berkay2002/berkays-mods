export type Identity = {
  name?: string
  source?: 'rename' | 'first-prompt'
  firstPrompt?: string
  orchestrator?: { address: string; name?: string }
}

declare module 'claude-code' {
  interface PluginState {
    'identity-keeper': { applied: string | null }
  }
}
