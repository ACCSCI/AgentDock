// Lightweight pub/sub toast bus — no React dependency.
export type ToastKind = "info" | "success" | "error" | "warn";

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  /** Auto-dismiss after this many ms. 0 = manual dismiss only. */
  duration: number;
}

type Listener = (toasts: Toast[]) => void;

let _id = 0;
let _toasts: Toast[] = [];
const _listeners = new Set<Listener>();

const notify = () => {
  const list = Array.from(_listeners);
  for (const fn of list) fn([..._toasts]);
};

export const subscribe = (fn: Listener): (() => void) => {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
};

/** Current snapshot (for initial render). */
export const snapshot = (): Toast[] => _toasts;

const add = (kind: ToastKind, message: string, duration: number) => {
  const toast: Toast = { id: ++_id, kind, message, duration };
  _toasts = [..._toasts, toast];
  notify();

  if (duration > 0) {
    setTimeout(() => dismiss(toast.id), duration);
  }
  return toast.id;
};

export const toast = {
  info: (msg: string, duration = 4000) => add("info", msg, duration),
  success: (msg: string, duration = 3000) => add("success", msg, duration),
  error: (msg: string, duration = 6000) => add("error", msg, duration),
  warn: (msg: string, duration = 5000) => add("warn", msg, duration),
};

export const dismiss = (id: number) => {
  _toasts = _toasts.filter((t) => t.id !== id);
  notify();
};
