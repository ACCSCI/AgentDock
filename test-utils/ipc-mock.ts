/**
 * IPC Mock — invokeIpc helper for testing ipcMain.handle handlers.
 *
 * Phase 0: Scaffold. Real implementation lands in Phase 4 when IPC handlers
 * are extracted. The mock maintains its own registry so integration tests
 * can register handlers and invoke them without a real Electron app.
 *
 * Usage (Phase 4+):
 *   import { ipcMainMock, invokeIpc, onIpcEvent } from "test-utils/ipc-mock";
 *
 *   ipcMainMock.handle("sessions:create", async (event, params) => { ... });
 *   const result = await invokeIpc("sessions:create", params);
 *   onIpcEvent("session:abc:event", (data) => { ... });
 */

type Handler = (event: MockEvent, ...args: unknown[]) => unknown | Promise<unknown>;

interface MockEvent {
  sender: MockSender;
}

interface MockSender {
  send: (channel: string, ...args: unknown[]) => void;
}

const handlerRegistry = new Map<string, Handler>();
const eventListeners = new Map<string, Array<(...args: unknown[]) => void>>();

export const ipcMainMock = {
  handle(channel: string, handler: Handler): void {
    handlerRegistry.set(channel, handler);
  },
  getHandler(channel: string): Handler {
    const h = handlerRegistry.get(channel);
    if (!h) throw new Error(`No handler registered for channel "${channel}"`);
    return h;
  },
  clear(): void {
    handlerRegistry.clear();
    eventListeners.clear();
  },
};

export function invokeIpc<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcMainMock.getHandler(channel)({ sender: mockSender }, ...args) as Promise<T>;
}

export function onIpcEvent(channel: string, cb: (...args: unknown[]) => void): () => void {
  if (!eventListeners.has(channel)) eventListeners.set(channel, []);
  eventListeners.get(channel)?.push(cb);
  return () => {
    const list = eventListeners.get(channel);
    if (!list) return;
    const idx = list.indexOf(cb);
    if (idx >= 0) list.splice(idx, 1);
  };
}

const mockSender: MockSender = {
  send: (channel: string, ...args: unknown[]) => {
    const listeners = eventListeners.get(channel);
    if (listeners) for (const l of listeners) l(...args);
  },
};
