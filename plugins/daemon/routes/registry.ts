// @ts-nocheck
/**
 * Instance registry routes.
 *
 *   POST /register    { dir, pid }    → { success: true } | 409 if alive entry exists
 *   POST /unregister  { dir }         → { success: true }
 *   GET  /status                       → { success, data: { instances: [...] } }
 *
 * The registry is a Map<dir, RegistryEntry> mirrored to ~/.agentdock/registry.json
 * on every change. Used by kill-all.ts and external observers.
 */
import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { z } from "zod";
import type { DaemonContext } from "../context.js";
import { zodErrorHandler } from "../middleware/error.js";

const RegisterSchema = z.object({
  dir: z.string().min(1, "dir required"),
  pid: z.number().int().positive("pid must be a positive integer"),
});

const UnregisterSchema = z.object({
  dir: z.string().min(1, "dir required"),
});

export function registerRegistry(app: Hono, ctx: DaemonContext): void {
  app.post("/register", zValidator("json", RegisterSchema, zodErrorHandler), (c) => {
    const { dir, pid } = c.req.valid("json");
    const existing = ctx.registry.get(dir);
    if (existing && ctx.isProcessAlive(existing.pid)) {
      return c.json(
        { success: false, error: `Directory already registered by PID ${existing.pid}` },
        409,
      );
    }
    ctx.registry.set(dir, { dir, pid, startedAt: new Date().toISOString() });
    ctx.saveRegistry();
    return c.json({ success: true });
  });

  app.post("/unregister", zValidator("json", UnregisterSchema, zodErrorHandler), (c) => {
    const { dir } = c.req.valid("json");
    ctx.registry.delete(dir);
    ctx.saveRegistry();
    return c.json({ success: true });
  });

  app.get("/status", (c) => {
    const instances: Array<{
      dir: string;
      pid: number;
      startedAt: string;
      status: string;
    }> = [];
    for (const [dir, entry] of ctx.registry) {
      instances.push({
        dir,
        pid: entry.pid,
        startedAt: entry.startedAt,
        status: ctx.isProcessAlive(entry.pid) ? "running" : "stale",
      });
    }
    return c.json({ success: true, data: { instances } });
  });
}
