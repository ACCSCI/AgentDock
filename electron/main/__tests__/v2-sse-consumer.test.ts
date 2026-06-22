/**
 * v2 SSE Consumer — unit tests (P9 — 新架构 §7.3).
 *
 * Exercises the SSE wire-format parser and the consumer's reconnect +
 * event-fan-out behavior using a fake fetch. The fake fetch returns
 * a Response with a ReadableStream that yields chunked bytes — same
 * shape Hono's streamSSE emits.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSseFrame, SseConsumer } from "../v2-sse-consumer.js";

describe("parseSseFrame", () => {
  it("parses a single event with event/id/data fields", () => {
    const input = "event: session-created\nid: 7\ndata: {\"sessionId\":\"s1\"}\n\n";
    const parsed = parseSseFrame(input);
    expect(parsed).not.toBeNull();
    expect(parsed!.frame.event).toBe("session-created");
    expect(parsed!.frame.id).toBe("7");
    expect(parsed!.frame.data).toBe('{"sessionId":"s1"}');
    expect(parsed!.rest).toBe("");
  });

  it("returns null when no \\n\\n boundary is present", () => {
    expect(parseSseFrame("event: foo\ndata: bar\n")).toBeNull();
  });

  it("preserves trailing data after the boundary", () => {
    const input = "event: a\nid: 1\ndata: hi\n\nevent: b\nid: 2\ndata: yo\n\n";
    const first = parseSseFrame(input);
    expect(first).not.toBeNull();
    expect(first!.frame.event).toBe("a");
    const second = parseSseFrame(first!.rest);
    expect(second).not.toBeNull();
    expect(second!.frame.event).toBe("b");
    expect(second!.rest).toBe("");
  });

  it("ignores comment lines starting with ':'", () => {
    const input = ": keep-alive\nevent: ping\nid: 5\ndata: ok\n\n";
    const parsed = parseSseFrame(input);
    expect(parsed!.frame.event).toBe("ping");
    expect(parsed!.frame.id).toBe("5");
  });

  it("uses 'message' as default event name when none specified", () => {
    const input = "id: 1\ndata: hello\n\n";
    const parsed = parseSseFrame(input);
    expect(parsed!.frame.event).toBe("message");
    expect(parsed!.frame.data).toBe("hello");
  });
});

interface FakeStreamChunk {
  /** Bytes to deliver. enqueue()ed one at a time per `value` chunk. */
  value: string;
  done?: boolean;
}

function makeFakeResponse(chunks: FakeStreamChunk[], status = 200): Response {
  const encoder = new TextEncoder();
  let idx = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (idx >= chunks.length) {
        controller.close();
        return;
      }
      const c = chunks[idx++]!;
      if (c.done) {
        controller.close();
      } else {
        controller.enqueue(encoder.encode(c.value));
      }
    },
  });
  return new Response(stream, { status });
}

describe("SseConsumer", () => {
  let fetchImpl: ReturnType<typeof vi.fn>;
  let abortControllers: AbortController[];

  beforeEach(() => {
    abortControllers = [];
    fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      // Capture the AbortController so the test can simulate disconnect.
      const signal = init?.signal as AbortSignal | undefined;
      // No-op mock — tests override fetchImpl per case via mockResolvedValueOnce.
      return makeFakeResponse([{ value: "data: stub\n\n", done: true }]);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fans events out to multiple subscribers", async () => {
    const consumer = new SseConsumer({
      baseUrl: "http://127.0.0.1:9999",
      onEvent: () => {},
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const a = vi.fn();
    const b = vi.fn();
    consumer.subscribe(a);
    consumer.subscribe(b);

    // Dispatch via the internal fan-out by simulating an inbound SSE
    // event through a controlled response.
    fetchImpl.mockResolvedValueOnce(
      makeFakeResponse([
        { value: "event: session-created\nid: 1\ndata: {\"sid\":\"s\"}\n\n" },
        // Hold the connection open without closing — the consumer will
        // keep reading. We close it manually below.
        { value: "" },
        { value: "event: port-released\nid: 2\ndata: {\"port\":30001}\n\n" },
        { value: "", done: true },
      ]),
    );
    consumer.start();
    // Wait for the consumer to receive both events.
    await new Promise((resolve) => setTimeout(resolve, 50));
    consumer.stop();

    expect(a).toHaveBeenCalled();
    expect(b).toHaveBeenCalled();
    const aCalls = a.mock.calls.map((c) => c[0]);
    expect(aCalls.map((p) => p.event)).toEqual(
      expect.arrayContaining(["session-created", "port-released"]),
    );
  });

  it("sends Last-Event-ID on reconnect when lastSeq > 0", async () => {
    const headersByCall: Array<Record<string, string>> = [];
    fetchImpl.mockImplementation(async (_input, init) => {
      const h = (init?.headers ?? {}) as Record<string, string>;
      headersByCall.push(h);
      // First call: deliver one event + close.
      if (headersByCall.length === 1) {
        return makeFakeResponse([
          { value: "event: hello\nid: 10\ndata: {}\n\n" },
          { value: "", done: true },
        ]);
      }
      // Second call: hold open.
      return makeFakeResponse([{ value: "", done: true }]);
    });

    const consumer = new SseConsumer({
      baseUrl: "http://127.0.0.1:9999",
      onEvent: () => {},
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    vi.useFakeTimers({ shouldAdvanceTime: false });
    consumer.start();
    await vi.advanceTimersByTimeAsync(50);
    expect(headersByCall.length).toBeGreaterThanOrEqual(1);
    expect(headersByCall[0]?.["Last-Event-ID"]).toBeUndefined();

    // Wait for reconnect timer to fire (500ms backoff).
    await vi.advanceTimersByTimeAsync(700);
    expect(headersByCall.length).toBeGreaterThanOrEqual(2);
    expect(headersByCall[1]?.["Last-Event-ID"]).toBe("10");
    consumer.stop();
    vi.useRealTimers();
  });

  it("triggers onResyncRequired when the daemon emits resync-required", async () => {
    const onResync = vi.fn();
    fetchImpl.mockResolvedValueOnce(
      makeFakeResponse([
        { value: "event: resync-required\nid: 0\ndata: {\"reason\":\"buffer-overflow\"}\n\n" },
        { value: "", done: true },
      ]),
    );
    const consumer = new SseConsumer({
      baseUrl: "http://127.0.0.1:9999",
      onEvent: () => {},
      onResyncRequired: onResync,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    consumer.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(onResync).toHaveBeenCalled();
    consumer.stop();
  });

  // §5.3 — 断线立即触发 onDisconnect (host: fetch /sync, 重新 claim)
  it("triggers onDisconnect when the connection is lost (新架构 §5.3)", async () => {
    const onDisconnect = vi.fn();
    const onReconnect = vi.fn();
    // First connect succeeds with a hello event; second connect (after
    // backoff) succeeds again with a different hello.
    fetchImpl
      .mockResolvedValueOnce(
        makeFakeResponse([
          { value: "event: hello\nid: 1\ndata: {\"seq\":1}\n\n" },
          // Close the stream to simulate a network drop.
          { value: "", done: true },
        ]),
      )
      .mockResolvedValueOnce(
        makeFakeResponse([
          { value: "event: hello\nid: 1\ndata: {\"seq\":1}\n\n" },
          { value: "", done: true },
        ]),
      );
    const consumer = new SseConsumer({
      baseUrl: "http://127.0.0.1:9999",
      onEvent: () => {},
      onDisconnect,
      onReconnect,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    consumer.start();
    // Wait for the first connection to close + onDisconnect to fire.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    consumer.stop();
  });
});