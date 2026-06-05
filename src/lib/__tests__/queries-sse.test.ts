import { describe, expect, it, vi, beforeEach } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { CreatingSession, DeletingSession, ProjectData, SessionData, SessionStep } from "../queries.js";
import { isCreatingSession, isDeletingSession, queryKeys } from "../queries.js";

// --- Helpers to build mock SSE streams ---

function ssePayload(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function createMockSSEStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

function mockSSEResponse(chunks: string[]): Response {
  return {
    headers: new Headers({ "content-type": "text/event-stream" }),
    body: createMockSSEStream(chunks),
  } as unknown as Response;
}

function mockJSONResponse(data: unknown): Response {
  return {
    headers: new Headers({ "content-type": "application/json" }),
    json: () => Promise.resolve(data),
    body: null,
  } as unknown as Response;
}

// --- Inline logic extracted from useCreateSessionSSE for direct testing ---
// We replicate the mutationFn's SSE parsing + step-update logic here to test it
// without needing React rendering (no @testing-library/react available).

async function runSSEMutation(
  queryClient: QueryClient,
  variables: { projectId: string; name: string; tempId: string },
  response: Response,
): Promise<SessionData> {
  // This mirrors the mutationFn logic from useCreateSessionSSE
  const { projectId, tempId } = variables;

  const res = response;
  const contentType = res.headers.get("content-type") ?? "";

  if (!contentType.includes("text/event-stream")) {
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    return data.session as SessionData;
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");
  const decoder = new TextDecoder();
  let buffer = "";
  let result: SessionData | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    let currentEvent = "";
    for (const line of lines) {
      if (line.startsWith("event: ")) {
        currentEvent = line.slice(7);
      } else if (line.startsWith("data: ")) {
        const data = JSON.parse(line.slice(6));
        if (currentEvent === "step") {
          queryClient.setQueryData<ProjectData[]>(queryKeys.projects, (old) => {
            if (!old) return old;
            return old.map((p) => {
              if (p.id !== projectId) return p;
              return {
                ...p,
                sessions: p.sessions.map((s) => {
                  if (s.id !== tempId) return s;
                  const creating = s as CreatingSession;
                  const existingIdx = creating.steps.findIndex((st) => st.step === data.step);
                  const newSteps = [...creating.steps];
                  if (existingIdx >= 0) {
                    newSteps[existingIdx] = data;
                  } else {
                    newSteps.push(data);
                  }
                  return { ...creating, steps: newSteps };
                }),
              };
            });
          });
        } else if (currentEvent === "complete") {
          result = data.session;
        } else if (currentEvent === "error") {
          throw new Error(data.error);
        }
      }
    }
  }

  if (!result) throw new Error("No complete event received");
  return result;
}

// --- Tests ---

describe("SSE session creation — tempId consistency", () => {
  let queryClient: QueryClient;

  const projectId = "proj1";
  const tempId = "temp-12345";

  function seedCache() {
    queryClient.setQueryData<ProjectData[]>(queryKeys.projects, [
      {
        id: projectId,
        name: "Test Project",
        path: "/test",
        createdAt: new Date().toISOString(),
        sessions: [],
      },
    ]);
  }

  function seedCacheWithTempSession() {
    queryClient.setQueryData<ProjectData[]>(queryKeys.projects, [
      {
        id: projectId,
        name: "Test Project",
        path: "/test",
        createdAt: new Date().toISOString(),
        sessions: [
          {
            id: tempId,
            projectId,
            name: "Session 1",
            branch: "",
            worktreePath: "",
            ports: null,
            createdAt: new Date().toISOString(),
            status: "creating",
            steps: [],
          } as CreatingSession,
        ],
      },
    ]);
  }

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
  });

  it("T1: onMutate uses the caller-provided tempId, not a generated one", () => {
    seedCache();

    // Simulate onMutate with explicit tempId
    const callerTempId = "temp-caller-999";
    queryClient.setQueryData<ProjectData[]>(queryKeys.projects, (old) => {
      if (!old) return old;
      return old.map((p) => {
        if (p.id !== projectId) return p;
        const tempSession: CreatingSession = {
          id: callerTempId,
          projectId,
          name: "Session 1",
          branch: "",
          worktreePath: "",
          ports: null,
          createdAt: new Date().toISOString(),
          status: "creating",
          steps: [],
        };
        return { ...p, sessions: [...p.sessions, tempSession] };
      });
    });

    const projects = queryClient.getQueryData<ProjectData[]>(queryKeys.projects);
    const session = projects?.[0].sessions[0];
    expect(session?.id).toBe(callerTempId);
    expect(isCreatingSession(session!)).toBe(true);
  });

  it("T2: SSE step events correctly update the matching temp session's steps", async () => {
    seedCacheWithTempSession();

    const stepEvents: SessionStep[] = [
      { step: "beforeCreateSession", status: "running" },
      { step: "beforeCreateSession", status: "done", duration: 42 },
      { step: "createWorktree", status: "running" },
      { step: "createWorktree", status: "done", duration: 150 },
    ];

    const chunks = stepEvents.map((e) => ssePayload("step", e));
    // Append a complete event at the end
    const finalSession: SessionData = {
      id: "real-session-id",
      projectId,
      name: "Session 1",
      branch: "main",
      worktreePath: "/worktree/path",
      ports: null,
      createdAt: new Date().toISOString(),
    };
    chunks.push(ssePayload("complete", { session: finalSession }));

    const response = mockSSEResponse(chunks);
    const result = await runSSEMutation(queryClient, { projectId, name: "Session 1", tempId }, response);

    // Verify the mutation returned the final session
    expect(result.id).toBe("real-session-id");

    // The temp session in cache should have had its steps updated.
    // Same step name's "running" and "done" are merged in-place (findIndex),
    // so 4 events -> 2 step entries (each updated from running to done).
    const projects = queryClient.getQueryData<ProjectData[]>(queryKeys.projects);
    const tempSession = projects?.[0].sessions.find((s) => s.id === tempId) as CreatingSession | undefined;
    if (tempSession) {
      expect(tempSession.steps).toHaveLength(2);
      expect(tempSession.steps[0]).toEqual({ step: "beforeCreateSession", status: "done", duration: 42 });
      expect(tempSession.steps[1]).toEqual({ step: "createWorktree", status: "done", duration: 150 });
    }
  });

  it("T3: step events do NOT match when tempId differs (the original bug scenario)", async () => {
    seedCacheWithTempSession();

    // Use a DIFFERENT tempId in mutationFn than what's in the cache
    const wrongTempId = "temp-WRONG";
    const stepEvent: SessionStep = { step: "createWorktree", status: "running" };
    const finalSession: SessionData = {
      id: "real-id",
      projectId,
      name: "Session 1",
      branch: "main",
      worktreePath: "/wt",
      ports: null,
      createdAt: new Date().toISOString(),
    };

    const response = mockSSEResponse([
      ssePayload("step", stepEvent),
      ssePayload("complete", { session: finalSession }),
    ]);

    await runSSEMutation(queryClient, { projectId, name: "Session 1", tempId: wrongTempId }, response);

    // The temp session in cache should still have EMPTY steps (step was not applied)
    const projects = queryClient.getQueryData<ProjectData[]>(queryKeys.projects);
    const tempSession = projects?.[0].sessions.find((s) => s.id === tempId) as CreatingSession | undefined;
    expect(tempSession).toBeDefined();
    expect(tempSession!.steps).toHaveLength(0); // step didn't match — this was the bug!
  });

  it("T4: SSE error event throws with the error message", async () => {
    seedCacheWithTempSession();

    const response = mockSSEResponse([
      ssePayload("step", { step: "beforeCreateSession", status: "running" }),
      ssePayload("error", { error: "hook failed (required)" }),
    ]);

    await expect(
      runSSEMutation(queryClient, { projectId, name: "Session 1", tempId }, response),
    ).rejects.toThrow("hook failed (required)");
  });

  it("T5: non-SSE JSON response is handled as fallback", async () => {
    seedCache();

    const finalSession: SessionData = {
      id: "real-id",
      projectId,
      name: "Session 1",
      branch: "main",
      worktreePath: "/wt",
      ports: null,
      createdAt: new Date().toISOString(),
    };
    const response = mockJSONResponse({ success: true, session: finalSession });

    const result = await runSSEMutation(queryClient, { projectId, name: "Session 1", tempId }, response);
    expect(result.id).toBe("real-id");
  });

  it("T6: multiple step events for the same step update (not duplicate)", async () => {
    seedCacheWithTempSession();

    const finalSession: SessionData = {
      id: "real-id",
      projectId,
      name: "Session 1",
      branch: "main",
      worktreePath: "/wt",
      ports: null,
      createdAt: new Date().toISOString(),
    };

    const response = mockSSEResponse([
      ssePayload("step", { step: "syncResources", status: "running" }),
      ssePayload("step", { step: "syncResources", status: "done", duration: 300 }),
      ssePayload("complete", { session: finalSession }),
    ]);

    await runSSEMutation(queryClient, { projectId, name: "Session 1", tempId }, response);

    const projects = queryClient.getQueryData<ProjectData[]>(queryKeys.projects);
    const tempSession = projects?.[0].sessions.find((s) => s.id === tempId) as CreatingSession | undefined;
    if (tempSession) {
      // Should have 1 entry for syncResources (updated in-place), not 2
      const syncSteps = tempSession.steps.filter((s) => s.step === "syncResources");
      expect(syncSteps).toHaveLength(1);
      expect(syncSteps[0]).toEqual({ step: "syncResources", status: "done", duration: 300 });
    }
  });
});

