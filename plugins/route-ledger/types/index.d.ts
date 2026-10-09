export type LedgerEntry = {
  id: string
  /** ms, $.clock.now() */
  ts: number
  /** parent session id */
  sid: string
  repo: string
  kind: 'subagent' | 'bg'
  agent?: string
  /** model family (haiku|sonnet|opus|fable) or the raw string */
  model: string
  effort?: string
  advisor?: string
  /** first 80 chars of the subagent description or the bg --name; never the prompt */
  label: string
  /** subagents only: bg outcomes are not observable from the parent */
  ok?: boolean
  ms?: number
  tokens?: number
  /** background subagent: its agent id, to fill the outcome from its own turn.complete */
  agentId?: string
  /** a subagent that has not finished yet (never counts as the earlier run of a retry) */
  running?: true
  /** transient: the finished earlier entry this launch retries, until the link is made */
  prev?: string
  /** a later launch in the same session reused the label */
  retried?: boolean
  /** the retry ran higher on the ladder: "model@effort" of that retry */
  escalatedTo?: string
}
