import type { On } from 'claude-code'

/** `claude agents --json` and git: brf-app-* run in linked worktrees, "orchestrator" in a plain checkout. */
export function sessions(on: On) {
  const out = (stdout: string, exitCode = 0) => ({
    value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  })
  on('process.run', (_$, e) => {
    const [cmd, , cwd] = e.argv
    if (cmd === 'claude') {
      const names = ['compare', 'charts', 'reading', 'monthly', 'areas', 'pdf', 'ui'].map(n => `brf-app-${n}`)
      const list = [
        ...names.map(name => ({ name, cwd: `/repo/.claude/worktrees/${name}` })),
        { name: 'orchestrator', cwd: '/home/me' },
      ]
      return out(JSON.stringify(list)) as never
    }
    if (cwd?.startsWith('/repo/.claude/worktrees/')) return out(`/repo/.git/worktrees/x\n/repo/.git\n`) as never
    return out(`${cwd}/.git\n${cwd}/.git\n`) as never
  })
}
