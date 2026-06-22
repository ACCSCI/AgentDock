/**
 * F7 — §7.3 resync-required end-to-end (新架构 §7.3).
 *
 * Verifies that the v2 daemon emits a `resync-required` SSE frame when a
 * consumer reconnects with a Last-Event-ID that is older than the start
 * of the ring buffer (buffer overflow or restart path). The
 * SseConsumer.onResyncRequired wiring in electron/main.ts is covered by
 * the unit test (electron/main/__tests__/sse-consumer-resync-wiring.test.ts);
 * here we prove the daemon side of §7.3 works so the two halves compose.
 *
 * Strategy:
 *   1. Boot a real daemon via the standard Electron fixture.
 *   2. Wait for daemon READY (avoid RECOVERING-window 409s).
 *   3. Trigger one /session/create so the SSE bus has at least one event
 *      (seq=1 published → buffer non-empty).
 *   4. Open a side-channel SSE connection with Last-Event-ID=0. That is
 *      WITHIN the buffer — we should see the replayed event + hello.
 *   5. Open a second side-channel SSE connection with Last-Event-ID=99999
 *      (well past buffer[0].seq-1=0). Per sse-bus.replaySince(), the
 *      daemon must emit a `resync-required` frame.
 *   6. Assert the second connection receives `resync-required`.
 */
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures/electron-fixture";

function prepareGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execSync("git init -q -b main", { cwd: dir });
  execSync(
    'git -c user.email=e2e@local -c user.name=E2E commit --allow-empty -q -m init',
    { cwd: dir },
  );
}

function writeEmptyConfig(dir: string): void {
  writeFileSync(
    join(dir, "agentdock.config.yaml"),
    `version: "1"\nresources:\n  sync: []\nhooks: {}\n`,
    "utf-8",
  );
}

async function waitForDaemonReady(
  window: import("@playwright/test").Page,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await window.evaluate(async () => {
      return (await window.api.daemon.health()) as {
        state?: string;
        lifecycleState?: string;
      };
    });
    const state = health.lifecycleState ?? health.state;
    if (state === "ready" || state === "READY") return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`waitForDaemonReady: daemon not READY after ${timeoutMs}ms`);
}

async function callV2(
  window: import("@playwright/test").Page,
  path: string,
  body: unknown = {},
): Promise<{ success: boolean; status?: number; body?: unknown }> {
  return window.evaluate(
    async ({ p, b }) => {
      const res = (await window.api.daemon.faultInject(p, b)) as {
        success: boolean;
        status?: number;
        body?: unknown;
      };
      return res;
    },
    { p: path, b: body },
  );
}

/**
 * Open a side-channel SSE connection from the test process. Returns the
 * concatenated text/event-stream body up to `deadlineMs`. We don't try
 * to parse frames here — the test asserts on substring presence to
 * keep the harness simple.
 */
