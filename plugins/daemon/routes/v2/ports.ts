// @ts-nocheck
/**
 * Port allocation routes for daemon API v2 (§3.3, §3.4, §6.2).
 */
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  Hono,
  type DaemonContext,
  SESSION_ID_RE,
  type DaemonStateV2,
  isPortAvailable,
  pickFreePort,
  gateClaimInRecovering,
  zodErrorHandler,
  mapError,
} from "./shared.js";

// ---------------------------------------------------------------------------
// /claim /release /reassign — port ops (§3.3, §3.4, §6.2)
// ---------------------------------------------------------------------------

const ClaimSchema = z.object({
  sessionId: z.string().min(1).regex(SESSION_ID_RE),
  fencingToken: z.number().int().positive(),
  requestedPort: z.number().int().min(1).max(65535).optional(),
  name: z.string().min(1).max(64).default("PORT"),
  bindFailed: z.boolean().optional().default(false),
});

const ReleaseSchema = z.object({
  sessionId: z.string().min(1).regex(SESSION_ID_RE),
  fencingToken: z.number().int().positive(),
  port: z.number().int().min(1).max(65535),
});

const ReassignSchema = z.object({
  sessionId: z.string().min(1).regex(SESSION_ID_RE),
  fencingToken: z.number().int().positive(),
});

