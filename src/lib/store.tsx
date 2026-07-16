import { createContext, useCallback, useContext, useState } from "react";
import type { ReactNode } from "react";

export type TerminalStatus = "spawning" | "running" | "exited";

export type TerminalDefaultAction = "terminal" | "claude" | "copilot";

export const TERMINAL_FONT_SIZES = [10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24] as const;
export type TerminalFontSize = (typeof TERMINAL_FONT_SIZES)[number];

export const TERMINAL_FONT_FAMILIES = [
  { label: "Maple Mono", value: "'Maple Mono', monospace" },
  { label: "Cascadia Code", value: "'Cascadia Code', monospace" },
  { label: "Fira Code", value: "'Fira Code', monospace" },
  { label: "JetBrains Mono", value: "'JetBrains Mono', monospace" },
  { label: "Consolas", value: "'Consolas', monospace" },
  { label: "monospace", value: "monospace" },
] as const;

export interface TerminalPreferences {
  fontSize: TerminalFontSize;
  fontFamily: string;
}

export const DEFAULT_TERMINAL_PREFS: TerminalPreferences = {
  fontSize: 14,
  fontFamily: "'Maple Mono', monospace",
};

export interface TerminalInfo {
  terminalId: string;
  sessionId: string;
  shell: string;
  status: TerminalStatus;
  pid: number | null;
  createdAt: string;
}

/** Identifies a user-configurable shortcut action. Add new actions here as features need them. */
export type ShortcutAction = "dirSearchFocus";

/** A single key combo string, e.g. "Alt+d" or "Ctrl+Shift+k". */
export type KeyBinding = string;

export interface ShortcutMap {
  dirSearchFocus: KeyBinding[];
}

export const DEFAULT_SHORTCUTS: ShortcutMap = {
  dirSearchFocus: ["Alt+d"],
};

/** Hard cap on bindings per action. UI enforces this too; it's here for input validation. */
export const MAX_BINDINGS_PER_ACTION = 2;

interface UIState {
  activeProjectId: string | null;
  activeSessionId: string | null;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  closedProjectIds: string[];
  activeTerminals: Map<string, string>; // sessionId → terminalId
  terminalDefaultAction: TerminalDefaultAction;
  terminalPrefs: TerminalPreferences;
  shortcuts: ShortcutMap;
}

interface StoreContextValue extends UIState {
  setActiveProject: (projectId: string | null) => void;
  setActiveSession: (sessionId: string | null) => void;
  closeProject: (projectId: string) => void;
  reopenProject: (projectId: string) => void;
  setActiveTerminal: (sessionId: string, terminalId: string | null) => void;
  getActiveTerminal: (sessionId: string) => string | null;
  toggleSidebar: () => void;
  setSidebarWidth: (width: number) => void;
  setTerminalDefaultAction: (action: TerminalDefaultAction) => void;
  setTerminalPrefs: (prefs: TerminalPreferences) => void;
  updateShortcut: (action: ShortcutAction, bindings: KeyBinding[]) => void;
  resetShortcuts: () => void;
}

const SIDEBAR_WIDTH_KEY = "agentdock_sidebar_width";
const SIDEBAR_WIDTH_DEFAULT = 240;
export const SIDEBAR_MIN_WIDTH = 140;
export const SIDEBAR_MAX_WIDTH = 600;

function loadSidebarWidth(): number {
  try {
    const raw = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    if (raw !== null) {
      const v = Number(raw);
      if (Number.isFinite(v) && v >= SIDEBAR_MIN_WIDTH && v <= SIDEBAR_MAX_WIDTH) return v;
    }
  } catch {
    /* localStorage unavailable */
  }
  return SIDEBAR_WIDTH_DEFAULT;
}

const CLOSED_PROJECTS_KEY = "agentdock_closed_projects";

