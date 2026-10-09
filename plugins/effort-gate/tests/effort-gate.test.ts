import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

function world(on: On, main = 'sonnet') {
  mock.env(on, { HOME: '/home/me' })
  on('session.cwd', () => ({ value: '/proj' }))
  on('session.model', () => ({ value: main }))
  on('fs.read', (_$, e) => {
    if (/reviewer.md$/.test(e.path))
      return { value: '---\nname: reviewer\nmodel: opus\n---\nReview.' }
    const agentFile = (name: string, model: string) => ({ value: ['---', `name: ${name}`, `model:${model}`, '---', 'x'].join(String.fromCharCode(10)) })
    if (/inh.md$/.test(e.path)) return agentFile('inh', ' inherit')
    if (/blank.md$/.test(e.path)) return agentFile('blank', '')
    if (/weird.md$/.test(e.path)) return agentFile('weird', ' default')
    if (/cheap.md$/.test(e.path)) return agentFile('cheap', ' claude-sonnet-5-5')
    return { value: '' } // no such agent file
  })
  on('tool.check', () => ({ decision: 'allow' }))
}

const decide = async ($: Engine, tool: string, input: object) => (await $.tool.check({ tool, input })).decision
const agent = ($: Engine, input: object) => decide($, 'Agent', { description: 'd', prompt: 'p', ...input })
const bash = ($: Engine, command: string) => decide($, 'Bash', { command })

test('Agent: Opus at xhigh/max denies, everything else passes', async ($, on) => {
  world(on)
  expect(await agent($, { model: 'opus', effort: 'xhigh' })).toBe('deny')
  expect(await agent($, { model: 'sonnet', effort: 'xhigh' })).toBe('allow')
  expect(await agent($, { model: 'haiku', effort: 'max' })).toBe('allow')
  expect(await agent($, { model: 'opus', effort: 'high' })).toBe('allow')
  expect(await agent($, { subagent_type: 'fork', effort: 'max' })).toBe('allow')
})

test('Agent: model comes from the agent frontmatter (main session is Sonnet)', async ($, on) => {
  world(on)
  expect(await agent($, { subagent_type: 'reviewer', effort: 'xhigh' })).toBe('deny')
  expect(await agent($, { subagent_type: 'general-purpose', effort: 'xhigh' })).toBe('allow')
})

test('Agent: an inherited model is the main session model', async ($, on) => {
  world(on, 'opus')
  expect(await agent($, { subagent_type: 'general-purpose', effort: 'max' })).toBe('deny')
})

test('background claude launches', async ($, on) => {
  world(on)
  expect(await bash($, 'claude --bg --model opus --effort max "do it"')).toBe('deny')
  expect(await bash($, 'claude --bg --effort xhigh "do it"')).toBe('deny')
  expect(await bash($, 'claude --bg -n w1 "do it"')).toBe('deny') // no model at all
  expect(await bash($, 'claude --bg --agent reviewer "review"')).toBe('deny') // Opus from frontmatter, no effort
  expect(await bash($, 'claude --bg --agent reviewer --effort high "review"')).toBe('allow')
  expect(await bash($, 'claude --bg --model sonnet --effort xhigh "do it"')).toBe('allow')
  expect(await bash($, 'claude --bg --agent reviewer --effort xhigh')).toBe('deny')
  expect(await bash($, 'claude --bg --agent nosuch --model haiku --effort max')).toBe('allow')
  expect(await bash($, 'claude --model=opus --effort=max')).toBe('allow') // not background
  expect(await bash($, 'ls -la && git status')).toBe('allow')
})

const say = ($: Engine, kind: 'composer' | 'peer' | 'task-notification', text: string) =>
  $.prompt.submit({ text, origin: { kind }, wait: false })

test("approval: only the user's own prompt lifts the gate, until their next prompt", async ($, on) => {
  world(on)
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  const gated = () => agent($, { model: 'opus', effort: 'xhigh' })
  expect(await gated()).toBe('deny')
  await say($, 'peer', 'opus xhigh ok')
  await say($, 'task-notification', 'opus xhigh ok')
  expect(await gated()).toBe('deny')
  await say($, 'composer', 'ok opus xhigh')
  expect(await gated()).toBe('allow')
  expect(await bash($, 'claude --bg --model opus --effort max "x"')).toBe('allow')
  await say($, 'peer', 'hello') // non-user origin leaves it alone
  expect(await gated()).toBe('allow')
  await say($, 'composer', 'thanks')
  expect(await gated()).toBe('deny')
  await say($, 'composer', 'opus is fine')
  expect(await gated()).toBe('deny') // opus alone is not enough
})

