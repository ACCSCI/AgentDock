/**
 * F7 — onResyncRequired 接到 host (新架构 §7.3).
 *
 * Asserts the SseConsumer wiring contract used by electron/main.ts:
 *   1. When the daemon emits `event: resync-required` over SSE, the
 *      consumer calls `opts.onResyncRequired()` synchronously.
 *   2. electron/main.ts MUST pass a non-undefined `onResyncRequired`
 *      callback when constructing the consumer. Without it, the host
 *      silently falls back to the 30s /sync polling cycle and ignores
 *      the daemon's resync signal.
 *
 * Part 1 is the unit test for the parser/dispatch behavior (already
 * covered by v2-sse-consumer.test.ts but reproduced here for F7
 * regression coverage). Part 2 is a structural source-grep that fails
 * if the callback is missing — this is the RED→GREEN gate for the F7
 * fix in electron/main.ts.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSseFrame, SseConsumer } from "../v2-sse-consumer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAIN_TS_PATH = join(__dirname, "..", "..", "main.ts");

describe("F7 — SseConsumer.onResyncRequired contract", () => {
  // ------------------------------------------------------------------
  // Part 1: parser/dispatch contract — SseConsumer must invoke the
  // callback on a `resync-required` SSE frame.
  // ------------------------------------------------------------------
  describe("dispatch", () => {
    let fetchImpl: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      fetchImpl = vi.fn();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("parses a resync-required frame with id:0 and empty data", () => {
      const parsed = parseSseFrame(
        "event: resync-required\nid: 0\ndata: {}\n\n",
      );
      expect(parsed).not.toBeNull();
      expect(parsed!.frame.event).toBe("resync-required");
      expect(parsed!.frame.id).toBe("0");
      expect(parsed!.frame.data).toBe("{}");
      expect(parsed!.rest).toBe("");
    });

    it("invokes onResyncRequired when the SSE frame arrives", async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              "event: resync-required\nid: 0\ndata: {}\n\n",
            ),
          );
          controller.close();
        },
      });
      fetchImpl.mockResolvedValueOnce(
        new Response(stream, { status: 200 }),
      );

      const onResyncRequired = vi.fn();
      const consumer = new SseConsumer({
        baseUrl: "http://127.0.0.1:1",
        onEvent: () => {},
        onResyncRequired,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      consumer.start();
      // Wait for the consumer to drain the frame.
      await new Promise((r) => setTimeout(r, 50));
      consumer.stop();

      expect(onResyncRequired).toHaveBeenCalledTimes(1);
    });
  });

  // ------------------------------------------------------------------
  // Part 2: wiring — electron/main.ts MUST construct SseConsumer with
  // an onResyncRequired callback that triggers fullResyncAfterDisconnect.
  // This is the F7 regression gate. If a future refactor drops the
  // callback, the daemon's resync signal will be silently swallowed
  // and the client falls back to the 30s polling cycle.
  // ------------------------------------------------------------------
  describe("electron/main.ts wiring", () => {
    it("passes a non-undefined onResyncRequired callback to SseConsumer", () => {
      const source = readFileSync(MAIN_TS_PATH, "utf-8");
      // Locate the SseConsumer constructor block in main.ts. We accept
      // any indentation/whitespace and the exact property name. The
      // callback may be an arrow function or method shorthand.
      const optsMatch = source.match(
        /new\s+SseConsumer\s*\(\s*\{([\s\S]*?)\}\s*\)/,
      );
      expect(
        optsMatch,
        "electron/main.ts does not contain a `new SseConsumer({...})` block",
      ).not.toBeNull();
      const optsBody = optsMatch![1]!;
      // The opts block must reference `onResyncRequired:` as a property.
      expect(
        optsBody,
        "SseConsumer opts must declare `onResyncRequired:` — without it the daemon's resync-required SSE frame is silently swallowed and the client falls back to 30s polling",
      ).toMatch(/onResyncRequired\s*:/);
      // The handler must invoke fullResyncAfterDisconnect so the §5.3
      // recovery path actually runs (not just log.warn).
      expect(
        optsBody,
        "onResyncRequired handler must call fullResyncAfterDisconnect (新架构 §7.3 + §5.3)",
      ).toMatch(/fullResyncAfterDisconnect/);
    });
  });
});