export type EffortGateApproval = boolean

declare module 'claude-code' {
  interface PluginState {
    'effort-gate': {
      /** The user's latest own prompt named Opus and xhigh/max. */
      approved: boolean
    }
  }
}
