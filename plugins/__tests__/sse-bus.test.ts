/**
 * SSE event bus — 新架构 §7.3 unit tests.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { SSE_REPLAY_BUFFER } from "../constants.js";
import { SseBus } from "../sse-bus.js";

let bus: SseBus;

beforeEach(() => {
  bus = new SseBus();
});

describe("publish()", () => {
  it("assigns monotonically increasing seq", () => {
    const e1 = bus.publish("session-created", { sessionId: "a" });
    const e2 = bus.publish("session-created", { sessionId: "b" });
    const e3 = bus.publish("session-purged", { sessionId: "c" });
    expect(e2.seq).toBe(e1.seq + 1);
    expect(e3.seq).toBe(e2.seq + 1);
  });

  it("includes timestamp and payload", () => {
    const e = bus.publish("port-reassigned", { port: 3000, newPort: 3001 });
    expect(e.ts).toBeGreaterThan(0);
    expect(e.event).toBe("port-reassigned");
    expect(e.data.port).toBe(3000);
  });

  it("respects caller-provided seq (for synthetic replay events)", () => {
    const e = bus.publish("heartbeat", {}, 999);
    expect(e.seq).toBe(999);
  });
});

describe("subscribe()", () => {
  it("delivers events to subscribers", () => {
    const received: number[] = [];
    bus.subscribe((e) => received.push(e.seq));
    bus.publish("session-created", {});
    bus.publish("session-purged", {});
    expect(received).toEqual([1, 2]);
  });

  it("unsubscribe stops delivery", () => {
    const received: number[] = [];
    const unsub = bus.subscribe((e) => received.push(e.seq));
    bus.publish("session-created", {});
    unsub();
    bus.publish("session-purged", {});
    expect(received).toEqual([1]);
  });

  it("subscriberCount reflects active subscribers", () => {
    expect(bus.subscriberCount()).toBe(0);
    const u1 = bus.subscribe(() => {});
    expect(bus.subscriberCount()).toBe(1);
    const u2 = bus.subscribe(() => {});
    expect(bus.subscriberCount()).toBe(2);
    u1();
    expect(bus.subscriberCount()).toBe(1);
    u2();
    expect(bus.subscriberCount()).toBe(0);
  });

  it("subscriber errors don't break the bus", () => {
    const log: string[] = [];
    bus.subscribe(() => {
      throw new Error("boom");
    });
    bus.subscribe((e) => log.push(`ok-${e.seq}`));
    bus.publish("session-created", {});
    expect(log).toEqual(["ok-1"]);
  });
});

describe("replaySince() — §7.3 lastEvent-ID semantics", () => {
  it("returns events after lastEventId when in buffer", () => {
    bus.publish("session-created", { id: "a" });
    bus.publish("session-created", { id: "b" });
    bus.publish("session-purged", { id: "c" });

    const replay = bus.replaySince(1);
    expect(replay).not.toBeNull();
    expect(replay?.map((e) => e.seq)).toEqual([2, 3]);
  });

  it("returns empty array when all events already ack'd", () => {
    bus.publish("session-created", {});
    const replay = bus.replaySince(1);
    expect(replay).toEqual([]);
  });

  it("returns all events when lastEventId=0", () => {
    bus.publish("a", {});
    bus.publish("b", {});
    const replay = bus.replaySince(0);
    expect(replay?.length).toBe(2);
  });

  it("returns null when lastEventId is before the buffer (overflowed)", () => {
    // Fill the buffer beyond SSE_REPLAY_BUFFER
    for (let i = 0; i < SSE_REPLAY_BUFFER + 5; i++) {
      bus.publish("session-created", { i });
    }
    // The earliest event is now at seq 6 (5 dropped)
    const replay = bus.replaySince(1);
    expect(replay).toBeNull();
  });

  it("ring buffer caps at SSE_REPLAY_BUFFER", () => {
    for (let i = 0; i < SSE_REPLAY_BUFFER + 100; i++) {
      bus.publish("session-created", { i });
    }
    expect(bus.snapshot().length).toBe(SSE_REPLAY_BUFFER);
  });
});

describe("snapshot / reset", () => {
  it("snapshot returns copy of buffer", () => {
    bus.publish("a", {});
    bus.publish("b", {});
    const snap = bus.snapshot();
    expect(snap.length).toBe(2);
    // Mutating snap shouldn't affect bus
    snap.push();
  });

  it("reset clears buffer and seq", () => {
    bus.publish("a", {});
    bus.reset();
    expect(bus.lastSeq()).toBe(0);
    expect(bus.snapshot()).toEqual([]);
  });
});
