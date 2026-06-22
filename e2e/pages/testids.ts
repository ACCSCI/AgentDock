/**
 * Test ID catalog — the single source of truth for `data-testid` strings
 * that the renderer exposes. Page Objects pull from here so a renamed
 * testid surfaces as a TypeScript error rather than a silent test fail.
 *
 * Pair with the additional `data-*` attributes documented in
 * `docs/e2e-guide.md`. When you add a testid in a React component, add
 * it here too.
 */
export const TID = {
  // Home
  homePage: "home-page",
  homeOpenProject: "home-open-project",

  // DirBrowserModal
  dirModal: "dir-modal",
  dirSearchInput: "dir-search-input",
  /** Pair with data-dir-path={entry.path}. */
  dirEntry: "dir-entry",
  dirCancel: "dir-cancel",
  dirConfirm: "dir-confirm",

  // TabBar
  tabBar: "tab-bar",
  /** Pair with data-project-id={project.id}. */
  projectTab: "project-tab",
  projectTabClose: "project-tab-close",
  newProject: "new-project",

  // SessionSidebar
  sessionSidebar: "session-sidebar",
  /** Pair with data-session-id={session.id}. */
  sessionCard: "session-card",
  newSession: "new-session",

  // TerminalManager / SessionTerminal
  terminalPanel: "terminal-panel",
  /** Pair with data-terminal-id={t.terminalId}. */
  terminalTab: "terminal-tab",
  newTerminal: "new-terminal",
  /** The xterm host. */
  terminalXterm: "terminal-xterm",
  /**
   * Pair with data-status: "connecting"|"connected"|"disconnected"|"error"|"exited".
   * This is the only reliable signal that the terminal rendered — xterm
   * paints to canvas and Playwright can't introspect it.
   */
  sessionTerminal: "session-terminal",

  // IconSidebar
  iconSidebar: "icon-sidebar",
  copyCompatPrompt: "copy-compat-prompt",

  // DaemonStatusBar (新架构 §2 + §11.1)
  daemonStatusBar: "daemon-status-bar",
  daemonState: "daemon-state",
  daemonPid: "daemon-pid",
  daemonPort: "daemon-port",
  daemonProtocol: "daemon-protocol",
  daemonCapabilities: "daemon-capabilities",
  daemonError: "daemon-error",
} as const;

export type Testid = (typeof TID)[keyof typeof TID];
