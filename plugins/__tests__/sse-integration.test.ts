// @ts-nocheck
/**
 * SSE integration tests — 新架构 §7.3 wire format.
 *
 * Verifies the SSE event bus delivers the right events when v2 endpoints
 * are exercised. Uses raw fetch (no openSse helper) for maximum control
 * over frame-by-frame reading.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentDockDaemon } from "../daemon.js";

let dir: string;
let daemon: AgentDockDaemon;
let baseUrl: string;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "agentdock-sse-"));
  daemon = new AgentDockDaemon({ port: 0, baseDir: dir });
  await daemon.start();
  baseUrl = `http://127.0.0.1:${daemon.getPort()}`;
});

afterEach(async () => {
  await daemon.stop();
  rmSync(dir, { recursive: true, force: true });
});

async function postJson(p: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${p}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

interface SseFrame {
  event: string;
  id: string;
  data: unknown;
}

/**
 * Open SSE, collect frames into an array, return a reader object with
 * `frames` and `done` flag. Tests poll `frames` until the expected event
 * arrives or timeout.
 */
async function openSseCollector(): Promise<{
  frames: SseFrame[];
  close: () => Promise<void>;
}> {
  const ctrl = new AbortController();
  const res = await fetch(`${baseUrl}/events`, { signal: ctrl.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const frames: SseFrame[] = [];
  let buf = "";

  // Background read loop — pushes parsed frames into frames array
  (async () => {
    while (!ctrl.signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const parsed = parseSseFrame(raw);
        if (parsed) frames.push(parsed);
      }
    }
  })().catch(() => {});

  const close = async () => {
    ctrl.abort();
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  };

  return { frames, close };
}

function parseSseFrame(raw: string): SseFrame | null {
  let event = "";
  let id = "";
  let data = "";
  for (const line of raw.split("\n")) {
    if (line.startsWith("event: ")) event = line.slice(7).trim();
    else if (line.startsWith("id: ")) id = line.slice(4).trim();
    else if (line.startsWith("data: ")) data = line.slice(6);
  }
  if (!event) return null;
  try {
    return { event, id, data: JSON.parse(data) };
  } catch {
    return { event, id, data };
  }
}

/**
 * Poll until a frame with the given event name arrives or timeout.
 * Skips initial frames (the replay) and finds the matching one.
 */
async function waitForEvent(
  frames: SseFrame[],
  eventName: string,
  timeoutMs = 3000,
): Promise<SseFrame | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = frames.find((f) => f.event === eventName);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 30));
  }
  return null;
}

