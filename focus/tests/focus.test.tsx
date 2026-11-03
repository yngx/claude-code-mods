import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'focus',
  component: 'Pane',
  requestId: 'focus',
  props: {
    title: 'Working on',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

test('the pane shows the goal, next and done after set_focus', async ($, on) => {
  on('tool.register', () => ({ value: { tool: 'mcp__focus__set_focus' } }))
  on('command.register', () => ({ value: { command: 'working-on' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

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
  await ui.unmount()
})

test('omitted fields keep their value; lists replace whole', async ($, on) => {
  on('tool.register', () => ({ value: { tool: 'mcp__focus__set_focus' } }))
  on('command.register', () => ({ value: { command: 'working-on' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__focus__set_focus', goal: 'A goal', next: ['one', 'two'] })
  const answer = await $.tool.call({ tool: 'mcp__focus__set_focus', done: ['one'], next: ['two'] })

  expect(answer.result).toBe('Focus pane updated.\nGoal: A goal\nStatus: none\nNext: two\nDone: one')
})

test('/working-on toggles the pane', async ($, on) => {
  let opened = ''
  let closed = ''
  let isUp = false
  on('ui.panes', () => ({ value: isUp ? [{ id: 'focus', title: 'Working on', isShown: true, isFocused: false, isPlaced: true }] : [] }))
  on('ui.open', (_, e) => { opened = e.id; isUp = true; return { value: { isPlaced: true } } })
  on('ui.close', (_, e) => { closed = e.id; isUp = false; return { value: undefined } })

  const first = await $.command.run({ command: 'working-on', args: '' })
  expect(first.text).toBe('Working on pane opened. Run /working-on again to close it.')
  expect(opened).toBe('focus')

  const second = await $.command.run({ command: 'working-on', args: '' })
  expect(second.text).toBe('Working on pane closed.')
  expect(closed).toBe('focus')
})

test('the hint line shows the goal in blue once set', async ($, on) => {
  on('tool.register', () => ({ value: { tool: 'mcp__focus__set_focus' } }))
  on('command.register', () => ({ value: { command: 'working-on' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })

  const HINT = {
    plugin: 'focus',
    component: 'PromptHint',
    props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
  } as const

  // Before a goal is set the engine's own line stands.
  let ui = await $.ui.mount({ ...HINT, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await ui.unmount()

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__focus__set_focus', goal: 'Ship it' })

  ui = await $.ui.mount({ ...HINT, surface: 'terminal' })
  const goal = await ui.find({ type: 'Text', text: /Ship it/ })
  expect(goal?.text).toBe('◆ Ship it')
  expect((await ui.find({ type: 'Text', text: /shortcuts/ }))?.text).toBe('? for shortcuts  ')
  await ui.unmount()
})

test('the empty pane says so', async $ => {
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Nothing set/ }))?.text).toBe('Nothing set yet.')
  await ui.unmount()
})

test('each prompt carries the guidance as hidden context', async ($, on) => {
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))
  const entered = await $.prompt.submit({ text: 'hello' })
  expect(entered.text).toBe('hello')
  expect(entered.context?.some(block => block.includes('# Focus'))).toBe(true)
  expect(entered.context?.some(block => block.includes('Current pane: empty.'))).toBe(true)
})
