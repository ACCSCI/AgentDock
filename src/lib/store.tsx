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
  activeTerminalId: string | null;
}

interface StoreContextValue extends UIState {
  setActiveProject: (projectId: string | null) => void;
  setActiveSession: (sessionId: string | null) => void;
  setActiveTerminal: (terminalId: string | null) => void;
}

const StoreContext = createContext<StoreContextValue | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<UIState>({
    activeProjectId: null,
    activeSessionId: null,
    activeTerminalId: null,
  });

  const setActiveProject = useCallback((projectId: string | null) => {
    setState((prev) => ({ ...prev, activeProjectId: projectId, activeSessionId: null, activeTerminalId: null }));
  }, []);

  const setActiveSession = useCallback((sessionId: string | null) => {
    setState((prev) => ({ ...prev, activeSessionId: sessionId, activeTerminalId: null }));
  }, []);

  const setActiveTerminal = useCallback((terminalId: string | null) => {
    setState((prev) => ({ ...prev, activeTerminalId: terminalId }));
  }, []);

  return (
    <StoreContext.Provider
      value={{
        ...state,
        setActiveProject,
        setActiveSession,
        setActiveTerminal,
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
