import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Checks, Focus, PrState, TrackedPr } from '../types'

const PANE = 'focus'
const TITLE = 'Working on'
const SET_FOCUS = 'mcp__focus__set_focus'
const TRACK_PR = 'mcp__focus__track_pr'
const REFRESH_KEY = 'refresh-prs'

const EMPTY: Focus = { goal: '', done: [], next: [], status: '', updatedAt: 0 }

// Bump a shape tag when its type changes fields: it declines what an earlier
// version stored, which outlives a reload.
const focus = atom({ plugin: 'focus', key: 'focus' } as const, EMPTY, { shape: 'focus-1' })
const prs = atom({ plugin: 'focus', key: 'prs' } as const, [] as TrackedPr[], { shape: 'prs-1' })
const prsRefreshedAt = atom({ plugin: 'focus', key: 'prsRefreshedAt' } as const, 0)
const isRefreshingPrs = atom({ plugin: 'focus', key: 'isRefreshingPrs' } as const, false)

const GUIDANCE = `# Focus
A status line under the prompt shows the session's goal; a pane the user opens with /working-on shows the done and next steps, and the pull requests opened this session. The user relies on these to re-orient, so keep them current with the set_focus tool:
- At task start or when the goal changes: set goal, next, and clear done.
- When a step finishes: move it from next to done. Lists are replaced whole.
- When blocked or waiting: set status (a few words). Clear it when unblocked.
- If asked "what are we working on", answer from it and refresh if stale.
Be terse: goal under 50 characters, each step under 60, status under 20. Noun phrases, no filler. Skip set_focus for trivial one-off questions.
PRs opened with \`gh pr create\` or the GitHub MCP are tracked automatically; call track_pr for ones opened another way, or with no urls to refresh their state.`

// gh pr view reads these; statusCheckRollup is folded into Checks.
const GH_FIELDS =
  'number,title,state,isDraft,mergeable,reviewDecision,statusCheckRollup,url,headRefName,baseRefName'
// A timer polls GitHub while an open PR is tracked; pressing Refresh is immediate.
const POLL_MS = 60_000
const STALE_MS = 90_000

const PR_URL = /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/g
const GH_PR_CREATE = /\bgh\s+pr\s+create\b/
const MCP_CREATE_PR = /create_pull_request$/

// ---------- focus ----------

const asList = (value: unknown): string[] | undefined =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').map(s => s.trim()).filter(Boolean)
    : undefined

const asText = (value: unknown): string | undefined =>
  typeof value === 'string' ? value.trim() : undefined

const clip = (text: string, max: number): string =>
  max <= 1 ? '' : text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text

// ---------- PRs ----------

type Found = Pick<TrackedPr, 'url' | 'owner' | 'repo' | 'number'>

const findPrUrls = (text: string): Found[] => {
  const seen = new Set<string>()
  const found: Found[] = []
  for (const m of text.matchAll(PR_URL)) {
    const [, owner = '', repo = '', num = '0'] = m
    const url = `https://github.com/${owner}/${repo}/pull/${num}`
    if (seen.has(url)) continue
    seen.add(url)
    found.push({ url, owner, repo, number: Number(num) })
  }

  return found
}

// A tool's result as text: what the model read, plus Bash's own stdout.
const textOf = (ran: unknown): string => {
  if (typeof ran !== 'object' || ran === null) return ''
  const parts: string[] = []
  const { text, result } = ran as { text?: unknown; result?: unknown }
  if (typeof text === 'string') parts.push(text)
  if (typeof result === 'object' && result !== null) {
    const { stdout } = result as { stdout?: unknown }
    if (typeof stdout === 'string') parts.push(stdout)
  }

  return parts.join('\n')
}

const blank = (found: Found, source: TrackedPr['source'], now: number): TrackedPr => ({
  ...found,
  source,
  addedAt: now,
  refreshedAt: 0,
  title: '',
  state: 'UNKNOWN',
  isDraft: false,
  reviewDecision: '',
  mergeable: '',
  headRefName: '',
  baseRefName: '',
  checks: { total: 0, passed: 0, failed: 0, pending: 0 },
})

type Rollup = { __typename?: string; status?: string; conclusion?: string; state?: string }

const PASS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED'])
const FAIL = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])

