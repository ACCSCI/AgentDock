// @ts-nocheck
/**
 * Acceptance test helpers.
 *
 * Re-exports the test-utils helpers with acceptance-specific wrappers.
 * Phase 0: scaffold. Phase 1+ adds real spawnTestDaemon, spawnTestElectron.
 */

export { spawnTestDaemon } from "../../test-utils/test-daemon.js";
export { createTestDb } from "../../test-utils/test-db.js";
export { makeMockContext } from "../../test-utils/test-context.js";
export { sampleProject, sampleSession, makeProjectWithSessions } from "../../test-utils/test-fixtures.js";