test('flags inside a quoted prompt do not count, and `claude` must be the command word', async ($, on) => {
  world(on)
  // the prompt mentions --model sonnet, but no real --model is given: still denied
  expect(await bash($, 'claude --bg -n w1 "use --model sonnet --effort high here"')).toBe('deny')
  expect(await bash($, `claude --bg --model opus 'then --effort high' --effort max`)).toBe('deny')
  expect(await bash($, 'claude --bg --model sonnet --effort high -n w1 "x --effort max --model opus"')).toBe('allow')
  // Accepted false positives of the fail-closed backstop: text that merely mentions `claude --bg`.
  expect(await bash($, 'git commit -m "docs: claude --bg usage"')).toBe('deny')
  expect(await bash($, 'echo claude --bg')).toBe('deny')
  expect(await bash($, `bash -c "claude --bg --model opus --effort max 'x'"`)).toBe('deny') // read inside sh -c
  expect(await bash($, 'FOO=1 /usr/bin/claude --bg --model=opus --effort=max')).toBe('deny')
})

const ALLOWED = 'claude --bg --model sonnet --effort high -n w1 "do it"'

test('unusual shell forms the tokenizer cannot read are denied (fail closed)', async ($, on) => {
  world(on)
  const OPUS = 'claude --bg --model opus --effort max "x"'
  const SONNET = 'claude --bg --model sonnet --effort high "x"'
  const cases = [
    `echo it's; ${OPUS}`, // an unbalanced apostrophe swallows the rest
    `# don't do this\n${SONNET}`, // comment with an apostrophe, then a launch
    `cat <<EOF\nit's here\nEOF\n${OPUS}`,
    `for i in 1 2; do ${OPUS}; done`,
    `if true; then ${SONNET}; fi`,
    `{ ${OPUS}; }`,
    `( ${OPUS} )`,
    `x=$(${OPUS})`,
    `echo $(${SONNET})`,
    `echo \`${SONNET}\``,
    `foreach ($i in 1..2) { ${OPUS} }`,
    `env FOO=1 ${OPUS}`,
    `nohup ${OPUS} &`,
    `timeout 60 ${OPUS}`,
    `npx ${SONNET}`,
    `claude.cmd --bg --model opus --effort max`,
    `claude.ps1 --bg --model opus --effort xhigh`,
    `bash -lc "${OPUS}"`,
    `Start-Process claude -ArgumentList '--bg','--model','opus','--effort','max'`,
    `Start-Process claude '--bg --model sonnet --effort high'`,
    String.raw`& "C:\bin\claude.exe" --bg --model opus --effort max`,
    `cd x && for d in a b; do ${SONNET}; done`,
    `${SONNET} && for i in 1; do ${OPUS}; done`, // a second launch the tokenizer missed
  ]
  for (const c of cases) expect([c, await bash($, c)]).toEqual([c, 'deny'])
  expect(await decide($, 'PowerShell', { command: `Start-Process claude '--bg --model sonnet'` })).toBe('deny')
})

test('unresolvable or odd model/effort values are denied; case and duplicates are handled', async ($, on) => {
  world(on)
  expect(await bash($, 'claude --bg --model $M --effort high')).toBe('deny')
  expect(await bash($, 'claude --bg --model sonnet --effort $E')).toBe('deny')
  expect(await bash($, 'claude --bg --model %M% --effort high')).toBe('deny')
  expect(await bash($, 'claude --bg --model "$(pick)" --effort high')).toBe('deny')
  expect(await bash($, 'claude --bg --model opus --effort MAX')).toBe('deny')
  expect(await bash($, 'claude --bg --model sonnet --model opus --effort max')).toBe('deny') // last wins
  expect(await bash($, 'claude --bg --model opus --model sonnet --effort max')).toBe('allow')
  expect(await bash($, 'claude --bg --model sonnet --effort XHIGH')).toBe('allow')
})