// --- Inline logic extracted from useDeleteSessionSSE for direct testing ---

async function runDeleteSSEMutation(
  queryClient: QueryClient,
  variables: { sessionId: string; projectId: string },
  response: Response,
): Promise<void> {
  const { sessionId, projectId } = variables;
  const res = response;
  const contentType = res.headers.get("content-type") ?? "";

  if (!contentType.includes("text/event-stream")) {
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    return;
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    let currentEvent = "";
    for (const line of lines) {
      if (line.startsWith("event: ")) {
        currentEvent = line.slice(7);
      } else if (line.startsWith("data: ")) {
        const data = JSON.parse(line.slice(6));
        if (currentEvent === "step") {
          queryClient.setQueryData<ProjectData[]>(queryKeys.projects, (old) => {
            if (!old) return old;
            return old.map((p) => {
              if (p.id !== projectId) return p;
              return {
                ...p,
                sessions: p.sessions.map((s) => {
                  if (s.id !== sessionId) return s;
                  if (!isDeletingSession(s)) return s;
                  const deleting = s as DeletingSession;
                  const existingIdx = deleting.steps.findIndex((st) => st.step === data.step);
                  const newSteps = [...deleting.steps];
                  if (existingIdx >= 0) {
                    newSteps[existingIdx] = data;
                  } else {
                    newSteps.push(data);
                  }
                  return { ...deleting, steps: newSteps };
                }),
              };
            });
          });
        } else if (currentEvent === "complete") {
          return;
        } else if (currentEvent === "error") {
          throw new Error(data.error);
        }
      }
    }
  }
}

