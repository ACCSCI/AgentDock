import { PoolPortAllocator, isPortAvailable } from "./port-allocator.js";
import type { PortAllocator } from "./port-allocator.js";

export type { PortAllocator } from "./port-allocator.js";
export { isPortAvailable };

let _allocator: PortAllocator = new PoolPortAllocator();

/**
 * Get the current port allocator.
 */
export function getPortAllocator(): PortAllocator {
  return _allocator;
}

/**
 * Replace the port allocator at runtime.
 * Used to switch from PoolPortAllocator to DaemonClient.
 */
export function setPortAllocator(allocator: PortAllocator): void {
  _allocator = allocator;
}

/**
 * Allocate `count` unique available ports not already in the registry.
 * Uses the current allocator (PoolPortAllocator or DaemonClient).
 */
export async function allocatePorts(
  count: number,
  registry: Set<number>,
): Promise<number[]> {
  return _allocator.allocate(count, registry);
}

/**
 * Remove ports from the registry set.
 */
export function releasePorts(ports: number[], registry: Set<number>): void {
  for (const port of ports) {
    registry.delete(port);
  }
}