test('ordinary commands and plain launches still pass', async ($, on) => {
  world(on)
  expect(await bash($, ALLOWED)).toBe('allow')
  expect(await bash($, 'claude.ps1 --bg --model sonnet --effort high')).toBe('allow')
  expect(await bash($, `cd /proj && ${ALLOWED}`)).toBe('allow')
  expect(await bash($, `echo it's fine`)).toBe('allow') // odd apostrophe, no launch in sight
  expect(await bash($, 'claude --bg --model sonnet --effort high -n w1 "line one\nline two --bg"')).toBe('allow')
  expect(await bash($, 'ls -la && git status')).toBe('allow')
  expect(await bash($, 'claude -p "hi" --model opus --effort max')).toBe('allow') // not background
})

test('a hook that throws denies instead of being skipped', async ($, on) => {
  on('env.get', () => {
    throw new Error('env broke') // agentFile reads HOME first
  })
  on('session.cwd', () => ({ value: '/proj' }))
  on('session.model', () => ({ value: 'sonnet' }))
  on('fs.read', () => ({ value: '' }))
  on('tool.check', () => ({ decision: 'allow' }))
  expect(await agent($, { subagent_type: 'general-purpose', model: 'haiku' })).toBe('deny')
  expect(await bash($, 'claude --bg --agent x --model haiku --effort low')).toBe('deny')
  expect(await bash($, 'ls')).toBe('allow')
})

const NL = String.fromCharCode(10)
const BS = String.fromCharCode(92)

test('a launch inside a balanced multi-line string for an evaluator is denied', async ($, on) => {
  world(on)
  const OPUS = 'claude --bg --model opus --effort max'
  const SONNET = 'claude --bg --model sonnet --effort high'
  const cases = [
    `iex "echo hi${NL}${OPUS}${NL}echo bye"`,
    `Invoke-Expression "x${NL}${SONNET}${NL}y"`,
    `eval "true${NL}${SONNET}${NL}true"`,
    `python -c 'import os${NL}${OPUS}${NL}pass'`,
    `node -e 'let a = 1${NL}${SONNET}${NL}a'`,
    `echo ${BS}'${NL}${OPUS}${NL}'`, // ' outside quotes misread as opening a quote
  ]
  for (const c of cases) expect([c, await bash($, c)]).toEqual([c, 'deny'])
  expect(await decide($, 'PowerShell', { command: `iex "a${NL}${SONNET}${NL}b"` })).toBe('deny')
})

test('claude and --bg split across lines by a continuation are still seen', async ($, on) => {
  world(on)
  expect(await bash($, `claude ${BS}${NL}  --bg --model opus --effort max`)).toBe('deny')
  expect(await bash($, 'claude `' + NL + '  --bg --model opus --effort max')).toBe('deny')
  expect(await bash($, `claude --bg --model opus ${BS}${NL}  --effort max`)).toBe('deny') // effort on the next line
  expect(await bash($, `claude --bg ${BS}${NL}  --model sonnet --effort high -n w1 "x"`)).toBe('allow')
  expect(await bash($, `claude --bg --model sonnet ${BS}${NL}  --effort xhigh "x"`)).toBe('allow')
})

test('--agent whose frontmatter model is inherit or empty counts as no model; paths are refused', async ($, on) => {
  world(on)
  expect(await bash($, 'claude --bg --agent inh --effort high')).toBe('deny')
  expect(await bash($, 'claude --bg --agent blank --effort high')).toBe('deny')
  expect(await bash($, 'claude --bg --model inherit --effort high')).toBe('deny')
  expect(await bash($, 'claude --bg --agent ../evil --model sonnet --effort high')).toBe('deny')
  expect(await bash($, 'claude --bg --agent a/b --model sonnet --effort high')).toBe('deny')
  expect(await bash($, `claude --bg --agent a${BS}b --model sonnet --effort high`)).toBe('deny')
  expect(await bash($, 'claude --bg --agent cheap --effort max')).toBe('allow') // sonnet by frontmatter
})

test('every Opus launch needs an explicit --effort; others do not', async ($, on) => {
  world(on)
  expect(await bash($, 'CLAUDE_CODE_EFFORT_LEVEL=max claude --bg --model opus')).toBe('deny')
  expect(await bash($, 'claude --bg --model opus --settings s.json')).toBe('deny')
  expect(await bash($, `claude --bg --model opus --settings '{"effortLevel":"max"}'`)).toBe('deny')
  expect(await bash($, 'claude --bg --model opus -n w1')).toBe('deny')
  expect(await bash($, 'claude --bg --model opus --effort high -n w1')).toBe('allow')
  expect(await bash($, 'claude --bg --model sonnet -n w1')).toBe('allow')
  expect(await bash($, 'CLAUDE_CODE_EFFORT_LEVEL=max claude --bg --model sonnet')).toBe('allow')
})

