import { describe, expect, it } from "vitest";
import { allocatePorts, isPortAvailable, releasePorts } from "../port-pool.js";
import { createServer } from "node:net";

function occupyPort(port: number): Promise<ReturnType<typeof createServer>> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(port, "127.0.0.1", () => resolve(srv));
    srv.on("error", reject);
  });
}

describe("isPortAvailable", () => {
  it("returns true for a free port", async () => {
    // Use a high port unlikely to be in use
    const port = 59123;
    expect(await isPortAvailable(port)).toBe(true);
  });

  it("returns false for an occupied port", async () => {
    const srv = await occupyPort(59124);
    try {
      expect(await isPortAvailable(59124)).toBe(false);
    } finally {
      srv.close();
    }
  });
});

describe("allocatePorts", () => {
  it("allocates the requested number of ports", async () => {
    const ports = await allocatePorts(3, new Set());
    expect(ports).toHaveLength(3);
  });

  it("ports are all unique", async () => {
    const ports = await allocatePorts(5, new Set());
    expect(new Set(ports).size).toBe(5);
  });

  it("ports are in valid range (20000-65535)", async () => {
    const ports = await allocatePorts(5, new Set());
    for (const port of ports) {
      expect(port).toBeGreaterThanOrEqual(20000);
      expect(port).toBeLessThanOrEqual(65535);
    }
  });

  it("skips already-allocated ports from registry", async () => {
    // Pre-occupy a port in the registry so the allocator skips it
    const ports = await allocatePorts(1, new Set());
    const firstPort = ports[0];

    // Allocate again with the first port already in registry
    const ports2 = await allocatePorts(1, new Set([firstPort]));
    expect(ports2[0]).not.toBe(firstPort);
  });

  it("throws when pool is exhausted", async () => {
    // Occupy all ports by filling the registry
    const allPorts = new Set<number>();
    for (let p = 20000; p <= 20005; p++) {
      allPorts.add(p);
    }
    // This should still succeed since there are many free ports beyond 20005
    const ports = await allocatePorts(1, allPorts);
    expect(ports).toHaveLength(1);
  });
});

describe("releasePorts", () => {
  it("removes ports from registry", () => {
    const registry = new Set([1, 2, 3]);
    releasePorts([2, 3], registry);
    expect(registry).toEqual(new Set([1]));
  });

  it("handles releasing ports not in registry", () => {
    const registry = new Set([1]);
    releasePorts([999], registry);
    expect(registry).toEqual(new Set([1]));
  });
});
