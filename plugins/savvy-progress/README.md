# savvy-progress

> **berkays-mods copy** of [johnnyvizz/claude-kit](https://github.com/johnnyvizz/claude-kit/tree/main/plugins/savvy-progress) 1.2.0 (MIT, johnnyvizz).
> Added: the claude-config agents `scout` (Haiku), `builder` (Sonnet) and `reviewer` (Opus) are tiers of their own,
> with their own crabs, and count for the bar and the panel's auto-open the way `savvy-*` workers do.
> The progress bar's crab is the orchestrator (the main session): a conductor in a top hat whose baton keeps time.
> The panel also lists the related background sessions (workers started with the CLI's background flag, in a worktree of this repository or launched by this session), with their state and branch,
> and in a terminal without graphics each crab is Claude Code's own Clawd in block characters, holding its tier's prop.
> Install with `claude plugin install savvy-progress@berkays-mods`.

A Claude Code mod: a progress bar above the prompt and a live panel of subagents. Made for the [savvy-flow](../savvy-flow) skill, and useful with any subagents.

- **Progress bar**: the flow's title, phase, accepted tasks out of planned, and a button with the crew size that opens the panel. It appears once something reports progress (savvy-flow does) or a `savvy-*` worker starts.
- **Agents panel** (`/agents-info` toggles it): running, finished and planned subagents with model, effort, task progress, context, estimated cost and time. Working crabs walk, and each savvy tier animates its prop: the astronaut floats, the detective sweeps the magnifier, the engineer turns the wrench, the chef tosses the omelette, the racer runs with a fluttering flag. `prefers-reduced-motion` stops them.
- **Background sessions**: a *Background* section after Running and Finished (and in the bar's crew count) for background sessions that run in a linked worktree of this repository or that this session launched. Each row has the crab, name, tier, model and effort, state (busy, idle, waiting for you) and branch. It polls `claude agents --json` and `git worktree list` every 5 s, only while the panel is open or a flow's bar is up. Model and effort are known only for sessions this session launched with `--name` (read off the Bash or PowerShell command); the crab comes from `--agent scout|builder|reviewer`, else the model (Haiku scout, Sonnet builder, Opus reviewer), else the plain crab. No cost or tokens: they are not visible from here.
- **View pane**: click a row's name (or press its digit, 1-9, while the panel has the keys) to open a tab beside *Agents* with what that worker is doing, refreshed every 2 s while shown: a header with its state, tier, model and branch, then its prompts (`❯`), replies (`●`) and one row per tool call (`⎿` done, `◌` running, `✗` failed). A subagent is read from this session; a background session from its transcript file (the last 3.5 MB, via `tail -c` or a PowerShell seek when the file is bigger than a plain read allows), with the `claude attach <id>` line to take it over, and from `claude logs` only when no transcript is found. Only the newest rows that fit are shown, no scrollback. On the desktop each row gets a *View* button.
- **Terminal crabs**: where there are no graphics, each subagent and background row, and the bar, shows Clawd (the CLI's mascot, 3 lines of quadrant blocks in Claude orange) with a prop in the tier's color: scout binoculars, builder hammer, reviewer check, orchestrator baton, none for the rest. While the pane is open, running and busy rows animate every 500 ms: the feet walk and the prop moves.

## Tools it adds

- `mcp__savvy-progress__progress`: the orchestrator reports the plan, phase and accepted tasks.
- `mcp__savvy-progress__step`: a worker reports its own steps (`done`, `total`, `note`). A worker that does not report shows its context fill in grey instead.

Cost is a rough estimate from token counts and a built-in per-model price table (`PRICES` in `hooks/register.tsx`), not a bill.

## Settings

`language`: `auto` (default), `en` or `ru`. `auto` follows Claude Code's `language` setting, then the system locale, and falls back to English. Set it in `/config`, or, for a mod loaded by hand, in `~/.claude/settings.json`:

```json
{ "pluginConfigs": { "savvy-progress": { "options": { "language": "ru" } } } }
```

Install instructions are in the [berkays-mods README](../../README.md).