describe("v2 /events — SSE wire format", () => {
  it("connects and receives hello frame", async () => {
    const col = await openSseCollector();
    try {
      const hello = await waitForEvent(col.frames, "hello");
      expect(hello).not.toBeNull();
      expect(typeof hello!.id).toBe("string");
    } finally {
      await col.close();
    }
  });

  it("session-created event has sessionId in payload", async () => {
    const col = await openSseCollector();
    try {
      // Wait for hello so subscriber is registered
      await waitForEvent(col.frames, "hello");

      const c = await postJson("/session/create", {
        clientId: "c1",
        pid: 1,
        projectRoot: "/p",
        displayName: "sse-test",
      });
      const sid = (c.body as { sessionId: string }).sessionId;
      // §7.3 — session-created 事件在 /session/activate 成功后推送, 不在 create.
      await postJson("/session/activate", { sessionId: sid, fencingToken: 1 });

      const created = await waitForEvent(col.frames, "session-created");
      expect(created).not.toBeNull();
      expect((created!.data as { sessionId: string }).sessionId).toBe(sid);
    } finally {
      await col.close();
    }
  });

  it("session-renamed event fires on rename", async () => {
    // Pre-create session so its buffer event is replayed on connect
    const c = await postJson("/session/create", {
      clientId: "c1",
      pid: 1,
      projectRoot: "/p",
      displayName: "old",
    });
    const sid = (c.body as { sessionId: string }).sessionId;
    await postJson("/session/activate", { sessionId: sid, fencingToken: 1 });

    const col = await openSseCollector();
    try {
      await waitForEvent(col.frames, "hello");

      await postJson("/session/rename", {
        sessionId: sid,
        fencingToken: 1,
        displayName: "new",
      });

      const renamed = await waitForEvent(col.frames, "session-renamed");
      expect(renamed).not.toBeNull();
      expect((renamed!.data as { newDisplayName: string }).newDisplayName).toBe("new");
    } finally {
      await col.close();
    }
  });

  it("port-reassigned event fires when claim conflicts", async () => {
    const c1 = await postJson("/session/create", {
      clientId: "c1",
      pid: 1,
      projectRoot: "/p1",
      displayName: "s1",
    });
    const sid1 = (c1.body as { sessionId: string }).sessionId;
    const c2 = await postJson("/session/create", {
      clientId: "c2",
      pid: 2,
      projectRoot: "/p2",
      displayName: "s2",
    });
    const sid2 = (c2.body as { sessionId: string }).sessionId;

    await postJson("/session/activate", { sessionId: sid1, fencingToken: 1 });
    await postJson("/session/activate", { sessionId: sid2, fencingToken: 1 });

    const first = await postJson("/claim", {
      sessionId: sid1,
      fencingToken: 1,
      name: "P",
    });
    const firstPort = (first.body as { port: number }).port;

    const col = await openSseCollector();
    try {
      await waitForEvent(col.frames, "hello");

      await postJson("/claim", {
        sessionId: sid2,
        fencingToken: 1,
        requestedPort: firstPort,
        name: "P",
      });

      const reassigned = await waitForEvent(col.frames, "port-reassigned");
      expect(reassigned).not.toBeNull();
      const data = reassigned!.data as {
        sessionId: string;
        oldPort: number;
        newPort: number;
      };
      expect(data.sessionId).toBe(sid2);
      expect(data.oldPort).toBe(firstPort);
      expect(data.newPort).not.toBe(firstPort);
    } finally {
      await col.close();
    }
  });

  it("ownership-revoked event fires on takeover", async () => {
    const c = await postJson("/session/create", {
      clientId: "client-A",
      pid: 1,
      projectRoot: "/p",
    });
    const sid = (c.body as { sessionId: string }).sessionId;
    await postJson("/session/activate", { sessionId: sid, fencingToken: 1 });

    const col = await openSseCollector();
    try {
      await waitForEvent(col.frames, "hello");

      await postJson("/takeover", {
        sessionId: sid,
        clientId: "client-B",
        pid: 2,
        fencingToken: 1,
      });

      const revoked = await waitForEvent(col.frames, "ownership-revoked");
      expect(revoked).not.toBeNull();
      expect((revoked!.data as { newOwner: string }).newOwner).toBe("client-B");
    } finally {
      await col.close();
    }
  });
});

describe("v2 /events — Last-Event-ID replay (§7.3)", () => {
  it("emits resync-required when lastEventId is before the buffer", { timeout: 30_000 }, async () => {
    // Drain buffer by triggering many events. Serial renames work.
    const c = await postJson("/session/create", {
      clientId: "c1",
      pid: 1,
      projectRoot: "/p",
      displayName: "flood",
    });
    const sid = (c.body as { sessionId: string }).sessionId;
    await postJson("/session/activate", { sessionId: sid, fencingToken: 1 });
    for (let i = 0; i < 300; i++) {
      await postJson("/session/rename", {
        sessionId: sid,
        fencingToken: 1,
        displayName: `flood-${i}`,
      });
    }

    // Now connect with Last-Event-ID=1 (before the buffer)
    const ctrl = new AbortController();
    const res = await fetch(`${baseUrl}/events`, {
      headers: { "Last-Event-ID": "1" },
      signal: ctrl.signal,
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const start = Date.now();
    let firstEvent = "";
    while (Date.now() - start < 3000) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const idx = buf.indexOf("\n\n");
      if (idx >= 0) {
        const frame = buf.slice(0, idx);
        const eventLine = frame.split("\n").find((l) => l.startsWith("event: "));
        firstEvent = eventLine?.slice(7).trim() ?? "";
        break;
      }
    }
    ctrl.abort();
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
    expect(firstEvent).toBe("resync-required");
  });
});
