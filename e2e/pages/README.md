# Page Objects

Each file here wraps one renderer surface in a typed locator API so
specs read like user stories. Pair with the testids in `testids.ts` —
the React components carry the same constants as `data-testid`
attributes (see `docs/e2e-guide.md` for the conventions).

| File | Surface | Key entry points |
|---|---|---|
| `home.ts` | Home page + DirBrowserModal | `HomePage.openProject(path)` |
| `tab-bar.ts` | Open-project tab strip | `TabBarPage.switchTo(id)`, `openProjectViaPlusButton()` |
| `sidebar.ts` | SessionSidebar | `SidebarPage.clickNewSession()`, `waitForCard(id)` |
| `terminal.ts` | TerminalManager + SessionTerminal | `TerminalPage.waitForStatus("connected")` |

## Conventions

- **`data-testid` is for tests only.** Don't reuse it for styling or
  analytics. Add the value to `testids.ts` so the rename surfaces as
  a TS error in every Page Object that uses it.
- **Pair testids with a stable `data-*` attribute** for repeatable
  rows: `data-project-id` for tabs, `data-session-id` for session
  cards, `data-terminal-id` for terminal tabs. Locators target the
  pair (`[data-testid="session-card"][data-session-id="abc"]`) so the
  test doesn't care about render order.
- **xterm is opaque.** Asserting on terminal output by reading the DOM
  doesn't work — xterm paints to canvas. Use `data-status` on
  `[data-testid="session-terminal"]` (one of `connecting` /
  `connected` / `disconnected` / `error` / `exited`). For input/output
  assertions, drive through the IPC helpers in `e2e/helpers/ipc.ts`
  and observe DB/filesystem state instead.
