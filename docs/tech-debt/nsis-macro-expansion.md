# Technical Debt: NSIS customInstall/customUnInstall macros don't expand

## Status: Known issue, deferred

## Symptom

When the AgentDock NSIS installer is built, macros defined in
`build/installer/custom-uninstall.nsh` are not expanded by
`!ifmacrodef` blocks in electron-builder's NSIS templates. The
`!ifmacrodef preInit` and `!ifmacrodef customUnInstall` blocks
remain empty in the generated `builder-debug.yml` — the
`!insertmacro` line produces no content.

## Reproduction

1. Build with the current `electron-builder.yml` (which includes
   `build/installer/custom-uninstall.nsh` via `nsis.include`).
2. Inspect `release/0.2.0/builder-debug.yml`.
3. Search for `!ifmacrodef preInit` and `!ifmacrodef customUnInstall`.
4. The corresponding `!insertmacro` line has no content — the macro
   was not recognized by NSIS 3.0.4.

## Root cause

Unknown. Hypotheses:

- NSIS 3.0.4 doesn't see `!macro` definitions in utf-8 .nsh files
  (the file is valid ASCII, so this seems unlikely).
- electron-builder's include mechanism uses a different macro
  namespace than expected.
- `!ifmacrodef` only matches macros defined in the *same file*, not
  in included files (although my minimal repro shows this should
  work).

## Workaround attempted

- Renamed `customUnInstallSection` to `customUnInstall` (the former
  is expanded after `SectionEnd` where runtime commands are
  invalid).
- Replaced template variables like `${INSTALL_REGISTRY_KEY}` with
  hardcoded paths to avoid potential undefined-variable issues.
- Verified the file is plain ASCII with no BOM.

None of these fixed the expansion. The macros are still not seen
by `!ifmacrodef`.

## Impact

For the default perUser install path:

- `C:\ProgramData\AgentDock` is never created (perUser install
  doesn't touch ProgramData).
- The legacy `InstallLocation` registry cache is not cleared by
  the `preInit` macro. This means a previous perMachine install
  leaves a stale default in the registry, which the next perUser
  install reads. Verified manually: uninstalling v0.2.3 and
  deleting `HKLM\SOFTWARE\AgentDock` before installing v0.3.0
  yields the correct default path.

For the perMachine install path (rare for this project):

- `C:\ProgramData\AgentDock` is not cleaned at uninstall. Users
  must manually delete the directory.

## Resolution options

| Option | Effort | Tradeoff |
|---|---|---|
| A. Accept current behavior, document workaround | 0 | Manual cleanup needed for perMachine users |
| B. Fork electron-builder NSIS template to inject runtime hooks | Medium (1-2 days) | Maintain fork across electron-builder upgrades |
| C. Switch to Inno Setup | High (3-5 days) | Lose electron-updater differential updates |
| D. Move cleanup to main-process uninstall wrapper | Medium (1 day) | Custom uninstall script; can call Node API |

## Decision

**Selected: A.** Defer to "when we actually need perMachine install
for non-trivial users". For now the perUser path is correct.

## Revisit when

- Any user reports a real perMachine install issue
- We decide to ship a true perMachine shared-data mode
- electron-builder changes its NSIS hook contract in a way that
  makes our approach easier
