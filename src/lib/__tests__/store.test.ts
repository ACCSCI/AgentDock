import { describe, expect, it } from "vitest";

// --- Inline store logic for direct testing ---
// We replicate the state management logic here to test it
// without needing React rendering.

interface UIState {
  activeProjectId: string | null;
  activeSessionId: string | null;
  sidebarCollapsed: boolean;
  activeTerminals: Map<string, string>;
}

function createInitialState(): UIState {
  return {
    activeProjectId: null,
    activeSessionId: null,
    sidebarCollapsed: false,
    activeTerminals: new Map(),
  };
}

function setActiveProject(state: UIState, projectId: string | null): UIState {
  return { ...state, activeProjectId: projectId, activeSessionId: null };
}

function toggleProject(state: UIState, projectId: string): UIState {
  if (state.activeProjectId === projectId) {
    // Clicking active project again → deactivate
    return { ...state, activeProjectId: null, activeSessionId: null };
  }
  // Clicking a different project → activate it
  return { ...state, activeProjectId: projectId, activeSessionId: null };
}

function setActiveSession(state: UIState, sessionId: string | null): UIState {
  return { ...state, activeSessionId: sessionId };
}

function toggleSidebar(state: UIState): UIState {
  return { ...state, sidebarCollapsed: !state.sidebarCollapsed };
}

function collapseSidebar(state: UIState): UIState {
  return { ...state, sidebarCollapsed: true };
}

function expandSidebar(state: UIState): UIState {
  return { ...state, sidebarCollapsed: false };
}

// --- Tests ---

describe("Store — project toggle", () => {
  it("T1: initial state has no active project", () => {
    const state = createInitialState();
    expect(state.activeProjectId).toBeNull();
    expect(state.activeSessionId).toBeNull();
  });

  it("T2: clicking a project activates it", () => {
    const state = createInitialState();
    const next = toggleProject(state, "proj-1");
    expect(next.activeProjectId).toBe("proj-1");
    expect(next.activeSessionId).toBeNull();
  });

  it("T3: clicking the same project again deactivates it", () => {
    const state = createInitialState();
    const activated = toggleProject(state, "proj-1");
    expect(activated.activeProjectId).toBe("proj-1");

    const deactivated = toggleProject(activated, "proj-1");
    expect(deactivated.activeProjectId).toBeNull();
    expect(deactivated.activeSessionId).toBeNull();
  });

  it("T4: clicking a different project switches active project", () => {
    const state = createInitialState();
    const activated = toggleProject(state, "proj-1");
    const switched = toggleProject(activated, "proj-2");
    expect(switched.activeProjectId).toBe("proj-2");
    expect(switched.activeSessionId).toBeNull();
  });

  it("T5: deactivating project also clears active session", () => {
    let state = createInitialState();
    state = toggleProject(state, "proj-1");
    state = setActiveSession(state, "sess-1");
    expect(state.activeSessionId).toBe("sess-1");

    state = toggleProject(state, "proj-1");
    expect(state.activeProjectId).toBeNull();
    expect(state.activeSessionId).toBeNull();
  });

  it("T6: setActiveProject(null) clears project and session", () => {
    let state = createInitialState();
    state = toggleProject(state, "proj-1");
    state = setActiveSession(state, "sess-1");

    state = setActiveProject(state, null);
    expect(state.activeProjectId).toBeNull();
    expect(state.activeSessionId).toBeNull();
  });
});

describe("Store — sidebar collapse", () => {
  it("S1: initial state sidebar is not collapsed", () => {
    const state = createInitialState();
    expect(state.sidebarCollapsed).toBe(false);
  });

  it("S2: toggleSidebar flips collapsed state", () => {
    const state = createInitialState();
    const collapsed = toggleSidebar(state);
    expect(collapsed.sidebarCollapsed).toBe(true);

    const expanded = toggleSidebar(collapsed);
    expect(expanded.sidebarCollapsed).toBe(false);
  });

  it("S3: collapseSidebar sets collapsed to true", () => {
    const state = createInitialState();
    const collapsed = collapseSidebar(state);
    expect(collapsed.sidebarCollapsed).toBe(true);
  });

  it("S4: expandSidebar sets collapsed to false", () => {
    const state = createInitialState();
    const collapsed = collapseSidebar(state);
    const expanded = expandSidebar(collapsed);
    expect(expanded.sidebarCollapsed).toBe(false);
  });

  it("S5: collapse is idempotent", () => {
    const state = createInitialState();
    const c1 = collapseSidebar(state);
    const c2 = collapseSidebar(c1);
    expect(c2.sidebarCollapsed).toBe(true);
  });

  it("S6: expand is idempotent", () => {
    const state = createInitialState();
    const e1 = expandSidebar(state);
    const e2 = expandSidebar(e1);
    expect(e2.sidebarCollapsed).toBe(false);
  });
});