test('only Sonnet, Haiku and Fable are exempt from the Opus xhigh/max rule', async ($, on) => {
  world(on)
  for (const m of ['opus', 'best', 'default', 'opusplan', 'claude-opus-5-5', 'mystery-model'])
    expect([m, await bash($, `claude --bg --model ${m} --effort xhigh`)]).toEqual([m, 'deny'])
  for (const m of ['sonnet', 'haiku', 'fable', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'sonnet[1m]'])
    expect([m, await bash($, `claude --bg --model ${m} --effort max`)]).toEqual([m, 'allow'])
  expect(await bash($, 'claude --bg --agent weird --effort xhigh')).toBe('deny') // frontmatter model: default
  expect(await agent($, { subagent_type: 'weird', effort: 'max' })).toBe('deny')
  expect(await agent($, { subagent_type: 'cheap', effort: 'max' })).toBe('allow')
  expect(await agent($, { subagent_type: 'inh', effort: 'max' })).toBe('allow') // inherit -> main model (Sonnet)
  expect(await agent($, { subagent_type: 'fork', effort: 'max' })).toBe('allow')
})

test('backslashes in paths and continuations are read (regex class sanity)', async ($, on) => {
  world(on)
  const exe = `C:${BS}x${BS}claude.exe`
  expect(await bash($, `${exe} --bg`)).toBe('deny') // no --model
  expect(await bash($, `${exe} --bg --model sonnet --effort high`)).toBe('allow')
  // only the backstop can see this one: the command word is `foo`, the backslash precedes `claude`
  expect(await bash($, `foo ${exe} --bg --model sonnet --effort high`)).toBe('deny')
  expect(await bash($, `claude --bg ${BS}${NL}  -n w1`)).toBe('deny') // continued launch, still no model
  expect(await bash($, `claude --bg --model sonnet ${BS}${NL}  --effort high -n w1`)).toBe('allow')
  expect(await bash($, `claude --bg --agent x${BS}y --model sonnet --effort high`)).toBe('deny')
  expect(await bash($, `claude --bg --agent ${BS}${BS}host${BS}share${BS}a --model sonnet --effort high`)).toBe('deny')
})

test('a hidden launch cannot be cancelled out by a parsed one the old count missed', async ($, on) => {
  world(on)
  const SONNET = 'claude --bg --model sonnet --effort high'
  const cases = [
    `a;${SONNET}; iex " claude --bg"`, // parsed launch after ; plus a hidden one
    `a|${SONNET}|iex "claude --bg --model opus --effort max"`,
    `${SONNET} & iex "claude --bg --model opus --effort max"`,
    `cl"au"de --bg --model sonnet --effort high; iex "claude --bg --model opus --effort max"`,
    `${SONNET}; iex "x${NL}claude${NL}--bg --model opus --effort max"`, // --bg on a later line inside a quoted arg
    `claude --model sonnet "prompt${NL}--bg"`, // --bg only inside a quoted arg: over-count, accepted
    `${SONNET} -n a && ${SONNET} -n b; iex "claude --bg"`,
  ]
  for (const c of cases) expect([c, await bash($, c)]).toEqual([c, 'deny'])
  // honest chains of launches are fine
  expect(await bash($, `a;${SONNET} -n a; ${SONNET} -n b`)).toBe('allow')
  expect(await bash($, `cl"au"de --bg --model sonnet --effort high`)).toBe('allow')
})

test('a line continuation is a backslash in Bash and a backtick in PowerShell, and only there', async ($, on) => {
  world(on)
  const BT = String.fromCharCode(96)
  const ps = (command: string) => decide($, 'PowerShell', { command })
  const withBs = `claude --bg ${BS}${NL}  --model sonnet --effort high -n w1`
  const withBt = `claude --bg ${BT}${NL}  --model sonnet --effort high -n w1`
  expect(await ps(withBs)).toBe('deny') // in PowerShell the backslash is an argument: this launch has no model
  expect(await bash($, withBs)).toBe('allow')
  expect(await ps(withBt)).toBe('allow')
  expect(await bash($, withBt)).toBe('deny') // in Bash the backtick opens a substitution: unreadable
  expect(await ps(`claude --bg --model opus ${BT}${NL}  --effort max`)).toBe('deny')
})
