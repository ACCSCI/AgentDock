import { createContext, useCallback, useContext, useState } from "react";
import type { ReactNode } from "react";

interface UIState {
  activeProjectId: string | null;
  activeSessionId: string | null;
}

interface StoreContextValue extends UIState {
  setActiveProject: (projectId: string | null) => void;
  setActiveSession: (sessionId: string | null) => void;
}

const StoreContext = createContext<StoreContextValue | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<UIState>({
    activeProjectId: null,
    activeSessionId: null,
  });

  const setActiveProject = useCallback((projectId: string | null) => {
    setState((prev) => ({ ...prev, activeProjectId: projectId, activeSessionId: null }));
  }, []);

  const setActiveSession = useCallback((sessionId: string | null) => {
    setState((prev) => ({ ...prev, activeSessionId: sessionId }));
  }, []);

  return (
    <StoreContext.Provider
      value={{
        ...state,
        setActiveProject,
        setActiveSession,
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
