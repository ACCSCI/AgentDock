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
 *     1. Skips when the user is typing in an input/textarea/contenteditable
 *        (unless `data-shortcut-passthrough` is set on an ancestor).
 *     2. Formats the event into a normalized combo string (e.g. "Alt+d").
 *     3. Iterates all registered actions; for each action whose `enabled=true`,
 *        checks if the store's binding list includes the combo. The first match
 *        wins and dispatches its handler.
 *
 * Why this design:
 * - One global keydown listener, not N (cheap).
 * - Components fully own their activation lifecycle via the `enabled` flag,
 *   so handlers don't need to know about the rest of the app.
 * - The store is the single source of truth for the binding list, so changes
 *   in the Settings page take effect on the next key press without re-binding.
 */

type ShortcutHandler = (e: KeyboardEvent) => void;

interface RegisteredAction {
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
 * Modifier keys pressed alone (Alt, Shift, Ctrl, Meta) return "" — the
 * caller should ignore empty combos.
 */
export function formatKeyCombo(
  e: KeyboardEvent | { key: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean },
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

  // Letters: normalize to lowercase for case-insensitive matching.
  // Other named keys (Arrow*, Enter, Escape, F1, /, etc.) keep their natural form.
  let normalized: string;
  if (k.length === 1) {
    normalized = k === k.toUpperCase() && /[A-Z]/.test(k) ? k.toLowerCase() : k;
  } else {
    normalized = k;
  }
  parts.push(normalized);
  return parts.join("+");
}

export function ShortcutsProvider({ children }: { children: ReactNode }) {
  // Use a ref so handler changes don't re-attach the global keydown listener.
  // The map is mutated in place; the listener always reads the latest.
  const registryRef = useRef<Map<ShortcutAction, RegisteredAction>>(new Map());

  // Mirror the current binding list into a ref so the listener (set up once)
  // always sees the latest bindings without needing to re-attach.
  const { shortcuts } = useStore();
  const shortcutsRef = useRef(shortcuts);
  shortcutsRef.current = shortcuts;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't capture while the user is typing in a text input/textarea/contenteditable,
      // unless the active element is inside a `data-shortcut-passthrough` container.
      const active = document.activeElement as HTMLElement | null;
      if (active) {
        const tag = active.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || active.isContentEditable) {
          if (!active.closest("[data-shortcut-passthrough]")) return;
        }
      }

      const combo = formatKeyCombo(e);
      if (!combo) return;

      const bindings = shortcutsRef.current;
      for (const [action, entry] of registryRef.current) {
        if (!entry.enabled) continue;
        const list = bindings[action] ?? [];
        if (list.includes(combo)) {
          entry.handler(e);
          return;
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  const register = (action: ShortcutAction, handler: ShortcutHandler, enabled: boolean) => {
    registryRef.current.set(action, { handler, enabled });
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
