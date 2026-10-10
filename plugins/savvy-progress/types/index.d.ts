export type Phase = 'plan' | 'design' | 'delegate' | 'review' | 'close'

export type PlannedTask = {
  title: string
  tier: string
  after: number[]
}

export type Flow = {
  title: string
  total: number
  done: number
  running: number
  phase: Phase
  isFinished: boolean
  tasks: PlannedTask[]
}

export type AgentStatus = 'running' | 'done' | 'failed'

export type AgentRun = {
  id: string
  agentId?: string
  type: string
  description: string
  model: string
  effort?: string
  status: AgentStatus
  startedAt: number
  endedAt?: number
  contextTokens: number
  contextMax: number
  tokens: number
  costUsd: number
  steps: number
  round: number
  /** Self-reported by the worker through the `step` tool. */
  stepDone?: number
  stepTotal?: number
  stepNote?: string
}

export type BgState = 'busy' | 'idle' | 'waiting'

/** A background session related to this one, as the last poll of the agents list saw it. */
export type BgSession = {
  id: string
  name: string
  state: BgState
  /** The crab: scout, builder, reviewer or other. */
  tier: string
  /** Known only for sessions this one launched. */
  model?: string
  effort?: string
  branch?: string
  /** Where it runs: its transcript lives under the projects folder named after it. */
  cwd?: string
}

/** What the view pane shows: a subagent of this session (by agentId) or a background session (by session id). */
export type ViewTarget = { kind: 'agent' | 'bg'; id: string; name: string; cwd?: string }

/** One row of the view pane: a prompt, reply prose, a tool call (done, in flight, failed), raw log text, or a gap. */
export type ViewLine = {
  kind: 'user' | 'text' | 'tool' | 'pending' | 'error' | 'log' | 'gap'
  text: string
  /** A tool line's tool. */
  tool?: string
  /** A wrapped line's later rows: drawn without the mark. */
  isCont?: boolean
}

export type Panel = {
  isCompact: boolean
  isDoneCollapsed: boolean
  autoOpenedFor: string
}

declare module 'claude-code' {
  interface PluginState {
    'savvy-progress': {
      flow: Flow | null
      agents: AgentRun[]
      panel: Panel
      now: number
      /** Which of the two crab frames the running rows show; flips while something runs. */
      frame: number
      bg: BgSession[]
      /** What this session's own background launches asked for, by lowercase `--name`. */
      launches: Record<string, { model?: string; effort?: string; agent?: string }>
      /** The view pane's target and its last read, as lines. */
      view: (ViewTarget & { lines: ViewLine[]; source?: 'transcript' | 'logs' }) | null
      /** The view pane's window sits at the end: new lines scroll it down. Off once the person scrolls up. */
      viewFollow: boolean
    }
  }
}
