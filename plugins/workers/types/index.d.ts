export type Contact = {
  /** Last message text, first 80 characters, one line. */
  text: string
  /** When it was sent or received, ms since the epoch. */
  at: number
  /** `in` received from the worker, `out` sent to it. */
  dir: 'in' | 'out'
  /** The worker asked for a decision and this session has not answered yet. */
  needsYou: boolean
}

export type Worker = {
  name: string
  pid: number
  sessionId: string
  cwd: string
  /** running, idle or blocked, from `claude agents`; gone once it left that list. */
  state: string
  /** What a blocked session waits for, as `claude agents` says it. */
  waitingFor: string | null
  branch: string | null
  ahead: number | null
  dirty: number | null
}

declare module 'claude-code' {
  interface PluginState {
    workers: {
      /** Last message per worker, keyed by name, or `pid:<n>` when only the socket is known. */
      contacts: Record<string, Contact>
      rows: Worker[]
      /** Other sessions running that are not counted as workers. */
      others: number
      updatedAt: number
      showAll: boolean
      error: string | null
      /** Whether this plugin's pane is open, kept across reloads. */
      isOpen: boolean
      /** Workers waiting on the person; the hint line's tail. */
      needs: number
    }
  }
}
