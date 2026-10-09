# berkays-mods

Claude Code mods for running orchestrator and worker sessions. Built and tested on Claude Code v2.1.289.

| Mod | What it does |
| --- | --- |
| `limit-resume` | When the 5-hour limit resets, sends "Continue" to the session and nudges idle workers. Status line from 80%, `/limits`, and a one-line usage note for Claude each turn. |
| `workers` | `/workers` opens a pane with every worker: state, branch, commits ahead of main, changed files, last message, and who needs you. `/workers all` shows every session. |
| `identity-keeper` | Remembers the session name (from `/rename` or "You are <name>" in the first prompt), restores it after a restart, and gives Claude a short role card after each compaction. `/identity`, `/identity forget`. |
| `proof-gate` | When a worker reports done without screenshots, asks it for them. When proof arrives, sends the files to you and shows a band above the prompt with Approve and Ask changes. |
| `effort-gate` | Denies a subagent or `claude --bg` session that runs Opus at `xhigh` or `max` effort unless you said so: your own next prompt (terminal or Remote Control) must mention Opus and xhigh/max, e.g. "ok opus xhigh". The OK lasts until your next prompt. Sonnet, Haiku, and the main session are not gated. Also denies a `claude --bg` with no `--model` (or `--agent` that sets one), since it would silently run Opus, and an Opus one with no `--effort` (settings could raise it). It fails closed on `claude --bg` text it cannot read, so a message that merely mentions `claude --bg` is denied too. It only sees the literal command text: variables, aliases or functions, scripts written then run, and `xargs` get through. |
| `route-ledger` | Records every subagent and `claude --bg` launch (model, effort, agent, label, never the prompt) and, for subagents (background ones too), ok/error, duration and tokens. A relaunch with the same label in the same session marks the earlier run retried or escalated. `/routing-review [days]` prints launches, outcomes, retries, escalations and median tokens and time per model@effort. Background sessions are launch-only: their outcome is not visible to the mod. |
| `config-sync` | At session start (at most every 10 minutes per device) pulls `~/.claude/shared` (the claude-config repo) with `--ff-only`. Tells you when the pull fails, when there are unpushed local changes, or when `settings.shared.json` changed; `/config-sync apply` then runs the installer, `/config-sync` shows the status. Skips private `CLAUDE_CONFIG_DIR` setups. |
| `savvy-progress` | A progress bar above the prompt and `/agents-info`, a panel of every subagent with model, context, cost and time. `scout`, `builder` and `reviewer` get their own crabs: a ranger with binoculars, a builder with a hammer, a reviewer in a mortarboard with a clipboard. The bar's crab is the orchestrator, a conductor with a baton. Also lists related background sessions and draws the crabs as half-block text in the terminal. Copy of [johnnyvizz/claude-kit](https://github.com/johnnyvizz/claude-kit/tree/main/plugins/savvy-progress) (MIT). |
| `cache-tax` | Keeps the one-hour prompt cache warm: every session starts an 8-hour keepwarm window that pings after 50 idle minutes, and a cold send shows its rewrite cost. Changed from upstream: keepwarm is always on for 8h, and the guard warns instead of dropping the message. `/keepwarm off` turns it off on this device. Pings cost usage. Copy of [karanb192/cache-tax](https://github.com/karanb192/cache-tax) (MIT). |

## Install

```sh
claude plugin marketplace add Berkay2002/berkays-mods
claude plugin install limit-resume@berkays-mods
claude plugin install workers@berkays-mods
claude plugin install identity-keeper@berkays-mods
claude plugin install proof-gate@berkays-mods
claude plugin install effort-gate@berkays-mods
claude plugin install route-ledger@berkays-mods
claude plugin install config-sync@berkays-mods
claude plugin install savvy-progress@berkays-mods
claude plugin install cache-tax@berkays-mods
```

## Update

Plugins carry no `version`, so each commit is a new version:

```sh
claude plugin marketplace update berkays-mods
claude plugin update workers@berkays-mods   # and the others
```

Then run `/reload-plugins` in open sessions.

## Develop

Work against the checkout, not the installed copy:

```sh
claude --plugin-dir plugins/workers
claude plugin validate plugins/workers
(cd plugins/workers && claude plugin test)
```

## License
MIT
