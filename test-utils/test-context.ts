// @ts-nocheck
/**
 * Test Context — creates a mock Electron main process context.
 *
 * Phase 0: Scaffold. Provides the shape that real IPC handlers will
 * receive in Phase 4. Tests can construct one of these to invoke
 * IPC handlers in isolation.
 *
 * The mock context holds:
 *   - db:        test SQLite instance (Phase 4)
 *   - clientId:  stable identity per cwd
 *   - daemonClient: Hono typed client (Phase 2) or mock
 */

export interface TestContext {
  db: unknown;
  clientId: string;
  daemonClient: unknown;
  sessionStatuses: Map<string, "allocated" | "reclaimed">;
  reallocatedSessions: Array<{
    sessionId: string;
    oldPorts: Record<string, number>;
    newPorts: Record<string, number>;
  }>;
  lastScanTime: Map<string, number>;
}

export function makeMockContext(overrides: Partial<TestContext> = {}): TestContext {
  return {
    db: null, // Phase 4 will replace with createTestDb()
    clientId: "test-client",
    daemonClient: null, // Phase 2 will replace with hc<AppType>
    sessionStatuses: new Map(),
    reallocatedSessions: [],
    lastScanTime: new Map(),
    ...overrides,
  };
}