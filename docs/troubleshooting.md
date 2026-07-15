# Troubleshooting

## UserData Locations

AgentDock stores its data based on install mode:

| Install mode | Path |
|---|---|
| perUser (default) | `%APPDATA%\AgentDock\` |
| perMachine | `%PROGRAMDATA%\AgentDock\` |

The global projects list (the tabs you see at the top) lives at:

| Install mode | Global projects DB |
|---|---|
| perUser | `%APPDATA%\AgentDock\global\projects.db` |
| perMachine | `%PROGRAMDATA%\AgentDock\global\projects.db` |

## Same project shows multiple tabs

If you see the same project name twice (e.g. "Copilot-Switch" appearing
twice), the global projects DB has duplicate entries with different path
spellings (e.g. trailing slash, mixed case, forward vs back slashes).

This was a bug in v0.2.x where the dedup only compared exact path strings.
**Fixed in v0.3.0+** — fuzzy match + path healing.

For older installs, see "Manual cleanup" below.

## Manual cleanup

If you have leftover data from an old version or a botched uninstall:

```cmd
:: Per-user data
rmdir /s /q "%APPDATA%\AgentDock"

:: Per-machine data (if installed perMachine)
rmdir /s /q "%PROGRAMDATA%\AgentDock"

:: Git worktree leftovers inside a project directory
rmdir /s /q "<project-path>\.agentdock\worktrees"
```

After cleanup, **reinstall v0.3.0+** which uses
`deleteAppDataOnUninstall: true` and a custom NSIS uninstall macro to
also clear `%PROGRAMDATA%\AgentDock` on perMachine installs.

## v0.3.0+ uninstall behavior

`deleteAppDataOnUninstall: true` plus the `customUnInstall` macro in
`build/installer/installer.nsh` clears:

1. `%APPDATA%\AgentDock\` (per-user appData)
2. `%PROGRAMDATA%\AgentDock\` (perMachine data, if it exists)

On upgrade, the install is preserved (no data wipe) — the
`${isUpdated}` define distinguishes fresh install from update.

## Git worktree cleanup

AgentDock's `syncProject` (called on every project open) runs
`git worktree prune` and removes incomplete worktree directories
(no `.git` pointer, left over from failed session creation). If you
still see weirdness, run from the project root:

```bash
git worktree prune
ls .agentdock/worktrees  # check for leftover empty dirs
```

## NSIS custom-uninstall macro not expanding (technical debt)

If you see install-mode page still shows "for all users" or the default
install path is wrong, the NSIS macro in `build/installer/installer.nsh`
didn't expand at build time. See
`docs/tech-debt/nsis-macro-expansion.md` for details and the
documented workaround (the v0.2.3 release workflow used the macro).
