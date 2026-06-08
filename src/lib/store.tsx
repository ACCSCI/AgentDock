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
  activeTerminals: Map<string, string>; // sessionId → terminalId
}

interface StoreContextValue extends UIState {
  setActiveProject: (projectId: string | null) => void;
  setActiveSession: (sessionId: string | null) => void;
  setActiveTerminal: (sessionId: string, terminalId: string | null) => void;
  getActiveTerminal: (sessionId: string) => string | null;
  toggleSidebar: () => void;
}

const StoreContext = createContext<StoreContextValue | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<UIState>({
    activeProjectId: null,
    activeSessionId: null,
    sidebarCollapsed: false,
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

  return (
    <StoreContext.Provider
      value={{
        ...state,
        setActiveProject,
        setActiveSession,
        setActiveTerminal,
        getActiveTerminal,
        toggleSidebar,
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
