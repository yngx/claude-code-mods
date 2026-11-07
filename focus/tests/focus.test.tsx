import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

type On = Parameters<TestBody>[1]

const PANE = {
  plugin: 'focus',
  component: 'Pane',
  requestId: 'focus',
  props: {
    title: 'Working on',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const HINT = {
  plugin: 'focus',
  component: 'PromptHint',
  props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
} as const

const URL_A = 'https://github.com/acme/web/pull/41'
const URL_B = 'https://github.com/acme/api/pull/7'

const command = (command: string, args = '') => ({
  command,
  args,
  origin: { kind: 'composer' } as const,
  presentation: { isFullscreen: true, columns: 160 },
})

const ghView = (url: string) =>
  JSON.stringify({
    number: Number(url.split('/').pop()),
    title: url.includes('/web/') ? 'Add the sidebar' : 'Rotate the keys',
    state: url.includes('/web/') ? 'OPEN' : 'MERGED',
    isDraft: false,
    mergeable: 'MERGEABLE',
    reviewDecision: url.includes('/web/') ? 'REVIEW_REQUIRED' : 'APPROVED',
    url,
    headRefName: 'xy-topic',
    baseRefName: 'main',
    statusCheckRollup: [
      { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: '' },
      { __typename: 'StatusContext', state: 'FAILURE' },
    ],
  })

type Gh = (argv: readonly string[]) => { exitCode: number; stdout: string; stderr: string }

// The engine beneath the plugin, stubbed noun by noun.
const engine = (on: On, runs: string[][] = [], gh?: Gh) => {
  mock.clock(on, { now: 1_700_000_000_000 })
  on('tool.register', (_, e) => ({ value: { tool: `mcp__focus__${e.name}` } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', (_, e) => {
    runs.push([...e.argv])
    const answer = gh ? gh(e.argv) : { exitCode: 0, stdout: ghView(e.argv[3] ?? ''), stderr: '' }
    return { value: { ...answer, isStdoutTruncated: false, isStderrTruncated: false } }
  })
}

test('the pane shows the goal, next and done after set_focus', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({
    tool: 'mcp__focus__set_focus',
    goal: 'Ship the focus mod',
    done: ['Read the mods API'],
    next: ['Write register.tsx', 'Validate'],
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Ship the focus mod/ }))?.text).toBe('Ship the focus mod')
  expect((await ui.find({ type: 'Text', text: /Write register/ }))?.text).toBe('→ Write register.tsx')
  expect((await ui.find({ type: 'Text', text: /Read the mods API/ }))?.text).toBe('✓ Read the mods API')
  expect((await ui.find({ type: 'Text', text: /none yet/ }))?.text.includes('PRs')).toBe(true)
  await ui.unmount()
})

test('omitted fields keep their value; lists replace whole', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__focus__set_focus', goal: 'A goal', next: ['one', 'two'] })
  const answer = await $.tool.call({ tool: 'mcp__focus__set_focus', done: ['one'], next: ['two'] })

  expect(answer.result).toBe('Focus pane updated.\nGoal: A goal\nStatus: none\nNext: two\nDone: one')
})

test('/working-on and a bare /prs toggle the one pane', async ($, on) => {
  let opened = ''
  let isUp = false
  on('ui.panes', () => ({
    value: isUp ? [{ id: 'focus', title: 'Working on', isShown: true, isFocused: false, isPlaced: true }] : [],
  }))
  on('ui.open', (_, e) => { opened = e.id; isUp = true; return { value: { isPlaced: true } } })
  on('ui.close', () => { isUp = false; return { value: undefined } })

  expect((await $.command.run(command('working-on'))).text).toBe('Working on pane opened. Run /working-on again to close it.')
  expect(opened).toBe('focus')
  expect((await $.command.run(command('prs'))).text).toBe('Working on pane closed.')
})

test('the hint line shows the goal in blue once set, and the PRs beside it', async ($, on) => {
  engine(on)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })

  // Before anything is set the engine's own line stands.
  let ui = await $.ui.mount({ ...HINT, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await ui.unmount()

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__focus__set_focus', goal: 'Ship it' })

  ui = await $.ui.mount({ ...HINT, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Ship it/ }))?.text).toBe('◆ Ship it')
  expect((await ui.find({ type: 'Text', text: /shortcuts/ }))?.text).toBe('? for shortcuts  ')
  expect(await ui.find({ type: 'Text', text: /PR/ })).toBe(undefined)
  await ui.unmount()

  await $.command.run(command('prs', `add ${URL_A}`))
  await $.command.run(command('prs', 'refresh'))
  ui = await $.ui.mount({ ...HINT, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /PR/ }))?.text).toBe('  ⎇ 1 PR · CI ✗ #41')
  await ui.unmount()
})

