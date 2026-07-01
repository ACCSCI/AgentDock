// @ts-nocheck
/**
 * Session lifecycle and takeover routes for daemon API v2 (§4.2, §6.1).
 */
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  Hono,
  type DaemonContext,
  SESSION_ID_RE,
  LEASE_TTL_MS,
  sanitizeDisplayName,
  lookupCurrentBranch,
  zodErrorHandler,
  mapError,
} from "./shared.js";

// ---------------------------------------------------------------------------
// /session/* — lifecycle (§4.2)
// ---------------------------------------------------------------------------

const SessionCreateSchema = z.object({
  sessionId: z.string().regex(SESSION_ID_RE, "Invalid sessionId").optional(),
  clientId: z.string().min(1, "clientId required"),
  pid: z.number().int().positive(),
  projectRoot: z.string().min(1, "projectRoot required"),
  displayName: z.string().max(128).optional(),
});

const ReclaimSchema = z.object({
  sessionId: z.string().min(1).regex(SESSION_ID_RE, "Invalid sessionId"),
  clientId: z.string().min(1, "clientId required"),
  pid: z.number().int().positive(),
  projectRoot: z.string().min(1, "projectRoot required"),
  displayName: z.string().max(128).optional(),
});

const SessionActivateSchema = z.object({
  sessionId: z.string().min(1).regex(SESSION_ID_RE, "Invalid sessionId"),
  fencingToken: z.number().int().positive(),
});

const SessionRenameSchema = z.object({
  sessionId: z.string().min(1).regex(SESSION_ID_RE, "Invalid sessionId"),
  fencingToken: z.number().int().positive(),
  displayName: z.string().min(1).max(128),
});

const SessionDeleteSchema = z.object({
  sessionId: z.string().min(1).regex(SESSION_ID_RE, "Invalid sessionId"),
  fencingToken: z.number().int().positive(),
});

const SessionPurgeSchema = z.object({
  sessionId: z.string().min(1).regex(SESSION_ID_RE, "Invalid sessionId"),
  fencingToken: z.number().int().positive(),
});

const SessionHeartbeatSchema = z.object({
  sessionId: z.string().min(1).regex(SESSION_ID_RE, "Invalid sessionId"),
  fencingToken: z.number().int().positive(),
  phase: z.enum(["creating", "deleting"]).optional(),
});

