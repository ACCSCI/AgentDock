/**
 * Renderer-side test IDs — mirror of e2e/pages/testids.ts.
 *
 * Two separate catalogs (src/lib/testids.ts and e2e/pages/testids.ts)
 * are intentional: e2e cannot import from src/ cleanly, and the renderer
 * shouldn't import from e2e/. The two files are kept in sync manually
 * (the catalog is small enough that drift is rare and easy to spot in
 * review).
 */
export const TID = {
  // Home
  homePage: "home-page",
  homeOpenProject: "home-open-project",

  // DirBrowserModal
  dirModal: "dir-modal",
  dirSearchInput: "dir-search-input",
  dirEntry: "dir-entry",
  dirCancel: "dir-cancel",
  dirConfirm: "dir-confirm",

  // TabBar
  tabBar: "tab-bar",
  projectTab: "project-tab",
  projectTabClose: "project-tab-close",
  newProject: "new-project",

  // SessionSidebar
  sessionSidebar: "session-sidebar",
  sessionCard: "session-card",
  newSession: "new-session",

  // TerminalManager / SessionTerminal
  terminalPanel: "terminal-panel",
  terminalTab: "terminal-tab",
  newTerminal: "new-terminal",
  terminalXterm: "terminal-xterm",
  sessionTerminal: "session-terminal",

  // IconSidebar
  iconSidebar: "icon-sidebar",
  copyCompatPrompt: "copy-compat-prompt",
  openSettings: "open-settings",

  // Settings page
  settingsPage: "settings-page",
} as const;
