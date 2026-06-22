import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { MAX_BINDINGS_PER_ACTION } from "../lib/store";
import type { ShortcutAction } from "../lib/store";
import { useStore } from "../lib/store";
import { useKeyCapture } from "../hooks/useKeyCapture";

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
});

interface ShortcutRowProps {
  action: ShortcutAction;
  label: string;
}

function ShortcutRow({ action, label }: ShortcutRowProps) {
  const { shortcuts, updateShortcut } = useStore();
  const bindings = shortcuts[action] ?? [];

  const { startCapture, isCapturing } = useKeyCapture((combo) => {
    // Guard against duplicates.
    if (bindings.includes(combo)) return;
    updateShortcut(action, [...bindings, combo]);
  });

  const removeKey = (key: string) => {
    updateShortcut(action, bindings.filter((k) => k !== key));
  };

  return (
    <div className="settings-shortcut-row">
      <span className="settings-shortcut-label">{label}</span>
      <div className="settings-shortcut-keys">
        {bindings.map((key) => (
          <span key={key} className="settings-shortcut-badge">
            {key}
            <button
              type="button"
              className="settings-shortcut-badge-remove"
              onClick={() => removeKey(key)}
              disabled={bindings.length <= 1}
              title="移除此快捷键"
            >
              ×
            </button>
          </span>
        ))}
        {bindings.length < MAX_BINDINGS_PER_ACTION && (
          <button
            type="button"
            className="settings-shortcut-add"
            onClick={startCapture}
            disabled={isCapturing}
          >
            {isCapturing ? "请按下快捷键…" : "+ 添加"}
          </button>
        )}
      </div>
    </div>
  );
}

function SettingsPage() {
  const navigate = useNavigate();
  const { resetShortcuts } = useStore();

  return (
    <div className="settings-page" data-testid="settings-page" data-shortcut-passthrough>
      <div className="settings-header">
        <button
          type="button"
          className="settings-back-btn"
          onClick={() => navigate({ to: "/" })}
          title="返回"
        >
          ← 返回
        </button>
        <h2 className="settings-title">设置</h2>
      </div>

      <div className="settings-section">
        <h3 className="settings-section-title">快捷键</h3>
        <ShortcutRow action="dirSearchFocus" label="聚焦目录搜索栏" />
      </div>

      <div className="settings-footer">
        <button
          type="button"
          className="settings-reset-btn"
          onClick={resetShortcuts}
        >
          恢复默认
        </button>
      </div>
    </div>
  );
}