function loadClosedProjects(): string[] {
  try {
    const raw = localStorage.getItem(CLOSED_PROJECTS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveClosedProjects(ids: string[]) {
  try {
    localStorage.setItem(CLOSED_PROJECTS_KEY, JSON.stringify(ids));
  } catch {
    /* localStorage full or unavailable */
  }
}

const TERMINAL_DEFAULT_ACTION_KEY = "agentdock_terminal_default_action";

function loadTerminalDefaultAction(): TerminalDefaultAction {
  try {
    const raw = localStorage.getItem(TERMINAL_DEFAULT_ACTION_KEY);
    if (raw === "terminal" || raw === "claude" || raw === "copilot") return raw;
  } catch {
    /* ignore */
  }
  return "terminal";
}

const TERMINAL_PREFS_KEY = "agentdock_terminal_prefs";

function loadTerminalPrefs(): TerminalPreferences {
  try {
    const raw = localStorage.getItem(TERMINAL_PREFS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<TerminalPreferences>;
      const fontSize =
        typeof parsed.fontSize === "number" &&
        TERMINAL_FONT_SIZES.includes(parsed.fontSize as TerminalFontSize)
          ? (parsed.fontSize as TerminalFontSize)
          : DEFAULT_TERMINAL_PREFS.fontSize;
      const fontFamily =
        typeof parsed.fontFamily === "string" && parsed.fontFamily
          ? parsed.fontFamily
          : DEFAULT_TERMINAL_PREFS.fontFamily;
      return { fontSize, fontFamily };
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_TERMINAL_PREFS;
}

const SHORTCUTS_KEY = "agentdock_shortcuts";

function loadShortcuts(): ShortcutMap {
  try {
    const raw = localStorage.getItem(SHORTCUTS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        const dirSearchFocus = Array.isArray(parsed.dirSearchFocus)
          ? (parsed.dirSearchFocus as unknown[]).filter(
              (s): s is KeyBinding => typeof s === "string",
            )
          : DEFAULT_SHORTCUTS.dirSearchFocus;
        return { dirSearchFocus };
      }
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_SHORTCUTS;
}

function saveShortcuts(map: ShortcutMap) {
  try {
    localStorage.setItem(SHORTCUTS_KEY, JSON.stringify(map));
  } catch {
    /* localStorage full or unavailable */
  }
}

const StoreContext = createContext<StoreContextValue | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<UIState>({
    activeProjectId: null,
    activeSessionId: null,
    sidebarCollapsed: false,
    sidebarWidth: loadSidebarWidth(),
    closedProjectIds: loadClosedProjects(),
    activeTerminals: new Map(),
    terminalDefaultAction: loadTerminalDefaultAction(),
    terminalPrefs: loadTerminalPrefs(),
    shortcuts: loadShortcuts(),
  });

  const setActiveProject = useCallback((projectId: string | null) => {
    setState((prev) => {
      const closedProjectIds = projectId
        ? prev.closedProjectIds.filter((id) => id !== projectId)
        : prev.closedProjectIds;
      if (projectId) saveClosedProjects(closedProjectIds);
      return { ...prev, activeProjectId: projectId, activeSessionId: null, closedProjectIds };
    });
  }, []);

  const closeProject = useCallback((projectId: string) => {
    setState((prev) => {
      const closedProjectIds = prev.closedProjectIds.includes(projectId)
        ? prev.closedProjectIds
        : [...prev.closedProjectIds, projectId];
      saveClosedProjects(closedProjectIds);
      return {
        ...prev,
        activeProjectId: prev.activeProjectId === projectId ? null : prev.activeProjectId,
        closedProjectIds,
      };
    });
  }, []);

  const reopenProject = useCallback((projectId: string) => {
    setState((prev) => {
      const closedProjectIds = prev.closedProjectIds.filter((id) => id !== projectId);
      saveClosedProjects(closedProjectIds);
      return { ...prev, closedProjectIds };
    });
  }, []);

  const setActiveSession = useCallback((sessionId: string | null) => {
    setState((prev) => ({ ...prev, activeSessionId: sessionId }));
  }, []);

  const setActiveTerminal = useCallback((sessionId: string, terminalId: string | null) => {
    setState((prev) => {
      const next = new Map(prev.activeTerminals);
      if (terminalId === null) {
        next.delete(sessionId);
      } else {
        next.set(sessionId, terminalId);
      }
      return { ...prev, activeTerminals: next };
    });
  }, []);

  const getActiveTerminal = useCallback(
    (sessionId: string): string | null => {
      return state.activeTerminals.get(sessionId) ?? null;
    },
    [state.activeTerminals],
  );

  const toggleSidebar = useCallback(() => {
    setState((prev) => ({ ...prev, sidebarCollapsed: !prev.sidebarCollapsed }));
  }, []);

  const setSidebarWidth = useCallback((width: number) => {
    setState((prev) => ({ ...prev, sidebarWidth: width }));
    try {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
    } catch {
      /* localStorage full */
    }
  }, []);

  const setTerminalDefaultAction = useCallback((action: TerminalDefaultAction) => {
    setState((prev) => ({ ...prev, terminalDefaultAction: action }));
    try {
      localStorage.setItem(TERMINAL_DEFAULT_ACTION_KEY, action);
    } catch {
      /* ignore */
    }
  }, []);

  const setTerminalPrefs = useCallback((prefs: TerminalPreferences) => {
    setState((prev) => ({ ...prev, terminalPrefs: prefs }));
    try {
      localStorage.setItem(TERMINAL_PREFS_KEY, JSON.stringify(prefs));
    } catch {
      /* ignore */
    }
  }, []);

  const updateShortcut = useCallback((action: ShortcutAction, bindings: KeyBinding[]) => {
    // Normalize: dedupe + cap to MAX_BINDINGS_PER_ACTION. Trims empty strings.
    const cleaned = Array.from(
      new Set(bindings.map((b) => b.trim()).filter((b) => b.length > 0)),
    ).slice(0, MAX_BINDINGS_PER_ACTION);
    setState((prev) => {
      const next: ShortcutMap = { ...prev.shortcuts, [action]: cleaned };
      saveShortcuts(next);
      return { ...prev, shortcuts: next };
    });
  }, []);

  const resetShortcuts = useCallback(() => {
    setState((prev) => {
      saveShortcuts(DEFAULT_SHORTCUTS);
      return { ...prev, shortcuts: DEFAULT_SHORTCUTS };
    });
  }, []);

  return (
    <StoreContext.Provider
      value={{
        ...state,
        setActiveProject,
        setActiveSession,
        closeProject,
        reopenProject,
        setActiveTerminal,
        getActiveTerminal,
        toggleSidebar,
        setSidebarWidth,
        setTerminalDefaultAction,
        setTerminalPrefs,
        updateShortcut,
        resetShortcuts,
      }}
    >
      {children}
    </StoreContext.Provider>
  );
}

export function useStore(): StoreContextValue {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore must be used within StoreProvider");
  return ctx;
}
