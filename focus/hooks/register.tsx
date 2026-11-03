import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Focus } from '../types'

const PANE = 'focus'
const TITLE = 'Working on'
const TOOL = 'mcp__focus__set_focus'

const EMPTY: Focus = { goal: '', done: [], next: [], status: '', updatedAt: 0 }

// Bump the shape tag when Focus changes fields: it declines what an earlier
// version stored, which outlives a reload.
const focus = atom({ plugin: 'focus', key: 'focus' } as const, EMPTY, {
  shape: 'focus-1',
})

const GUIDANCE = `# Focus
A status line under the prompt shows the session's goal; a pane the user opens with /working-on shows the done and next steps. The user relies on these to re-orient, so keep them current with the set_focus tool:
- At task start or when the goal changes: set goal, next, and clear done.
- When a step finishes: move it from next to done. Lists are replaced whole.
- When blocked or waiting: set status (a few words). Clear it when unblocked.
- If asked "what are we working on", answer from it and refresh if stale.
Be terse: goal under 50 characters, each step under 60, status under 20. Noun phrases, no filler. Skip set_focus for trivial one-off questions.`

const asList = (value: unknown): string[] | undefined =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').map(s => s.trim()).filter(Boolean)
    : undefined

const asText = (value: unknown): string | undefined =>
  typeof value === 'string' ? value.trim() : undefined

// The goal as drawn on the hint line under the prompt; the steps live in
// the pane (/working-on).
const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text

const goalLine = (value: Focus): string | undefined => {
  if (!value.goal) return undefined
  const line = clip(value.goal, 60)

  return value.status ? `${line}  ⚠ ${clip(value.status, 24)}` : line
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'set_focus',
      description:
        'Update the "Working on" pane the user sees beside the chat. Set the goal, the full list of done steps, the full list of next steps, and a short status. Omitted fields keep their current value; lists are replaced whole.',
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'One line: what the session is trying to accomplish.' },
          done: { type: 'array', items: { type: 'string' }, description: 'Steps finished so far, oldest first. Replaces the current list.' },
          next: { type: 'array', items: { type: 'string' }, description: 'Steps still to do, next first. Replaces the current list.' },
          status: { type: 'string', description: 'Where things stand now, e.g. "blocked on CI". Empty string clears it.' },
        },
      },
    })
    await $.command.register({
      name: 'working-on',
      description: 'Toggle the Working on pane: the full goal, next and done lists',
    })
    $.ui.status(undefined)

    return next(e)
  })

  // /working-on toggles the pane: open it, or close it when it is up.
  on('command.run', { command: 'working-on' }, async $ => {
    const isUp = (await $.ui.panes()).some(pane => pane.id === PANE)
    if (isUp) {
      await $.ui.close({ id: PANE })

      return { text: 'Working on pane closed.' }
    }
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'Working on pane opened. Run /working-on again to close it.' }
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const goal = asText(e.goal)
    const done = asList(e.done)
    const nextSteps = asList(e.next)
    const status = asText(e.status)

    const now = await update($, focus, current => ({
      goal: goal ?? current.goal,
      done: done ?? current.done,
      next: nextSteps ?? current.next,
      status: status ?? current.status,
      updatedAt: Date.now(),
    }))
    // A registered tool answers the model with text.
    const lines = [
      `Goal: ${now.goal || '(not set)'}`,
      `Status: ${now.status || 'none'}`,
      `Next: ${now.next.length ? now.next.join(' | ') : 'none'}`,
      `Done: ${now.done.length ? now.done.join(' | ') : 'none'}`,
    ]

    return { result: `Focus pane updated.\n${lines.join('\n')}` }
  })

  // The system-prompt route (prompt.compose) is gated by an organization
  // policy plugin here, so the guidance rides beside each prompt instead:
  // context the model reads and the person never sees.
  on('prompt.submit', async ($, e, next) => {
    const value = await read($, focus)
    const summary = value.goal
      ? `Current pane: goal "${value.goal}"; next: ${value.next.join(' | ') || 'none'}; done: ${value.done.length}; status: ${value.status || 'none'}.`
      : 'Current pane: empty.'

    return next({ ...e, context: [...(e.context ?? []), `${GUIDANCE}\n${summary}`] })
  })

  // The hint line under the prompt: the engine's hint, dim, then the goal in
  // blue. With no goal set the engine's own line is left alone.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const value = await read($, focus)
    const line = goalLine(value)
    if (line === undefined) return next(e)

    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="row">
        {e.props.hint ? <Text dimColor wrap="truncate">{e.props.hint}  </Text> : null}
        <Text color="blue" wrap="truncate">◆ {line}</Text>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const value = await read($, focus)
    const isEmpty = !value.goal && value.done.length === 0 && value.next.length === 0

    if (isEmpty) {
      return (
        <Box flexDirection="column" paddingX={1}>
          <Text dimColor>Nothing set yet.</Text>
          <Text dimColor>Claude fills this in once a task starts.</Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" paddingX={1} gap={1}>
        <Box flexDirection="column">
          <Text bold>Goal</Text>
          <Text wrap="wrap">{value.goal || '(not set)'}</Text>
        </Box>
        {value.status ? (
          <Box flexDirection="column">
            <Text bold color="yellow">Status</Text>
            <Text wrap="wrap">{value.status}</Text>
          </Box>
        ) : null}
        <Box flexDirection="column">
          <Text bold>Next</Text>
          {value.next.length === 0 ? (
            <Text dimColor>nothing queued</Text>
          ) : (
            value.next.map((step, i) => (
              <Text wrap="wrap">
                {i === 0 ? '→ ' : '  '}{step}
              </Text>
            ))
          )}
        </Box>
        <Box flexDirection="column">
          <Text bold>Done</Text>
          {value.done.length === 0 ? (
            <Text dimColor>nothing yet</Text>
          ) : (
            value.done.map(step => (
              <Text dimColor wrap="wrap">
                ✓ {step}
              </Text>
            ))
          )}
        </Box>
      </Box>
    )
  })
}