test('the empty pane says so', async $ => {
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Nothing set/ }))?.text).toBe('Nothing set yet.')
  await ui.unmount()
})

test('each prompt carries the guidance as hidden context', async ($, on) => {
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))
  const entered = await $.prompt.submit({ text: 'hello', wait: false, origin: { kind: 'composer' } })
  expect(entered.text).toBe('hello')
  expect(entered.context?.some(block => block.includes('# Focus'))).toBe(true)
  expect(entered.context?.some(block => block.includes('Current pane: empty. PRs: none.'))).toBe(true)
})

test('a Bash gh pr create adds its PR; refresh reads gh and the pane shows it', async ($, on) => {
  const runs: string[][] = []
  engine(on, runs)
  on('tool.call', { tool: 'Bash' }, () => ({
    result: { stdout: `Creating pull request for xy-topic into main in acme/web\n\n${URL_A}\n`, stderr: '', interrupted: false },
    text: URL_A,
  }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'git push -u origin HEAD && gh pr create --fill' })

  const before = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await before.find({ type: 'Text', text: /#41/ }))?.text).toBe('#41 web')
  await before.unmount()

  const answer = await $.command.run(command('prs', 'refresh'))
  expect(answer.text?.startsWith('Refreshed 1 PR.')).toBe(true)
  expect(runs.some(argv => argv[0] === 'gh' && argv[1] === 'pr' && argv[2] === 'view' && argv[3] === URL_A)).toBe(true)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Add the sidebar/ }))?.text).toBe('  Add the sidebar')
  expect((await ui.find({ type: 'Text', text: /1 failing/ }))?.text.includes('✗ 1 failing')).toBe(true)
  expect((await ui.find({ type: 'Text', text: /review needed/ }))?.text.includes('review needed')).toBe(true)
  expect(await ui.find({ type: 'Button', key: 'refresh-prs' })).toBeTruthy()
  await ui.unmount()
})

test('a Bash call that is not gh pr create adds nothing, even with a PR URL in it', async ($, on) => {
  engine(on)
  on('tool.call', { tool: 'Bash' }, () => ({
    result: { stdout: `${URL_A}\n`, stderr: '', interrupted: false },
    text: URL_A,
  }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'gh pr view 41 --json url' })

  expect((await $.command.run(command('prs', 'list'))).text).toBe('No PRs tracked this session.')
})

test('track_pr adds PRs, refreshes them and answers a summary', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const answer = await $.tool.call({ tool: 'mcp__focus__track_pr', urls: [URL_A, URL_B, 'not-a-url'] })
  const text = String(answer.result)

  expect(text.startsWith('Tracking 2 new PRs.')).toBe(true)
  expect(text.includes('Not GitHub PR URLs: not-a-url')).toBe(true)
  expect(text.includes(`Add the sidebar (#41 web) — open, ✗ 1 failing, review needed, ${URL_A}`)).toBe(true)
  expect(text.includes(`Rotate the keys (#7 api) — merged, ✗ 1 failing, ${URL_B}`)).toBe(true)
})

test('/prs add, remove and clear manage the list', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  expect((await $.command.run(command('prs', `add ${URL_A}`))).text).toBe('Tracking #41.')
  expect((await $.command.run(command('prs', `add ${URL_A}`))).text).toBe('Already tracked.')
  expect((await $.command.run(command('prs', 'remove #41'))).text).toBe('Removed 1 PR.')
  expect((await $.command.run(command('prs', 'remove 1'))).text).toBe('Nothing tracked matches "1".')
  await $.command.run(command('prs', `add ${URL_B}`))
  expect((await $.command.run(command('prs', 'clear'))).text).toBe('Cleared the tracked PRs.')
  expect((await $.command.run(command('prs', 'list'))).text).toBe('No PRs tracked this session.')
})

test('a gh failure is shown on the row, not thrown', async ($, on) => {
  engine(on, [], () => ({ exitCode: 1, stdout: '', stderr: 'GraphQL: Could not resolve to a PullRequest\n' }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(command('prs', `add ${URL_A}`))
  await $.command.run(command('prs', 'refresh'))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Could not resolve/ }))?.text).toBe('  GraphQL: Could not resolve to a PullRequest')
  await ui.unmount()
})

test('values an earlier version stored are declined', async ($, on) => {
  on('state.get', (_, e) => ({
    value:
      e.key === 'prs' ? { value: [{ url: URL_A }], version: 1 }
      : e.key === 'focus' ? { value: { goal: 'old' }, version: 1 }
      : { value: undefined, version: 0 },
  }))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Nothing set/ }))?.text).toBe('Nothing set yet.')
  expect((await ui.find({ type: 'Text', text: /none yet/ }))?.text.includes('none yet')).toBe(true)
  await ui.unmount()
})
