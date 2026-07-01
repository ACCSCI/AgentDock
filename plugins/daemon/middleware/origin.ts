// @ts-nocheck
/**
 * Origin guard — CSRF / cross-origin protection.
 *
 * The daemon's legitimate clients (plugins/daemon-client.ts) use raw
 * http.request and never set an Origin header. Browsers, however, always
 * send Origin on cross-site requests. So we reject any state-changing
 * (POST) request that carries an Origin header.
 *
 * Also handles OPTIONS preflight: returns 204 with explicit (non-wildcard)
 * CORS headers, matching the original daemon's behavior.
 */
import type { MiddlewareHandler } from "hono";

export const originGuard: MiddlewareHandler = async (c, next) => {
  // Match the original headers — narrow allow-list, never `*`.
  c.header("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  c.header("Access-Control-Allow-Headers", "Content-Type");

  if (c.req.method === "OPTIONS") {
    return c.body(null, 204);
  }

  if (c.req.method !== "GET" && c.req.header("origin")) {
    return c.json(
      { success: false, error: "Forbidden: cross-origin requests are not allowed" },
      403,
    );
  }

  await next();
};