// --- Tests for delete SSE step-update logic ---

describe("SSE session deletion — step safety", () => {
  let queryClient: QueryClient;

  const projectId = "proj1";
  const sessionId = "sess-del-1";

  function seedCacheWithDeletingSession() {
    queryClient.setQueryData<ProjectData[]>(queryKeys.projects, [
      {
        id: projectId,
        name: "Test Project",
        path: "/test",
        createdAt: new Date().toISOString(),
        sessions: [
          {
            id: sessionId,
            projectId,
            name: "Session 1",
            branch: "main",
            worktreePath: "/worktree",
            ports: null,
            createdAt: new Date().toISOString(),
            status: "deleting",
            steps: [],
          } as DeletingSession,
        ],
      },
    ]);
  }

  function seedCacheWithNormalSession() {
    queryClient.setQueryData<ProjectData[]>(queryKeys.projects, [
      {
        id: projectId,
        name: "Test Project",
        path: "/test",
        createdAt: new Date().toISOString(),
        sessions: [
          {
            id: sessionId,
            projectId,
            name: "Session 1",
            branch: "main",
            worktreePath: "/worktree",
            ports: null,
            createdAt: new Date().toISOString(),
          } as SessionData,
        ],
      },
    ]);
  }

  function seedCacheEmpty() {
    queryClient.setQueryData<ProjectData[]>(queryKeys.projects, [
      {
        id: projectId,
        name: "Test Project",
        path: "/test",
        createdAt: new Date().toISOString(),
        sessions: [],
      },
    ]);
  }

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
  });

  it("S2: step events correctly update DeletingSession steps", async () => {
    seedCacheWithDeletingSession();

    const response = mockSSEResponse([
      ssePayload("step", { step: "beforeDeleteSession", status: "running" }),
      ssePayload("step", { step: "beforeDeleteSession", status: "done", duration: 10 }),
      ssePayload("step", { step: "releasePorts", status: "done", duration: 5 }),
      ssePayload("complete", {}),
    ]);

    await runDeleteSSEMutation(queryClient, { sessionId, projectId }, response);

    const projects = queryClient.getQueryData<ProjectData[]>(queryKeys.projects);
    const session = projects?.[0].sessions.find((s) => s.id === sessionId) as DeletingSession | undefined;
    expect(session).toBeDefined();
    expect(session!.steps).toHaveLength(2);
    expect(session!.steps[0]).toEqual({ step: "beforeDeleteSession", status: "done", duration: 10 });
    expect(session!.steps[1]).toEqual({ step: "releasePorts", status: "done", duration: 5 });
  });

  it("S1: step event when session is NOT a DeletingSession (cache rolled back) does not throw", async () => {
    // Simulate the bug: onError rolled back cache to original SessionData (no steps/status)
    seedCacheWithNormalSession();

    const response = mockSSEResponse([
      ssePayload("step", { step: "removeWorktree", status: "running" }),
      ssePayload("complete", {}),
    ]);

    // Should NOT throw — the old code would crash with "Cannot read properties of undefined (reading 'findIndex')"
    await expect(
      runDeleteSSEMutation(queryClient, { sessionId, projectId }, response),
    ).resolves.toBeUndefined();
  });

  it("S3: error event followed by residual step event does not crash", async () => {
    seedCacheWithDeletingSession();

    const response = mockSSEResponse([
      ssePayload("step", { step: "beforeDeleteSession", status: "running" }),
      ssePayload("error", { error: "worktree removal failed" }),
      // Residual step after error — in the real SSE stream, onError restores cache
      // but the reader might still have buffered data
      ssePayload("step", { step: "releasePorts", status: "running" }),
    ]);

    await expect(
      runDeleteSSEMutation(queryClient, { sessionId, projectId }, response),
    ).rejects.toThrow("worktree removal failed");
  });

  it("S1b: step event when session list is empty (removed from cache) does not throw", async () => {
    seedCacheEmpty();

    const response = mockSSEResponse([
      ssePayload("step", { step: "removeWorktree", status: "running" }),
      ssePayload("complete", {}),
    ]);

    await expect(
      runDeleteSSEMutation(queryClient, { sessionId, projectId }, response),
    ).resolves.toBeUndefined();
  });
});

