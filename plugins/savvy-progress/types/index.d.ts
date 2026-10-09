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
    }
  }
}
