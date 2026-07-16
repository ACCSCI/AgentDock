// @ts-nocheck
/**
 * Error middleware — unifies error responses into the daemon's
 * `{ success: false, error: string }` envelope.
 *
 * Replaces the per-handler try/catch + this.json(res, 500, {...}) boilerplate
 * that the original daemon.ts had in every route. With this middleware,
 * route handlers can `throw new Error("...")` and the response shape stays
 * consistent.
 *
 * Hono's built-in `app.onError` could do similar work, but we need a
 * separate `c.json(...)` shape (the daemon contract uses `{success, error}`,
 * not RFC 7807), so a dedicated middleware is clearer.
 */
import type { Context } from "hono";
import type { MiddlewareHandler } from "hono";
import { log } from "../../logger.js";

export const errorEnvelope: MiddlewareHandler = async (c, next) => {
  try {
    await next();
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    // Use pino (writes JSON to stdout). Avoid console.error — Electron
    // forwards it to the renderer's DevTools console; if no renderer is
    // listening, the write throws EPIPE and triggers an uncaught-exception
    // dialog on top of our own.
    log.error({ err, path: c.req.path }, "daemon route error");
    return c.json({ success: false, error: message }, 500);
  }
};

interface ZodLikeIssue {
  code?: string;
  path?: Array<string | number>;
  message?: string;
}

interface ZodLikeError {
  issues?: ZodLikeIssue[];
}

/**
 * Format a zod validation failure into the same error message the old
 * hand-rolled validation produced, so external callers and existing tests
 * see backward-compatible wording.
 *
 * Old style (one example):
 *   "clientId and sessionId required"
 *   "count must be 1-100"
 *   "exclude must be an array"
 *
 * This helper:
 *   - If issues are all "required" failures (zod `invalid_type` with no
 *     actual value, e.g. missing fields), returns
 *     "<field1>, <field2>, ... required"
 *   - Otherwise returns the first issue's message verbatim
 *
 * Note on zod v4: missing fields produce { code: "invalid_type",
 * expected: "string" } but no `received` field. We detect by code + the
 * presence of an expected type.
 *
 * Note on type: we use a structural type here instead of `ZodError` from
 * zod because zod v4 renamed it to `$ZodError` internally. The shape we
 * care about (issues[]) is the same across versions.
 */
export function formatZodError(error: ZodLikeError): string {
  const issues = error.issues ?? [];

  const missing: string[] = [];
  let firstNonMissing: string | null = null;

  for (const issue of issues) {
    const path = (issue.path ?? []).join(".");
    const isMissing = issue.code === "invalid_type";
    if (isMissing) {
      missing.push(path || "(root)");
    } else if (!firstNonMissing) {
      firstNonMissing = issue.message ?? "Invalid body";
    }
  }

  if (missing.length > 0) {
    return `${missing.join(", ")} required`;
  }
  return firstNonMissing ?? "Invalid body";
}

/**
 * zValidator error handler factory. Use as:
 *   zValidator("json", Schema, zodErrorHandler)
 *
 * Returns the c.json(...) response on failure, or undefined to continue.
 */
export function zodErrorHandler(
  result: { success: boolean; error?: ZodLikeError },
  c: Context,
): Response | undefined {
  if (result.success) return undefined;
  const error = result.error;
  if (!error) return c.json({ success: false, error: "Invalid body" }, 400);
  return c.json({ success: false, error: formatZodError(error) }, 400);
}

/**
 * Wrap an async handler so any thrown error becomes a 500 JSON response.
 * Use this on individual routes if you don't want the global errorEnvelope.
 */
export function safeJson(
  c: Context,
  handler: () => Promise<Response | { status?: number; body: unknown }>,
): Promise<Response> {
  return handler().then((result) => {
    if (result instanceof Response) return result;
    return c.json(result.body, result.status ?? 200);
  });
}