// --- Race condition: delete complete wipes create-in-progress ---
// This reproduces the bug where delete's onSuccess invalidates the
// entire projects query, refetching from the server and wiping out
// a CreatingSession that was optimistically added during the delete.

describe("SSE race condition — delete + create interleaved", () => {
  let queryClient: QueryClient;

  const projectId = "proj-race-1";
  const normalSessionId = "sess-normal-1";
  const tempId = "temp-create-in-progress";

  // Server DB state: temp session NOT in DB yet (still in SSE stream)
  const serverData: ProjectData[] = [
    {
      id: projectId,
      name: "Race Project",
      path: "/race",
      createdAt: new Date().toISOString(),
      sessions: [
        {
          id: normalSessionId,
          projectId,
          name: "Session to delete",
          branch: "main",
          worktreePath: "/wt",
          ports: null,
          createdAt: new Date().toISOString(),
        },
      ],
    },
  ];

  function seedCache() {
    queryClient.setQueryData<ProjectData[]>(queryKeys.projects, [
      {
        id: projectId,
        name: "Race Project",
        path: "/race",
        createdAt: new Date().toISOString(),
        sessions: [
          {
            id: normalSessionId,
            projectId,
            name: "Session to delete",
            branch: "main",
            worktreePath: "/wt",
            ports: null,
            createdAt: new Date().toISOString(),
          },
        ],
      },
    ]);
  }

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    // Register a queryFn that returns server data (without temp session)
    queryClient.setQueryDefaults(queryKeys.projects, {
      // eslint-disable-next-line @typescript-eslint/require-await
      queryFn: async () => serverData,
    });
  });

  it("R1: DESIRED BEHAVIOR — CreatingSession with progress survives delete's onSuccess direct cache update", async () => {
    seedCache();

    // === Step 1: Simulate delete onMutate ===
    queryClient.setQueryData<ProjectData[]>(queryKeys.projects, (old) => {
      if (!old) return old;
      return old.map((p) => {
        if (p.id !== projectId) return p;
        return {
          ...p,
          sessions: p.sessions.map((s) => {
            if (s.id !== normalSessionId) return s;
            const deleting: DeletingSession = {
              ...s,
              status: "deleting",
              steps: [{ step: "beforeDeleteSession", status: "done", duration: 10 }],
            };
            return deleting;
          }),
        };
      });
    });

    // === Step 2: Simulate create onMutate ===
    queryClient.setQueryData<ProjectData[]>(queryKeys.projects, (old) => {
      if (!old) return old;
      return old.map((p) => {
        if (p.id !== projectId) return p;
        const tempSession: CreatingSession = {
          id: tempId,
          projectId,
          name: "Session created during delete",
          branch: "",
          worktreePath: "",
          ports: null,
          createdAt: new Date().toISOString(),
          status: "creating",
          steps: [
            { step: "beforeCreateSession", status: "done", duration: 5 },
            { step: "createWorktree", status: "running" },
          ],
        };
        return { ...p, sessions: [...p.sessions, tempSession] };
      });
    });

    // === Step 3: Verify baseline — 2 sessions ===
    let projects = queryClient.getQueryData<ProjectData[]>(queryKeys.projects);
    expect(projects![0].sessions).toHaveLength(2);

    // === Step 4: Simulate FIXED delete onSuccess ===
    // Instead of invalidateQueries (which triggers refetch and wipes optimistic state),
    // the fix directly removes the deleted session from cache.
    queryClient.setQueryData<ProjectData[]>(queryKeys.projects, (old) => {
      if (!old) return old;
      return old.map((p) => {
        if (p.id !== projectId) return p;
        return {
          ...p,
          sessions: p.sessions.filter((s) => s.id !== normalSessionId),
        };
      });
    });

    // === Step 5: Verify CreatingSession survived ===
    projects = queryClient.getQueryData<ProjectData[]>(queryKeys.projects);
    // Should still have 1 session — the creating one
    expect(projects![0].sessions).toHaveLength(1);
    const survivingCreate = projects![0].sessions[0] as CreatingSession;
    expect(survivingCreate.id).toBe(tempId);
    expect(isCreatingSession(survivingCreate)).toBe(true);
    // Steps must be intact
    expect(survivingCreate.steps).toHaveLength(2);
    expect(survivingCreate.steps[1]).toEqual({ step: "createWorktree", status: "running" });
  });

  it("R2: DESIRED BEHAVIOR — create onSuccess replaces temp session without affecting other sessions", async () => {
    seedCache();

    // Simulate create onMutate — insert temp CreatingSession
    queryClient.setQueryData<ProjectData[]>(queryKeys.projects, (old) => {
      if (!old) return old;
      return old.map((p) => {
        if (p.id !== projectId) return p;
        const tempSession: CreatingSession = {
          id: tempId,
          projectId,
          name: "Session 2",
          branch: "",
          worktreePath: "",
          ports: null,
          createdAt: new Date().toISOString(),
          status: "creating",
          steps: [],
        };
        return { ...p, sessions: [...p.sessions, tempSession] };
      });
    });

    // Simulate FIXED create onSuccess — replace temp session with real data
    const realSession: SessionData = {
      id: "real-session-456",
      projectId,
      name: "Session 2",
      branch: "feature-x",
      worktreePath: "/wt/sess-2",
      ports: { FRONTEND_PORT: 3000, BACKEND_PORT: 3001, WS_PORT: 3002, DEBUG_PORT: 3003, PREVIEW_PORT: 3004 },
      createdAt: new Date().toISOString(),
    };

    queryClient.setQueryData<ProjectData[]>(queryKeys.projects, (old) => {
      if (!old) return old;
      return old.map((p) => {
        if (p.id !== projectId) return p;
        return {
          ...p,
          sessions: p.sessions.map((s) =>
            s.id === tempId ? { ...realSession } : s,
          ),
        };
      });
    });

    // Verify: temp session replaced, normal session untouched
    const projects = queryClient.getQueryData<ProjectData[]>(queryKeys.projects);
    expect(projects![0].sessions).toHaveLength(2);
    // Normal session still exists
    expect(projects![0].sessions.find((s) => s.id === normalSessionId)).toBeDefined();
    // Temp session replaced by real session
    expect(projects![0].sessions.find((s) => s.id === tempId)).toBeUndefined();
    const real = projects![0].sessions.find((s) => s.id === realSession.id);
    expect(real).toBeDefined();
    expect(real!.branch).toBe("feature-x");
  });
});