export function registerSessionsV2(app: Hono, ctx: DaemonContext): void {
  app.post(
    "/session/create",
    zValidator("json", SessionCreateSchema, zodErrorHandler),
    async (c) => {
      const body = c.req.valid("json");
      const result = await ctx.mutex.runExclusive("state", () => {
        const sessionId = body.sessionId ?? crypto.randomUUID();
        // §4.1 — displayName 最小消毒 (去控制字符 + 长度上限 + trim)
        const sanitized = sanitizeDisplayName(body.displayName);
        const displayName = sanitized || sessionId.slice(0, 8);
        ctx.stateV2.createSession({
          sessionId,
          projectRoot: body.projectRoot,
          displayName,
          clientId: body.clientId,
          pid: body.pid,
          leaseExpiresAt: Date.now() + LEASE_TTL_MS,
        });
        ctx.walV2.persist(ctx.stateV2);
        return {
          sessionId,
          fencingToken: ctx.stateV2.getOwner(sessionId)?.fencingToken ?? 1,
        };
      });
      // §5.2 — dynamically add newly created sessionId to the expected set
      // so the RECOVERING gate allows subsequent recovery claims for it.
      ctx.expectedSessionIds?.add(result.sessionId);
      // 注: §7.3 规定 session-created 事件在 /session/activate 成功后推
      // (不是 /session/create 时). 此时 session 仍 creating, 监听端不
      // 应当看见 session-created. 事件推送移至 /session/activate 末尾.
      return c.json({ success: true, ...result });
    },
  );

  app.post(
    "/session/reclaim",
    zValidator("json", ReclaimSchema, zodErrorHandler),
    async (c) => {
      const body = c.req.valid("json");
      const result = await ctx.mutex.runExclusive("state", () => {
        const sanitized = sanitizeDisplayName(body.displayName);
        const displayName = sanitized || body.sessionId.slice(0, 8);
        const { fencingToken, created } = ctx.stateV2.reclaimSession({
          sessionId: body.sessionId,
          projectRoot: body.projectRoot,
          displayName,
          clientId: body.clientId,
          pid: body.pid,
          leaseExpiresAt: Date.now() + LEASE_TTL_MS,
        });
        ctx.walV2.persist(ctx.stateV2);
        return { fencingToken, created };
      });
      ctx.expectedSessionIds?.add(body.sessionId);
      return c.json({ success: true, ...result });
    },
  );

  app.post(
    "/session/activate",
    zValidator("json", SessionActivateSchema, zodErrorHandler),
    async (c) => {
      const body = c.req.valid("json");
      // §5.2 — activate signals the session reached commit point;
      // record it so the RECOVERING gate allows subsequent recovery claims.
      ctx.recovering?.recordReport(body.sessionId);
      try {
        await ctx.mutex.runExclusive("state", () => {
          ctx.stateV2.assertFencingToken(body.sessionId, body.fencingToken);
          ctx.stateV2.activateSession(body.sessionId);
          ctx.walV2.persist(ctx.stateV2);
        });
        // §7.3 — session-created 在 activate 成功后推. branch 必须现查
        // git (§4.1 派生字段不入库). projectRoot 已知, worktreePath
        // 由 sessionId 派生.
        const session = ctx.stateV2.getSession(body.sessionId);
        let branch: string | null = null;
        if (session) {
          branch = await lookupCurrentBranch(session.projectRoot, body.sessionId);
        }
        ctx.sseBus.publish("session-created", {
          sessionId: body.sessionId,
          displayName: session?.displayName,
          branch: branch ?? "",
        });
        return c.json({ success: true });
      } catch (err) {
        return mapError(c, err);
      }
    },
  );

  app.post(
    "/session/rename",
    zValidator("json", SessionRenameSchema, zodErrorHandler),
    async (c) => {
      const body = c.req.valid("json");
      try {
        await ctx.mutex.runExclusive("state", () => {
          ctx.stateV2.assertFencingToken(body.sessionId, body.fencingToken);
          // §4.1 — displayName 最小消毒
          const sanitized = sanitizeDisplayName(body.displayName);
          ctx.stateV2.renameSession(body.sessionId, sanitized);
          ctx.walV2.persist(ctx.stateV2);
        });
        ctx.sseBus.publish("session-renamed", {
          sessionId: body.sessionId,
          newDisplayName: sanitizeDisplayName(body.displayName),
        });
        return c.json({ success: true });
      } catch (err) {
        return mapError(c, err);
      }
    },
  );

  app.post(
    "/session/delete",
    zValidator("json", SessionDeleteSchema, zodErrorHandler),
    async (c) => {
      const body = c.req.valid("json");
      try {
        await ctx.mutex.runExclusive("state", () => {
          ctx.stateV2.assertFencingToken(body.sessionId, body.fencingToken);
          ctx.stateV2.beginDelete(body.sessionId, Date.now() + LEASE_TTL_MS);
          ctx.walV2.persist(ctx.stateV2);
        });
        // §7.3 — phase 1 推 session-deleting (进入 deleting), 不是
        // session-purged. session-purged 仅在 phase 2 (/session/purge)
        // 删三表项时推.
        ctx.sseBus.publish("session-deleting", { sessionId: body.sessionId });
        return c.json({ success: true });
      } catch (err) {
        return mapError(c, err);
      }
    },
  );

  app.post(
    "/session/purge",
    zValidator("json", SessionPurgeSchema, zodErrorHandler),
    async (c) => {
      const body = c.req.valid("json");
      try {
        await ctx.mutex.runExclusive("state", () => {
          ctx.stateV2.assertFencingToken(body.sessionId, body.fencingToken);
          ctx.stateV2.purgeSession(body.sessionId);
          ctx.walV2.persist(ctx.stateV2);
        });
        ctx.sseBus.publish("session-purged", { sessionId: body.sessionId });
        return c.json({ success: true });
      } catch (err) {
        return mapError(c, err);
      }
    },
  );

  app.post(
    "/session/heartbeat",
    zValidator("json", SessionHeartbeatSchema, zodErrorHandler),
    async (c) => {
      const body = c.req.valid("json");
      // §5.2 — heartbeat signals the session is alive during RECOVERING;
      // record it so the gate allows subsequent recovery claims.
      ctx.recovering?.recordReport(body.sessionId);
      try {
        await ctx.mutex.runExclusive("state", () => {
          ctx.stateV2.assertFencingToken(body.sessionId, body.fencingToken);
          ctx.stateV2.renewLease(body.sessionId, LEASE_TTL_MS);
          ctx.walV2.persist(ctx.stateV2);
        });
        return c.json({ success: true });
      } catch (err) {
        return mapError(c, err);
      }
    },
  );
}

// ---------------------------------------------------------------------------
// /takeover — fencingToken bump (§6.1)
// ---------------------------------------------------------------------------

const TakeoverSchema = z.object({
  sessionId: z.string().min(1).regex(SESSION_ID_RE),
  clientId: z.string().min(1),
  pid: z.number().int().positive(),
  fencingToken: z.number().int().positive(),
});

export function registerTakeover(app: Hono, ctx: DaemonContext): void {
  app.post(
    "/takeover",
    zValidator("json", TakeoverSchema, zodErrorHandler),
    async (c) => {
      const body = c.req.valid("json");
      try {
        const result = await ctx.mutex.runExclusive("state", () => {
          const r = ctx.stateV2.takeover(
            body.sessionId,
            body.clientId,
            body.pid,
            body.fencingToken,
          );
          ctx.walV2.persist(ctx.stateV2);
          return r;
        });
        ctx.sseBus.publish("ownership-revoked", {
          sessionId: body.sessionId,
          newOwner: body.clientId,
          fencingToken: result.fencingToken,
        });
        return c.json({ success: true, ...result });
      } catch (err) {
        return mapError(c, err);
      }
    },
  );
}
