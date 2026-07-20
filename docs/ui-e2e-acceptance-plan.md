# UI E2E acceptance plan

## Gates

1. Build: `FRONTEND_PORT=5197 bunx electron-vite build`.
2. Component workflows: Session rename/delete, Session context menu, Terminal create/type/switch/delete/context menu, Orphan select/delete, Hook Error open/close/retry, ConfigEditor load/edit/preview/save.
3. Accessibility: Axe serious/critical gate on Home, Settings and ConfigEditor; keyboard focus, Escape dismissal, menu arrow navigation, reduced-motion media mode.
4. Visual: stable Home snapshot plus focused screenshots for ConfigEditor and both dialogs at 100%, 125% and narrow-width layouts.
5. Isolation: every Electron run uses a unique `--user-data-dir` and `AGENTDOCK_DEV_INSTANCE`.

## Required scenarios

- Right-click Session and Terminal targets near all four viewport edges; menus remain visible and focus the first item.
- Operate menus with ArrowUp/ArrowDown/ArrowRight/Enter/Escape; disabled/destructive items retain semantics.
- Open Orphan and Hook Error dialogs by mouse and keyboard; focus is trapped, Escape closes, focus returns to the trigger, destructive actions cannot double-submit.
- Load canonical, missing and invalid configuration; edit each section, preview YAML, save, reload and verify persistence.
- Enable `prefers-reduced-motion: reduce`; all controls and state changes remain available without animation.
- Run light/dark themes and verify text, borders, focus rings and status colors against WCAG AA.

## Aesthetic and micro-interaction acceptance

- Operator Console hierarchy: one primary accent, restrained neutral surfaces, mono metadata, consistent 8px radius and spacing rhythm.
- Hover 120ms, state change 180ms, overlays 180–240ms using transform/opacity only; pressed controls scale to 0.97.
- Focus rings are always visible for keyboard input. Loading, success and destructive states use icons plus text, never color alone.
- No general animation library is required. Tailwind transitions and Radix state animations cover current menus/dialogs with less bundle and lifecycle cost. Introduce GSAP only for a future choreographed timeline, complex SVG, drag/FLIP or scroll-linked sequence; honor reduced motion through `gsap.matchMedia()` if added.

## Release decision

Ship only when the focused UI suite, build, accessibility gates and Round 2 targeted verification pass. Legacy daemon/SSE specs must be removed or rewritten for the documented single-instance architecture before treating the repository-wide historical suite as a release gate.
