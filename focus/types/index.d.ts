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

declare module 'claude-code' {
  interface PluginState {
    focus: { focus: Shaped<Focus> }
  }
}