const foldChecks = (rollup: unknown): Checks => {
  const checks: Checks = { total: 0, passed: 0, failed: 0, pending: 0 }
  if (!Array.isArray(rollup)) return checks
  for (const item of rollup as Rollup[]) {
    checks.total += 1
    // A CheckRun reports status + conclusion; a StatusContext reports state.
    const verdict = item.__typename === 'StatusContext'
      ? (item.state ?? '')
      : item.status === 'COMPLETED' ? (item.conclusion ?? '') : 'PENDING'
    if (PASS.has(verdict)) checks.passed += 1
    else if (FAIL.has(verdict)) checks.failed += 1
    else checks.pending += 1
  }

  return checks
}

const asState = (value: unknown): PrState =>
  value === 'OPEN' || value === 'MERGED' || value === 'CLOSED' ? value : 'UNKNOWN'

const isFinal = (pr: TrackedPr): boolean => pr.state === 'MERGED' || pr.state === 'CLOSED'

const fetchOne = async ($: EngineInterface, pr: TrackedPr, now: number): Promise<TrackedPr> => {
  try {
    const ran = await $.process.run(['gh', 'pr', 'view', pr.url, '--json', GH_FIELDS], { timeoutMs: 20_000 })
    if (ran.exitCode !== 0) {
      return { ...pr, error: (ran.stderr || ran.stdout).trim().split('\n')[0] || `gh exited ${ran.exitCode}` }
    }
    const data = JSON.parse(ran.stdout) as Record<string, unknown>

    return {
      ...pr,
      error: undefined,
      refreshedAt: now,
      title: typeof data.title === 'string' ? data.title : pr.title,
      state: asState(data.state),
      isDraft: data.isDraft === true,
      reviewDecision: typeof data.reviewDecision === 'string' ? data.reviewDecision : '',
      mergeable: typeof data.mergeable === 'string' ? data.mergeable : '',
      headRefName: typeof data.headRefName === 'string' ? data.headRefName : '',
      baseRefName: typeof data.baseRefName === 'string' ? data.baseRefName : '',
      checks: foldChecks(data.statusCheckRollup),
    }
  } catch (err) {
    return { ...pr, error: err instanceof Error ? err.message : String(err) }
  }
}

// One refresh at a time; a second ask while one runs shares its result.
let inFlight: Promise<TrackedPr[]> | undefined

const refreshPrs = ($: EngineInterface, only?: (pr: TrackedPr) => boolean): Promise<TrackedPr[]> => {
  if (inFlight) return inFlight
  inFlight = (async () => {
    const list = await read($, prs)
    const targets = list.filter(only ?? (() => true))
    if (targets.length === 0) return list
    await update($, isRefreshingPrs, () => true)
    try {
      const now = await $.clock.now()
      const fresh = await Promise.all(targets.map(pr => fetchOne($, pr, now)))
      const byUrl = new Map(fresh.map(pr => [pr.url, pr]))
      const merged = await update($, prs, current => current.map(pr => byUrl.get(pr.url) ?? pr))
      await update($, prsRefreshedAt, () => now)

      return merged
    } finally {
      await update($, isRefreshingPrs, () => false)
      inFlight = undefined
    }
  })()

  return inFlight
}

const addPrs = async ($: EngineInterface, found: Found[], source: TrackedPr['source']): Promise<TrackedPr[]> => {
  const now = await $.clock.now()
  let added: TrackedPr[] = []
  await update($, prs, current => {
    const known = new Set(current.map(pr => pr.url))
    added = found.filter(pr => !known.has(pr.url)).map(pr => blank(pr, source, now))

    return [...current, ...added]
  })
  if (added.length === 0) return added
  // Unasked, the pane is placed only where it would be a sidebar; else it waits.
  void $.ui.open({ id: PANE, title: TITLE })
  const first = added[0]
  $.ui.toast(added.length === 1 && first ? `Tracking PR #${first.number}` : `Tracking ${added.length} PRs`)
  // A timer rather than an await: the tool's result goes back to the model at
  // once, and the first gh read lands in the pane a moment later.
  const urls = new Set(added.map(pr => pr.url))
  $.clock.after(10, () => {
    void refreshPrs($, pr => urls.has(pr.url))
  })

  return added
}

