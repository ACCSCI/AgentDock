import { useSyncExternalStore } from "react";
import { useTranslation } from "../i18n/react";
import { type Toast as T, dismiss, snapshot, subscribe } from "../lib/toast";

const ICON: Record<T["kind"], string> = {
  info: "ℹ",
  success: "✓",
  error: "✕",
  warn: "⚠",
};

function ToastItem({ toast }: { toast: T }) {
  const { t } = useTranslation("common");
  return (
    <div className={`toast-item toast-${toast.kind}`}>
      <span className="toast-icon">{ICON[toast.kind]}</span>
      <span className="toast-message">{toast.message}</span>
      <button
        type="button"
        className="toast-close"
        onClick={() => dismiss(toast.id)}
        aria-label={t("close")}
      >
        ×
      </button>
    </div>
  );
}

export function ToastContainer() {
  const toasts = useSyncExternalStore(subscribe, snapshot);

  // Hide when empty — no wrapper div rendered at all.
  if (toasts.length === 0) return null;

  return (
    <div className="toast-container">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>
  );
}
