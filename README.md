# claude-code-mods

Mods for [Claude Code](https://code.claude.com/docs/en/plugins/mods/overview): small plugins that change Claude Code's own interface or behaviour. Each mod lives in its own folder and this repository is a plugin marketplace, so any of them installs with one line.

## Mods

### focus

Answers "what are we working on?" without asking. The session's goal is drawn in blue on the hint line under the prompt box, and a pane lists what is done, what is next, and the pull requests opened this session. Claude keeps the goal and steps current: at the start of a task, when a step finishes, and when it gets blocked, it calls a `set_focus` tool the mod registers.

- The goal under the prompt, as `◆ <goal>`, with a short warning appended when something is blocked, and a PR count beside it (`⎇ 2 PRs · 1 open`, red when CI is failing).
- `/working-on` toggles a pane with the full next and done lists and a **PRs** section.
- PRs join the list on their own: any Bash `gh pr create` whose output names a PR URL, any GitHub MCP `create_pull_request` call, `/prs add <url>`, or Claude calling the `track_pr` tool for ones opened another way.
- Each PR shows state (open, draft, merged, closed), checks (passing, pending or failing), review decision, conflicts, branch and a link. A **Refresh** button in the pane (hotkey `r` while it has focus), `/prs refresh`, or `track_pr` with no URLs re-reads GitHub through `gh pr view`; while an open PR is tracked the mod polls about every minute and a half.
- `/prs remove <#|url>`, `/prs clear` and `/prs list` manage the list; a bare `/prs` toggles the same pane.
- Guidance rides beside each prompt as hidden context, so it works even where an organization policy plugin gates the system prompt.
- State lives in the session, so it survives the mod reloading and starts empty with each new session.

Needs the GitHub CLI `gh`, logged in to an account that can read the PRs. Nothing is written to GitHub.

Built and tested on Claude Code 2.1.316.

## Install

At the prompt of a terminal session:

```
/plugin install focus --marketplace yngx/claude-code-mods
```

Answer `y` to add the marketplace, then pick a scope. From a shell instead:

```
claude plugin install focus --marketplace yngx/claude-code-mods
```

To try a mod from a checkout without installing it:

```
claude --plugin-dir ./focus
```

## Develop

Each mod folder validates and tests on its own:

```
claude plugin validate ./focus
claude plugin test ./focus
```

Claude Code writes type declarations into `<mod>/.claude-plugin/types/` the first time it loads a mod from `--plugin-dir`; they are generated per machine and ignored by git.

## License

MIT
