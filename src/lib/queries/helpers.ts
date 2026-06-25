/**
 * Shared helpers for React Query hooks.
 */

import type {} from "../../../electron"; // pulls in window.api type augmentation

// Query keys
export const queryKeys = {
  projects: ["projects"] as const,
  terminals: (sessionId: string) => ["terminals", sessionId] as const,
};

// Type-safe access to window.api (exposed by preload.ts via contextBridge).
declare global {
  interface Window {
    api: import("../../../electron/preload").ApiSurface;
  }
}

export function api() {
  if (!window.api) {
    throw new Error(
      "window.api is not available. Are you running outside Electron?",
    );
  }
  return window.api;
}
