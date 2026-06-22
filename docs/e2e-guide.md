# E2E Test Guide

This project's Playwright suite exercises the real built Electron app
end-to-end. Specs sit in `e2e/`, share a single fixture under
`e2e/fixtures/electron-fixture.ts`, and lean on a handful of high-level
helpers so each test reads like a user story rather than IPC plumbing.

## Quick start

```bash
# Headless run (CI default).
bun run test:e2e

# Headed run with DevTools auto-opened on the renderer.
bun run test:e2e:devtools

# Pick a single test.
bun run test:e2e:single "session lifecycle"

# Open the Playwright UI explorer.
bun run test:e2e:ui

# Force trace capture on every test (handy when you don't know which
# spec will fail).
bun run test:e2e:trace
```

## Writing a spec

Use the project fixture rather than the bare `@playwright/test` one —
the fixture wires up Electron launch, log capture, dialog auto-accept,
process-leak detection, and per-test data isolation.

```ts
import { test, expect } from "../fixtures/electron-fixture";
import { createProject, createSession, awaitSessionComplete } from "../helpers/ipc";
import { dumpDb } from "../helpers/dump";

test("my flow", async ({ window, dataDir, expectNoRendererErrors }) => {
  // dataDir is an isolated temp folder set as AGENTDOCK_DATA_DIR.
  await createProject(window, { name: "demo", path: dataDir });
  // ... assertions ...
  expectNoRendererErrors();
});
```

### Fixture surface

The fixture provides:

| Field | Why |
|---|---|
| `app` | The `ElectronApplication` handle. |
| `window` | The first BrowserWindow page (renderer). |
| `dataDir` | Per-test temp dir set as `AGENTDOCK_DATA_DIR`. Auto-cleaned. |
| `mainLog` | Lines from main process stdout/stderr (incl. forwarded daemon logs). |
| `rendererLog` | Renderer `console.*` entries. |
| `pageErrors` | Uncaught renderer exceptions. |
| `dialogs` | Native dialogs (`window.alert`) — recorded then auto-accepted. |
| `expectNoRendererErrors()` | Throw if anything ended up in `pageErrors` or as `console.error`. |
| `childPids()` | Pids of the Electron main process's children — empty after `app.close()` or you've leaked something. |

### Helpers

- `e2e/helpers/ipc.ts` — typed wrappers over `window.api.*` (`initDb`,
  `createProject`, `createSession`, `awaitSessionComplete`,
  `deleteSession`, `renameSession`, …). `createSession` installs a
  page-side stream-capture shim so you can `await
  awaitSessionComplete(window, id)` instead of subscribing to
  `session:<id>:step` by hand.
- `e2e/helpers/dump.ts` — `dumpDb(projectPath)`, `dumpWorktreeTree`,
  `dumpDaemonState`. These read state directly (no IPC) so a spec can
  assert against what was actually persisted.

## Debugging a failure

The fixture attaches diagnostics only on failure (so passing CI runs
don't bloat artifact storage):

- `main.log` — every byte main wrote to stdout/stderr, including
  forwarded `[daemon] ...` lines.
- `renderer.log` — every console message from the renderer.
- `pageerrors.json` — uncaught renderer errors with stacks.
- `dialogs.json` — any `window.alert` or `confirm` the renderer popped.

Open the failure artifact directory printed by Playwright, then:

```bash
# Replay the trace step-by-step in a browser.
bunx playwright show-trace test-results/<test-folder>/trace.zip
```

To reproduce locally with eyes on the renderer:

```bash
AGENTDOCK_E2E_DEVTOOLS=1 bun run test:e2e:headed -- --grep "my flow"
```

`AGENTDOCK_E2E_KEEP_DATA=1` will skip the post-test cleanup of the
temp `AGENTDOCK_DATA_DIR` so you can poke around the resulting
`.agentdock/worktrees/` and `.data/db.sqlite`.

## Adding test IDs

The renderer adds `data-testid` attributes to user-facing surfaces;
the canonical list lives in `e2e/pages/` (one Page Object per surface).
When you add a new interactive control, give it a stable testid and
update the Page Object — `e2e/pages/README.md` enumerates conventions.

## When the fixture catches what your spec misses

- **Daemon errors invisible in DOM**: `main.log` now carries
  `[daemon] …` lines from the daemon child. If a daemon route 500s,
  you'll see it there even though the renderer just shows "Loading…".
- **Stale Electron processes**: `childPids()` runs after `app.close()`
  and warns to the test log if a daemon or PTY didn't exit. Treat
  these warnings as bugs — they cause flakiness in the next test.
- **Native alerts auto-accepted**: `window.alert("API failed")`
  doesn't block the renderer in tests, but it lands in `dialogs.json`
  so you can assert it never happened.
