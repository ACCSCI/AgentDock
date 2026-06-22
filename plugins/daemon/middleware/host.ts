/**
 * Host header guard — DNS rebinding protection.
 *
 * The daemon binds to 127.0.0.1, but a malicious website could exploit
 * DNS rebinding to make the browser hit our loopback URL with a non-local
 * Host header (e.g. `evil.com`). We reject any request whose Host header
 * doesn't start with 127.0.0.1 or localhost.
 *
 * Port of the original `daemon.ts:307-311` check, lifted into a Hono
 * middleware so it runs before route handlers.
 */
import type { Context, MiddlewareHandler } from "hono";

export const hostGuard: MiddlewareHandler = async (c, next) => {
  const host = c.req.header("host");
  if (host && !host.startsWith("127.0.0.1") && !host.startsWith("localhost")) {
    return c.json({ success: false, error: "Forbidden: Invalid Host header" }, 403);
  }
  await next();
};

// Exported for unit testing in isolation.
export function isAllowedHost(host: string | undefined): boolean {
  if (!host) return true;
  return host.startsWith("127.0.0.1") || host.startsWith("localhost");
}

// Silence "Context imported but unused" — re-export so route modules can type vars.
export type { Context };