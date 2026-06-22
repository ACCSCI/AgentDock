/**
 * Test Fixtures — sample data used across tests.
 *
 * Phase 0: Scaffold. Phase 4 will populate with real project/session data
 * matching the existing plugins/db/schema.ts shape.
 */

import type { ProjectData, SessionData } from "../src/lib/queries.js";

export const sampleProject: ProjectData = {
  id: "test-project-1",
  name: "Test Project",
  path: "/tmp/test-project",
  createdAt: new Date().toISOString(),
  sessions: [],
};

export const sampleSession: SessionData = {
  id: "test-session-1",
  projectId: "test-project-1",
  name: "Test Session",
  branch: "agentdock/test-session-1",
  worktreePath: "/tmp/test-project/.agentdock/worktrees/test-session-1",
  ports: {
    FRONTEND_PORT: 40000,
    BACKEND_PORT: 40001,
    WS_PORT: 40002,
    DEBUG_PORT: 40003,
    PREVIEW_PORT: 40004,
  },
  createdAt: new Date().toISOString(),
  status: "existing",
  ownerClientId: "test-client",
  canSelect: true,
  canDelete: true,
  canReassign: true,
  canRename: true,
};

export function makeProjectWithSessions(count: number): ProjectData {
  return {
    ...sampleProject,
    sessions: Array.from({ length: count }, (_, i) => ({
      ...sampleSession,
      id: `test-session-${i + 1}`,
      name: `Test Session ${i + 1}`,
    })),
  };
}