// @ts-nocheck
/**
 * Shared constants and utilities for daemon API v2 routes.
 *
 * Re-exports symbols that multiple v2 sub-modules need so each
 * route file only has to import from "./shared.js".
 */
import { zValidator } from "@hono/zod-validator";
import { type Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { LEASE_TTL_MS, PROTOCOL_VERSION } from "../../../constants.js";
import {
  CURRENT_SCHEMA_VERSION,
  type DaemonStateV2,
  NotOwnerError,
  PortConflictError,
  RecoveringError,
  SessionBusyError,
  SessionNotDeletableError,
  StaleOwnerError,
} from "../../../daemon-state-v2.js";
import { sanitizeDisplayName } from "../../../display-name.js";
import { lookupCurrentBranch } from "../../../git-branch-lookup.js";
import { checkAllInvariants } from "../../../invariants.js";
import { isPortAvailable, pickFreePort } from "../../../port-allocator.js";
import { gateClaimInRecovering } from "../../../recovering-controller.js";
import type { DaemonContext } from "../../context.js";
import { zodErrorHandler } from "../../middleware/error.js";

const SESSION_ID_RE = /^[a-zA-Z0-9-_]+$/;

const PROTOCOL_VERSION_STR = String(PROTOCOL_VERSION);

const HEALTH_CAPABILITIES = [
  "port-allocation",
  "session-registry",
  "claim-port",
  "fencing",
  "lifecycle-lease",
] as const;

// Re-export everything for sub-modules
export {
  zValidator,
  Hono,
  type Context,
  z,
  type DaemonContext,
  LEASE_TTL_MS,
  PROTOCOL_VERSION,
  CURRENT_SCHEMA_VERSION,
  NotOwnerError,
  PortConflictError,
  RecoveringError,
  SessionBusyError,
  SessionNotDeletableError,
  StaleOwnerError,
  type DaemonStateV2,
  isPortAvailable,
  pickFreePort,
  zodErrorHandler,
  gateClaimInRecovering,
  lookupCurrentBranch,
  sanitizeDisplayName,
  checkAllInvariants,
  streamSSE,
  SESSION_ID_RE,
  PROTOCOL_VERSION_STR,
  HEALTH_CAPABILITIES,
};

// ---------------------------------------------------------------------------
// Error mapping — §13.2 codes
// ---------------------------------------------------------------------------

export function mapError(c: Context, err: unknown) {
  if (err instanceof StaleOwnerError) {
    return c.json(
      {
        success: false,
        error: {
          code: "STALE_OWNER",
          message: err.message,
          currentToken: err.currentToken,
        },
      },
      409,
    );
  }
  if (err instanceof NotOwnerError) {
    return c.json(
      {
        success: false,
        error: {
          code: "NOT_OWNER",
          message: err.message,
        },
      },
      403,
    );
  }
  if (err instanceof PortConflictError) {
    return c.json(
      {
        success: false,
        error: {
          code: "PORT_CONFLICT",
          message: err.message,
          port: err.port,
          ownerSessionId: err.ownerSessionId,
        },
      },
      409,
    );
  }
  if (err instanceof SessionBusyError) {
    return c.json(
      {
        success: false,
        error: {
          code: "SESSION_BUSY",
          message: err.message,
          leaseExpiresAt: err.leaseExpiresAt,
        },
      },
      409,
    );
  }
  if (err instanceof SessionNotDeletableError) {
    return c.json(
      {
        success: false,
        error: {
          code: "SESSION_NOT_DELETABLE",
          message: err.message,
          currentStatus: err.currentStatus,
        },
      },
      409,
    );
  }
  if (err instanceof RecoveringError) {
    return c.json(
      {
        success: false,
        error: {
          code: "RECOVERING",
          message: err.message,
        },
      },
      503,
    );
  }
  if (err instanceof Error && err.message.includes("not found")) {
    return c.json(
      {
        success: false,
        error: { code: "UNKNOWN_SESSION", message: err.message },
      },
      404,
    );
  }
  return c.json(
    {
      success: false,
      error: { code: "INTERNAL", message: (err as Error).message },
    },
    500,
  );
}