const ago = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)

  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`
}

const stateGlyph = (pr: TrackedPr): { glyph: string; color: string; word: string } => {
  if (pr.error && pr.state === 'UNKNOWN') return { glyph: '!', color: 'red', word: 'error' }
  if (pr.state === 'MERGED') return { glyph: '⬢', color: 'magenta', word: 'merged' }
  if (pr.state === 'CLOSED') return { glyph: '✖', color: 'red', word: 'closed' }
  if (pr.state === 'OPEN' && pr.isDraft) return { glyph: '◌', color: 'gray', word: 'draft' }
  if (pr.state === 'OPEN') return { glyph: '●', color: 'green', word: 'open' }

  return { glyph: '○', color: 'gray', word: 'pending' }
}

const checksWord = (c: Checks): { text: string; color: string } | undefined => {
  if (c.total === 0) return undefined
  if (c.failed > 0) return { text: `✗ ${c.failed} failing`, color: 'red' }
  if (c.pending > 0) return { text: `… ${c.passed}/${c.total} checks`, color: 'yellow' }

  return { text: `✓ ${c.total} checks`, color: 'green' }
}

const reviewWord = (pr: TrackedPr): { text: string; color: string } | undefined => {
  if (isFinal(pr)) return undefined
  switch (pr.reviewDecision) {
    case 'APPROVED': return { text: 'approved', color: 'green' }
    case 'CHANGES_REQUESTED': return { text: 'changes requested', color: 'red' }
    case 'REVIEW_REQUIRED': return { text: 'review needed', color: 'gray' }
    default: return undefined
  }
}

// The PRs in a few words, for the hint line and the hidden context.
const prsWord = (list: TrackedPr[]): { text: string; color: string } | undefined => {
  if (list.length === 0) return undefined
  const failing = list.filter(pr => pr.checks.failed > 0 && !isFinal(pr))
  const open = list.filter(pr => !isFinal(pr)).length
  const n = `${list.length} PR${list.length === 1 ? '' : 's'}`
  if (failing.length) return { text: `${n} · CI ✗ ${failing.map(pr => `#${pr.number}`).join(' ')}`, color: 'red' }
  if (open === 0) return { text: `${n} · all merged or closed`, color: 'magenta' }

  return { text: `${n} · ${open} open`, color: 'blue' }
}

const prsSummary = (list: TrackedPr[]): string =>
  list.length === 0
    ? 'No PRs tracked this session.'
    : list
        .map(pr => {
          const head = `#${pr.number} ${pr.repo}`
          const bits = [stateGlyph(pr).word]
          const c = checksWord(pr.checks)
          if (c) bits.push(c.text)
          const r = reviewWord(pr)
          if (r) bits.push(r.text)
          if (pr.error) bits.push(`error: ${pr.error}`)
          bits.push(pr.url)

          return `- ${pr.title ? `${pr.title} (${head})` : head} — ${bits.join(', ')}`
        })
        .join('\n')

// The goal as drawn on the hint line under the prompt; the steps and PRs
// live in the pane (/working-on).
const hintLine = (value: Focus): string | undefined => {
  if (!value.goal) return undefined
  const line = clip(value.goal, 60)

  return value.status ? `${line}  ⚠ ${clip(value.status, 24)}` : line
}

