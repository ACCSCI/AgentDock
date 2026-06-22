import { createContext, useContext, useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { useStore } from "../lib/store";
import type { ShortcutAction } from "../lib/store";

/**
 * Global shortcut system.
 *
 * Architecture:
 * - ShortcutsProvider registers a single `keydown` listener on `document`.
 * - Components register/unregister handlers via useShortcutAction(action, handler, enabled).
 * - When a key is pressed, the provider:
 *     1. Skips when the user is typing in an input/textarea/contenteditable.
 *     2. Formats the event into a normalized combo string (e.g. "Alt+d").
 *     3. Iterates all registered actions; for each action whose `enabled=true`,
 *        checks if the store's binding list includes the combo. The first match
 *        wins and dispatches its handler. e.preventDefault() is called to
 *        suppress browser defaults (e.g. Alt+d focusing the address bar).
 *
 * Why this design:
 * - One global keydown listener, not N (cheap).
 * - Each action supports multiple handler registrations (stored as an array)
 *   so that multiple components can safely register/unregister independently.
 * - The store is the single source of truth for the binding list, so changes
 *   in the Settings page take effect on the next key press without re-binding.
 */

type ShortcutHandler = (e: KeyboardEvent) => void;

interface RegisteredHandler {
  handler: ShortcutHandler;
  enabled: boolean;
}

interface ShortcutsContextValue {
  register: (action: ShortcutAction, handler: ShortcutHandler, enabled: boolean) => void;
}

const ShortcutsContext = createContext<ShortcutsContextValue | null>(null);

/**
 * Convert a KeyboardEvent into a normalized combo string.
 *
 * Examples:
 *   Alt+d         → "Alt+d"
 *   Ctrl+Shift+k  → "Ctrl+Shift+k"
 *   "/"           → "/"
 *   plain letter  → "a" (lowercased)
 *
 * On macOS, Alt (Option) remaps `e.key` to special characters (e.g. Alt+d → "∂").
 * When Alt is held, we use `e.code` (e.g. "KeyD") to recover the intended letter,
 * ensuring cross-platform and cross-layout compatibility.
 *
 * Modifier keys pressed alone (Alt, Shift, Ctrl, Meta) return "" — the
 * caller should ignore empty combos.
 */
export function formatKeyCombo(
  e: KeyboardEvent | { key: string; code?: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean },
): string {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Meta");

  const k = e.key;
  // Ignore pure modifier presses.
  if (k === "Control" || k === "Alt" || k === "Shift" || k === "Meta") {
    return "";
  }

  // Resolve the intended letter key:
  // - On macOS, Alt+letter produces special chars (e.g. "∂"). Use e.code
  //   to recover the physical key ("KeyD" → "d").
  // - On other platforms, use e.key directly.
  let normalized: string;
  if (k.length === 1) {
    if (e.altKey && "code" in e && e.code && e.code.startsWith("Key")) {
      normalized = e.code.slice(3).toLowerCase();
    } else {
      normalized = k === k.toUpperCase() && /[A-Z]/.test(k) ? k.toLowerCase() : k;
    }
  } else {
    normalized = k;
  }
  parts.push(normalized);
  return parts.join("+");
}

export function ShortcutsProvider({ children }: { children: ReactNode }) {
  // Each action maps to an array of handler registrations, supporting multiple
  // components registering the same action safely (no overwrite on re-register,
  // and unmount only disables its own registration).
  const registryRef = useRef<Map<ShortcutAction, RegisteredHandler[]>>(new Map());

  // Mirror the current binding list into a ref so the listener (set up once)
  // always sees the latest bindings without needing to re-attach.
  const { shortcuts } = useStore();
  const shortcutsRef = useRef(shortcuts);
  shortcutsRef.current = shortcuts;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't capture while the user is typing in a text input/textarea/contenteditable.
      const active = document.activeElement as HTMLElement | null;
      if (active) {
        const tag = active.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || active.isContentEditable) return;
      }

      const combo = formatKeyCombo(e);
      if (!combo) return;

      const bindings = shortcutsRef.current;
      for (const [action, handlers] of registryRef.current) {
        const list = bindings[action] ?? [];
        if (!list.includes(combo)) continue;
        // Find the first enabled handler for this action and invoke it.
        const entry = handlers.find((h) => h.enabled);
        if (entry) {
          e.preventDefault();
          entry.handler(e);
          return;
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  const register = (action: ShortcutAction, handler: ShortcutHandler, enabled: boolean) => {
    const list = registryRef.current.get(action) ?? [];
    // Check if this exact handler reference is already registered.
    const idx = list.findIndex((h) => h.handler === handler);
    if (idx >= 0) {
      // Update in place.
      list[idx] = { handler, enabled };
    } else {
      list.push({ handler, enabled });
    }
    registryRef.current.set(action, list);
  };

  return (
    <ShortcutsContext.Provider value={{ register }}>
      {children}
    </ShortcutsContext.Provider>
  );
}

/**
 * Register a handler for a shortcut action. Re-registers whenever the
 * `enabled` flag flips, and disables on unmount.
 */
export function useShortcutAction(
  action: ShortcutAction,
  handler: ShortcutHandler,
  enabled: boolean = true,
): void {
  const ctx = useContext(ShortcutsContext);
  // Use a ref for the handler so the registry always calls the latest closure
  // without requiring the effect to re-run on every render.
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!ctx) return;
    const dispatch: ShortcutHandler = (e) => handlerRef.current(e);
    ctx.register(action, dispatch, enabled);
    return () => {
      ctx.register(action, dispatch, false);
    };
  }, [ctx, action, enabled]);
}
