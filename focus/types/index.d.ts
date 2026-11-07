export type Focus = {
  /** One line: what the session is trying to accomplish. */
  goal: string
  /** Steps finished so far, oldest first. */
  done: string[]
  /** Steps still to do, next first. */
  next: string[]
  /** Short note on where things stand right now (blocked on X, waiting on CI). */
  status: string
  /** Epoch milliseconds of the last change. */
  updatedAt: number
}

export type PrState = 'OPEN' | 'MERGED' | 'CLOSED' | 'UNKNOWN'

export type Checks = {
  total: number
  passed: number
  failed: number
  pending: number
}

export type TrackedPr = {
  /** Canonical https://github.com/<owner>/<repo>/pull/<n>. */
  url: string
  owner: string
  repo: string
  number: number
  /** How the PR entered the list. */
  source: 'bash' | 'mcp' | 'manual'
  /** Epoch ms when it was first tracked. */
  addedAt: number
  /** Epoch ms of the last successful gh read; 0 before the first. */
  refreshedAt: number
  /** The last gh error, when the read failed. */
  error?: string
  title: string
  state: PrState
  isDraft: boolean
  /** gh's reviewDecision: APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED or ''. */
  reviewDecision: string
  /** gh's mergeable: MERGEABLE, CONFLICTING, UNKNOWN or ''. */
  mergeable: string
  headRefName: string
  baseRefName: string
  checks: Checks
}

declare module 'claude-code' {
  interface PluginState {
    focus: {
      focus: Shaped<Focus>
      prs: Shaped<TrackedPr[]>
      /** Epoch ms of the last PR refresh that ran, 0 before any. */
      prsRefreshedAt: number
      isRefreshingPrs: boolean
    }
  }
}
