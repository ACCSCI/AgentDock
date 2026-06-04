import { createServer } from "node:net";

const PORT_RANGE_START = 20000;
const PORT_RANGE_END = 65535;

/**
 * Check if a port is available by attempting to bind to it.
 */
export async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

/**
 * Allocate `count` unique available ports not already in the registry.
 * Scans sequentially from PORT_RANGE_START.
 */
export async function allocatePorts(
  count: number,
  registry: Set<number>,
): Promise<number[]> {
  const allocated: number[] = [];

  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
    if (allocated.length >= count) break;
    if (registry.has(port)) continue;

    // Check both registry and actual availability
    if (await isPortAvailable(port)) {
      allocated.push(port);
    }
  }

  if (allocated.length < count) {
    throw new Error(
      `Could not allocate ${count} ports (only found ${allocated.length} available)`,
    );
  }

  return allocated;
}

/**
 * Remove ports from the registry set.
 */
export function releasePorts(ports: number[], registry: Set<number>): void {
  for (const port of ports) {
    registry.delete(port);
  }
}