async function fetchSse(
  port: number,
  lastEventId: number,
  deadlineMs: number,
): Promise<string> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), deadlineMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/events`, {
      headers: {
        Accept: "text/event-stream",
        "Last-Event-ID": String(lastEventId),
      },
      signal: ac.signal,
    });
    if (!res.ok || !res.body) return "";
    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let acc = "";
    const start = Date.now();
    while (Date.now() - start < deadlineMs) {
      const { value, done } = await reader.read();
      if (done) break;
      acc += decoder.decode(value, { stream: true });
      // Early exit once we've collected enough signal.
      if (acc.includes("resync-required") || acc.includes("event: hello")) {
        break;
      }
    }
    try {
      await reader.cancel();
    } catch {
      /* already cancelled */
    }
    return acc;
  } catch {
    return "";
  } finally {
    clearTimeout(t);
  }
}

test.describe("F7 — SSE resync-required wiring (新架构 §7.3)", () => {
  test("daemon emits resync-required when Last-Event-ID is before buffer", async ({
    window,
    dataDir,
  }) => {
    const isV2Mode = process.env.AGENTDOCK_V2 === "1";
    if (!isV2Mode) {
      test.skip(true, "F7 spec runs under AGENTDOCK_V2=1");
      return;
    }

    await waitForDaemonReady(window);

    // Resolve the daemon port via the public IPC.
    const health = (await window.evaluate(async () => {
      return (await window.api.daemon.health()) as { port: number };
    })) as { port: number };
    expect(health.port).toBeGreaterThan(0);

    // Need an active project for /session/create to be valid in v2.
    const projectPath = join(dataDir, "f7-resync-project");
    prepareGitRepo(projectPath);
    writeEmptyConfig(projectPath);
    const { HomePage } = await import("./pages/home");
    await new HomePage(window).openProject(projectPath);

    // Publish at least one event so the SSE bus buffer is non-empty
    // (buffer length > 0 is required for replaySince() to ever return null).
    const create = await callV2(window, "/session/create", {
      clientId: "f7-e2e",
      pid: 4242,
      projectRoot: projectPath,
      displayName: "f7-trigger",
    });
    expect(create.success).toBe(true);

    // Side-channel consumer #1 — Last-Event-ID=0 is within the buffer
    // (buffer starts at seq=1, and replaySince(0) returns events with
    // seq>0, so we get the replay + hello, NOT resync-required).
    const freshStream = await fetchSse(health.port, 0, 2000);
    expect(freshStream).toContain("event: hello");
    expect(freshStream).not.toContain("event: resync-required");

    // Side-channel consumer #2 — stale Last-Event-ID past the buffer.
    // buffer[0].seq=1; replaySince(99999) compares 99999 < 1-1=0 which
    // is false; but replaySince(99999) returns events with seq > 99999
    // which is empty — so we instead use a negative ID. The cleanest
    // way to trigger overflow is to send Last-Event-ID < 0 (which the
    // route coerces to 0). So we need a *different* trigger: send
    // Last-Event-ID far BELOW buffer[0].seq-1. With buffer starting at
    // seq=1, sending Last-Event-ID=0 and 99999 both behave identically
    // (0 not below -1, 99999 above buffer end). We therefore drain the
    // buffer by publishing many events so a stale seq can be forced.
    //
    // Quick path: publish until buffer overflows past the SSE_REPLAY_BUFFER
    // cap, then reconnect with the original seq. The exact buffer size
    // lives in plugins/constants.ts — we read it from the public debug
    // surface.
    const dbg = (await window.evaluate(async () => {
      return (await window.api.daemon.debugState()) as {
        sseBus?: { bufferSize?: number; firstSeq?: number; lastSeq?: number };
      } | null;
    })) as { sseBus?: { bufferSize?: number; firstSeq?: number; lastSeq?: number } } | null;
    expect(dbg?.sseBus).toBeDefined();
    const bufSize = dbg!.sseBus!.bufferSize ?? 0;
    expect(bufSize).toBeGreaterThan(0);

    // Force a buffer overflow: publish enough events to evict the first
    // seq from the ring buffer. Then reconnect with Last-Event-ID just
    // before the new first seq.
    const overflowCount = bufSize + 5;
    for (let i = 0; i < overflowCount; i++) {
      const sid = `f7-drain-${i}`;
      const r = await callV2(window, "/session/create", {
        clientId: "f7-drain",
        pid: 9000 + i,
        projectRoot: projectPath,
        displayName: sid,
      });
      expect(r.success).toBe(true);
    }

    // Now the buffer has shifted forward. Read its current first seq.
    const dbg2 = (await window.evaluate(async () => {
      return (await window.api.daemon.debugState()) as {
        sseBus?: { bufferSize?: number; firstSeq?: number; lastSeq?: number };
      } | null;
    })) as { sseBus?: { firstSeq?: number; lastSeq?: number } } | null;
    const firstSeq = dbg2?.sseBus?.firstSeq ?? 0;
    const lastSeq = dbg2?.sseBus?.lastSeq ?? 0;
    expect(firstSeq).toBeGreaterThan(0);
    expect(lastSeq).toBeGreaterThan(firstSeq);

    // Connect with Last-Event-ID = firstSeq - 2 (i.e. before buffer[0].seq-1).
    const staleStream = await fetchSse(health.port, firstSeq - 2, 3000);
    expect(staleStream).toContain("event: resync-required");
  });
});