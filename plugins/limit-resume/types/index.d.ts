/** The 5h usage line shown dim at the end of the prompt hint. */
export type HintTail = string

declare module 'claude-code' {
  interface PluginState {
    'limit-resume': {
      /** The 5h usage line for the prompt hint's tail; empty while below the warning level or paused. */
      tail: string
    }
  }
}
