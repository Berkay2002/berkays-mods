export type ProofGatePending = {
  name: string
  address: string
  /** Proof files named in the message; 0 when it only named a folder. */
  files: number
  /** When the proof arrived, ms since the epoch. */
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    'proof-gate': {
      /** Workers whose proof arrived and who wait for the person's approval. */
      pending: ProofGatePending[]
      /** Keys of messages already answered with a proof request, newest last. */
      asked: string[]
    }
  }
}