// /working-on and a bare /prs toggle the pane: open it, or close it when it is up.
const togglePane = async ($: EngineInterface): Promise<{ text: string }> => {
  const isUp = (await $.ui.panes()).some(pane => pane.id === PANE)
  if (isUp) {
    await $.ui.close({ id: PANE })

    return { text: 'Working on pane closed.' }
  }
  await $.ui.open({ id: PANE, title: TITLE })

  return { text: 'Working on pane opened. Run /working-on again to close it.' }
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
    await $.tool.register({
      name: 'track_pr',
      description:
        'Add pull requests to the "Working on" pane the user sees beside the chat, and refresh their state from GitHub. PRs opened with `gh pr create` or the GitHub MCP create_pull_request tool are tracked automatically; call this for ones opened another way (a URL the user pasted, another agent). With no urls it only refreshes.',
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          urls: { type: 'array', items: { type: 'string' }, description: 'GitHub pull request URLs to track.' },
          refresh: { type: 'boolean', description: 'Re-read every tracked PR from GitHub now. Default true.' },
        },
      },
    })
    await $.command.register({
      name: 'working-on',
      description: 'Toggle the Working on pane: goal, next and done steps, and the PRs opened this session',
    })
    await $.command.register({
      name: 'prs',
      description: 'The PRs opened this session: `refresh`, `add <url>`, `remove <#|url>`, `clear`, `list`; alone, toggles the pane',
      argumentHint: '[refresh | add <url> | remove <#> | clear | list]',
    })
    $.ui.status(undefined)

    // While an unfinished PR is tracked, re-read it about every minute and a half.
    $.clock.every(POLL_MS, () => {
      void (async () => {
        const list = await read($, prs)
        const last = await read($, prsRefreshedAt)
        const now = await $.clock.now()
        if (list.some(pr => !isFinal(pr)) && now - last >= STALE_MS) {
          await refreshPrs($, pr => !isFinal(pr))
        }
      })()
    })

    return next(e)
  })

  on('command.run', { command: 'working-on' }, $ => togglePane($))

  on('command.run', { command: 'prs' }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/).filter(Boolean)
    const arg = rest.join(' ')

    if (verb === 'refresh' || verb === 'r') {
      const list = await refreshPrs($)

      return { text: list.length ? `Refreshed ${list.length} PR${list.length === 1 ? '' : 's'}.\n${prsSummary(list)}` : 'No PRs tracked this session.' }
    }
    if (verb === 'add') {
      const found = findPrUrls(arg)
      if (found.length === 0) return { text: 'Usage: /prs add https://github.com/<owner>/<repo>/pull/<n>' }
      const added = await addPrs($, found, 'manual')

      return { text: added.length ? `Tracking ${added.map(pr => `#${pr.number}`).join(', ')}.` : 'Already tracked.' }
    }
    if (verb === 'remove' || verb === 'rm') {
      const num = Number(arg.replace(/^#/, ''))
      const byUrl = findPrUrls(arg)[0]?.url
      let removed = 0
      await update($, prs, current => {
        const kept = current.filter(pr => !(pr.url === byUrl || (Number.isFinite(num) && num > 0 && pr.number === num)))
        removed = current.length - kept.length

        return kept
      })

      return { text: removed ? `Removed ${removed} PR${removed === 1 ? '' : 's'}.` : `Nothing tracked matches "${arg}".` }
    }
    if (verb === 'clear') {
      await update($, prs, () => [])

      return { text: 'Cleared the tracked PRs.' }
    }
    if (verb === 'list' || verb === 'ls') return { text: prsSummary(await read($, prs)) }

    return togglePane($)
  })

  on('tool.call', { tool: SET_FOCUS }, async ($, e) => {
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

  on('tool.call', { tool: TRACK_PR }, async ($, e) => {
    const urls = Array.isArray(e.urls) ? e.urls.filter((u): u is string => typeof u === 'string') : []
    const found = findPrUrls(urls.join('\n'))
    const bad = urls.filter(u => findPrUrls(u).length === 0)
    const added = found.length ? await addPrs($, found, 'manual') : []
    const list = e.refresh !== false ? await refreshPrs($) : await read($, prs)
    const lines = [
      added.length ? `Tracking ${added.length} new PR${added.length === 1 ? '' : 's'}.` : found.length ? 'Already tracked.' : '',
      bad.length ? `Not GitHub PR URLs: ${bad.join(', ')}` : '',
      prsSummary(list),
    ].filter(Boolean)

    return { result: lines.join('\n') }
  })

  // Capture: a Bash `gh pr create`, or a GitHub MCP create_pull_request call,
  // whose result names a PR URL.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    const isBashCreate = e.tool === 'Bash' && GH_PR_CREATE.test(e.command)
    const isMcpCreate = MCP_CREATE_PR.test(e.tool)
    if (!isBashCreate && !isMcpCreate) return ran
    const found = findPrUrls(textOf(ran))
    if (found.length > 0) await addPrs($, found, isBashCreate ? 'bash' : 'mcp')

    return ran
  })

  // The system-prompt route (prompt.compose) is gated by an organization
  // policy plugin here, so the guidance rides beside each prompt instead:
  // context the model reads and the person never sees.
  on('prompt.submit', async ($, e, next) => {
    const value = await read($, focus)
    const list = await read($, prs)
    const pane = value.goal
      ? `Current pane: goal "${value.goal}"; next: ${value.next.join(' | ') || 'none'}; done: ${value.done.length}; status: ${value.status || 'none'}.`
      : 'Current pane: empty.'
    const summary = `${pane} PRs: ${prsWord(list)?.text ?? 'none'}.`

    return next({ ...e, context: [...(e.context ?? []), `${GUIDANCE}\n${summary}`] })
  })

  // The hint line under the prompt: the engine's hint, dim, then the goal in
  // blue and the PRs in a few words. With nothing set the engine's own line is left alone.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const value = await read($, focus)
    const list = await read($, prs)
    const line = hintLine(value)
    const word = prsWord(list)
    if (line === undefined && word === undefined) return next(e)

    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="row">
        {e.props.hint ? <Text dimColor wrap="truncate">{e.props.hint}  </Text> : null}
        {line !== undefined ? <Text color="blue" wrap="truncate">◆ {line}</Text> : null}
        {word ? <Text color={word.color} wrap="truncate">{line !== undefined ? '  ' : ''}⎇ {word.text}</Text> : null}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const value = await read($, focus)
    const list = await read($, prs)
    const busy = await read($, isRefreshingPrs)
    const last = await read($, prsRefreshedAt)
    const now = Date.now()
    const width = e.props.bodyColumns
    const hasFocus = Boolean(value.goal) || value.done.length > 0 || value.next.length > 0

    const focusPart = hasFocus ? (
      <Box flexDirection="column" gap={1}>
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
    ) : (
      <Box flexDirection="column">
        <Text dimColor>Nothing set yet.</Text>
        <Text dimColor>Claude fills this in once a task starts.</Text>
      </Box>
    )

    const prsHeader = (
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold>
          PRs
          <Text dimColor>
            {list.length === 0 ? '  none yet' : `  ${list.length}`}
            {last ? ` · refreshed ${ago(now - last)} ago` : ''}
          </Text>
        </Text>
        {list.length > 0 ? (
          <Button
            key={REFRESH_KEY}
            hotkey="r"
            dimColor={busy === true}
            onPress={() => {
              void refreshPrs($)
            }}
          >
            {busy === true ? 'Refreshing…' : 'Refresh'}
          </Button>
        ) : null}
      </Box>
    )

    const prsPart = (
      <Box flexDirection="column" gap={1}>
        {prsHeader}
        {list.length === 0 ? (
          <Text dimColor wrap="wrap">Opened with gh pr create or the GitHub MCP, or added with /prs add &lt;url&gt;.</Text>
        ) : (
          list.map(pr => {
            const s = stateGlyph(pr)
            const c = checksWord(pr.checks)
            const r = reviewWord(pr)
            const conflict = pr.mergeable === 'CONFLICTING' && !isFinal(pr)

            return (
              <Box key={pr.url} flexDirection="column">
                <Box flexDirection="row">
                  <Text color={s.color}>{s.glyph} </Text>
                  <Text bold wrap="truncate">
                    #{pr.number} <Text dimColor>{pr.repo}</Text>
                  </Text>
                </Box>
                <Text wrap="truncate">
                  {'  '}{pr.title ? clip(pr.title, Math.max(8, width - 12)) : <Text dimColor>reading from GitHub…</Text>}
                </Text>
                <Box flexDirection="row">
                  <Text>{'  '}</Text>
                  <Text color={s.color}>{s.word}</Text>
                  {c ? <Text> · <Text color={c.color}>{c.text}</Text></Text> : null}
                  {r ? <Text> · <Text color={r.color}>{r.text}</Text></Text> : null}
                  {conflict ? <Text> · <Text color="red">conflicts</Text></Text> : null}
                </Box>
                {pr.headRefName ? (
                  <Text dimColor wrap="truncate">{'  '}{clip(pr.headRefName, width - 2)}</Text>
                ) : null}
                {pr.error ? (
                  <Text color="red" wrap="truncate">{'  '}{clip(pr.error, width - 2)}</Text>
                ) : null}
                <Text dimColor wrap="truncate">
                  {'  '}<Link href={pr.url} label={`${pr.owner}/${pr.repo}#${pr.number}`} />
                </Text>
              </Box>
            )
          })
        )}
      </Box>
    )

    return (
      <Box flexDirection="column" paddingX={1} gap={1}>
        {focusPart}
        <Text dimColor>{'─'.repeat(Math.max(1, width - 2))}</Text>
        {prsPart}
      </Box>
    )
  })
}
