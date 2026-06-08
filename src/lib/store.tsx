import { createContext, useCallback, useContext, useState } from "react";
import type { ReactNode } from "react";

export type TerminalStatus = "spawning" | "running" | "exited";

export interface TerminalInfo {
  terminalId: string;
  sessionId: string;
  shell: string;
  status: TerminalStatus;
  pid: number | null;
  createdAt: string;
}

interface UIState {
  activeProjectId: string | null;
  activeSessionId: string | null;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  activeTerminals: Map<string, string>; // sessionId → terminalId
}

interface StoreContextValue extends UIState {
  setActiveProject: (projectId: string | null) => void;
  setActiveSession: (sessionId: string | null) => void;
  setActiveTerminal: (sessionId: string, terminalId: string | null) => void;
  getActiveTerminal: (sessionId: string) => string | null;
  toggleSidebar: () => void;
  setSidebarWidth: (width: number) => void;
}

const SIDEBAR_WIDTH_KEY = "agentdock_sidebar_width";
const SIDEBAR_WIDTH_DEFAULT = 240;

function loadSidebarWidth(): number {
  try {
    const raw = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    if (raw !== null) {
      const v = Number(raw);
      if (Number.isFinite(v) && v >= 100 && v <= 600) return v;
    }
  } catch { /* localStorage unavailable */ }
  return SIDEBAR_WIDTH_DEFAULT;
}

const StoreContext = createContext<StoreContextValue | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<UIState>({
    activeProjectId: null,
    activeSessionId: null,
    sidebarCollapsed: false,
    sidebarWidth: loadSidebarWidth(),
    activeTerminals: new Map(),
  });

  const setActiveProject = useCallback((projectId: string | null) => {
    setState((prev) => ({ ...prev, activeProjectId: projectId, activeSessionId: null }));
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

  const getActiveTerminal = useCallback((sessionId: string): string | null => {
    return state.activeTerminals.get(sessionId) ?? null;
  }, [state.activeTerminals]);

  const toggleSidebar = useCallback(() => {
    setState((prev) => ({ ...prev, sidebarCollapsed: !prev.sidebarCollapsed }));
  }, []);

  const setSidebarWidth = useCallback((width: number) => {
    setState((prev) => ({ ...prev, sidebarWidth: width }));
    try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width)); } catch { /* localStorage full */ }
  }, []);

  return (
    <StoreContext.Provider
      value={{
        ...state,
        setActiveProject,
        setActiveSession,
        setActiveTerminal,
        getActiveTerminal,
        toggleSidebar,
        setSidebarWidth,
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