export function registerClaim(app: Hono, ctx: DaemonContext): void {
  app.post(
    "/claim",
    zValidator("json", ClaimSchema, zodErrorHandler),
    async (c) => {
      const body = c.req.valid("json");
      // §5.2 — claim signals the session is alive during RECOVERING;
      // record it so subsequent recovery claims for this sessionId pass.
      ctx.recovering?.recordReport(body.sessionId);
      try {
        const result = await ctx.mutex.runExclusive("state", async () => {
          // §5.2 — RECOVERING 期闸门: 仅放行 expected 的恢复性 claim.
          // 陌生 sessionId 视为新分配, 拒绝并让 client 稍后重试.
          const expected = ctx.expectedSessionIds ?? new Set<string>();
          const gate = gateClaimInRecovering(
            ctx.stateV2,
            body.sessionId,
            expected,
            ctx.alreadyReportedThisWindow ?? new Set<string>(),
          );
          if (!gate.allow) {
            return c.json(
              { success: false, error: { code: gate.code, message: gate.message } },
              503, // Service Unavailable — RECOVERING 临时状态, 不是客户端错误
            );
          }
          // §5.2 闸门放行. 注: 旧实现这里有"已上报"重复上报放行机制
          // (alreadyReportedThisWindow), 但 !getSession 条件让该分支
          // 永不入 (gate 拒绝的正是 getSession==null 的陌生 sessionId).
          // 死代码已删除 — 真要支持"非 expected 但已上报"放行, 需要
          // 客户端先发某种"report"端点, 不在 /claim 内. backlog.

          ctx.stateV2.assertFencingToken(body.sessionId, body.fencingToken);

          const requested = body.requestedPort;
          if (requested !== undefined) {
            // Try the requested port first
            const owner = ctx.stateV2.getPortOwner(requested);
            if (owner && owner.sessionId !== body.sessionId) {
              ctx.metrics.conflictCount++;
              const r = await conflictBranch(
                ctx.stateV2,
                body.sessionId,
                body.name,
                body.bindFailed ? requested : undefined,
              );
              ctx.walV2.persist(ctx.stateV2);
              // P5: publish port-reassigned event
              ctx.sseBus.publish("port-reassigned", {
                sessionId: body.sessionId,
                oldPort: requested,
                newPort: r.port,
              });
              return r;
            }
            // Idempotent for same session — no probe needed
            // §3.3 末段: 幂等免探活仅在 owner 连续 (Daemon 未重启) 时成立.
            // RECOVERING 期 (Daemon 刚重启, 看护连续性已破) 即便同
            // session 同端口也必须重新 bind 探活 — 崩溃窗口内 OS 层
            // 该端口可能已被外部进程抢占, 免探活会误判仍归该 session.
            if (owner && owner.sessionId === body.sessionId && !ctx.stateV2.isRecovering()) {
              ctx.walV2.persist(ctx.stateV2);
              return { port: requested, picked: false };
            }
            // Free per registry — bind probe (§3.3)
            if (!(await isPortAvailable(requested))) {
              ctx.metrics.conflictCount++;
              const r = await conflictBranch(
                ctx.stateV2,
                body.sessionId,
                body.name,
                body.bindFailed ? requested : undefined,
              );
              ctx.walV2.persist(ctx.stateV2);
              // §3.3 — 锁内 claim 完毕, 锁外异步 close.
              void r.closeServer();
              ctx.sseBus.publish("port-reassigned", {
                sessionId: body.sessionId,
                oldPort: requested,
                newPort: r.port,
              });
              return r;
            }
            // Reserve it
            ctx.stateV2.claimPort(body.sessionId, requested, body.name);
            ctx.metrics.claimCount++;
            ctx.walV2.persist(ctx.stateV2);
            return { port: requested, picked: false };
          }

          // No requested port → allocate a fresh free one
          // §3.3 — pickFreePort 返回 { port, closeServer }. 先 claimPort
          // 登记 RESERVED (锁内), 再 closeServer 释放端口 (锁外).
          // 缩小"close 后到 claimPort 之间"的抢占窗口.
          const { port: picked, closeServer } = await pickFreePort(
            ctx.stateV2.listAllPorts().map((p) => p.port),
          );
          ctx.stateV2.claimPort(body.sessionId, picked, body.name);
          ctx.metrics.claimCount++;
          ctx.walV2.persist(ctx.stateV2);
          // 锁内做完, 锁外异步 close. 不 await closeServer: 不阻塞
          // 响应; OS 层 close 与 claimPort 在 await 切换间仍有窗口, 但
          // bindFailed 路径专门兜底.
          void closeServer().catch(() => {});
          return { port: picked, picked: true };
        });
        return c.json({ success: true, ...result });
      } catch (err) {
        return mapError(c, err);
      }
    },
  );

  app.post(
    "/release",
    zValidator("json", ReleaseSchema, zodErrorHandler),
    async (c) => {
      const body = c.req.valid("json");
      try {
        await ctx.mutex.runExclusive("state", () => {
          ctx.stateV2.assertFencingToken(body.sessionId, body.fencingToken);
          ctx.stateV2.releasePort(body.sessionId, body.port);
          ctx.walV2.persist(ctx.stateV2);
        });
        ctx.metrics.releaseCount++;
        ctx.sseBus.publish("port-released", {
          sessionId: body.sessionId,
          port: body.port,
        });
        return c.json({ success: true });
      } catch (err) {
        return mapError(c, err);
      }
    },
  );

  app.post(
    "/reassign",
    zValidator("json", ReassignSchema, zodErrorHandler),
    async (c) => {
      const body = c.req.valid("json");
      try {
        const result = await ctx.mutex.runExclusive("state", async () => {
          ctx.stateV2.assertFencingToken(body.sessionId, body.fencingToken);
          // Release all old ports, pick new ones for each name.
          // Build name→oldPort mapping BEFORE releaseAllPorts so we can
          // correctly pair old/new ports in SSE events by name.
          const oldPorts = ctx.stateV2.getSessionPorts(body.sessionId);
          const oldNames = ctx.stateV2.getSessionPortNames(body.sessionId);
          const oldPortsByName = new Map<string, number>();
          for (const p of oldPorts) {
            const owner = ctx.stateV2.getPortOwner(p);
            if (owner && owner.sessionId === body.sessionId) {
              oldPortsByName.set(owner.name, p);
            }
          }
          ctx.stateV2.releaseAllPorts(body.sessionId);
          const excluded = new Set(ctx.stateV2.listAllPorts().map((p) => p.port));
          const newPorts: Record<string, number> = {};
          const openServers: Array<() => Promise<void>> = [];
          for (const name of oldNames) {
            // §3.3 — pickFreePort {port, closeServer}. 锁内 claim, 锁
            // 外 close (见上文).
            const { port: p, closeServer } = await pickFreePort([...excluded]);
            ctx.stateV2.claimPort(body.sessionId, p, name);
            openServers.push(closeServer);
            newPorts[name] = p;
            excluded.add(p);
          }
          ctx.walV2.persist(ctx.stateV2);
          return {
            ports: newPorts,
            oldPorts: [...oldPortsByName.values()],
            oldPortsByName,
            openServers,
          };
        });
        // §3.3 — 锁内 claim 完毕, 锁外 close 所有 open servers.
        // 不 await: 不阻塞响应; bindFailed 路径兜底.
        for (const cs of result.openServers) void cs().catch(() => {});
        // P5: publish per-port reassigned events (paired by port name)
        for (const [name, oldP] of result.oldPortsByName) {
          const newP = result.ports[name];
          if (newP !== undefined) {
            ctx.sseBus.publish("port-reassigned", {
              sessionId: body.sessionId,
              oldPort: oldP,
              newPort: newP,
            });
          }
        }
        // Exclude non-serializable fields from the HTTP response
        const { oldPortsByName: _, openServers: __, ...body_ } = result;
        return c.json({ success: true, ...body_ });
      } catch (err) {
        return mapError(c, err);
      }
    },
  );
}

async function conflictBranch(
  state: DaemonStateV2,
  sessionId: string,
  name: string,
  /** If bindFailed was set, caller already knows requestedPort is taken —
   * skip re-probing and pick a fresh one immediately. */
  skipProbePort: number | undefined,
): Promise<{ port: number; picked: true; closeServer: () => Promise<void> }> {
  const excluded = new Set(state.listAllPorts().map((p) => p.port));
  if (skipProbePort !== undefined) excluded.add(skipProbePort);
  // §3.3 — 锁内 claim, 锁外 close (见上方 /claim handler)
  const { port: picked, closeServer } = await pickFreePort([...excluded]);
  state.claimPort(sessionId, picked, name);
  return { port: picked, picked: true, closeServer };
}
