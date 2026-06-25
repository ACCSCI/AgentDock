import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { MAX_BINDINGS_PER_ACTION } from "../lib/store";
import type { ShortcutAction } from "../lib/store";
import { useStore } from "../lib/store";
import { useKeyCapture } from "../hooks/useKeyCapture";
import { useTranslation } from "../i18n/react";
import { setLanguage, SUPPORTED_LANGUAGES, type SupportedLanguage } from "../i18n";

// Surface for window.api (exposed by preload.ts via contextBridge).
// Mirrors the inline declarations in components/CustomTitleBar.tsx and
// components/DaemonStatusBar.tsx — each consumer file declares just the
// slice it uses rather than pulling in the full ApiSurface.
interface UpdateInfo {
  version?: string;
}

type CheckForUpdatesResult =
  | { status: "dev-mode" }
  | { status: "checking" }
  | { status: "available"; info: { version: string } }
  | { status: "not-available"; info: { version: string } }
  | { status: "downloaded"; info: { version: string } }
  | { status: "error"; message: string };

declare global {
  interface Window {
    api: {
      updates: {
        onChecking: (cb: () => void) => () => void;
        onAvailable: (cb: (info: UpdateInfo) => void) => () => void;
        onNotAvailable: (cb: (info: UpdateInfo) => void) => () => void;
        onDownloadProgress: (cb: (progress: { percent: number }) => void) => () => void;
        onDownloaded: (cb: (info: UpdateInfo) => void) => () => void;
        onError: (cb: (err: { message: string }) => void) => () => void;
      };
      app: {
        version: () => Promise<{ version: string; isPackaged: boolean }>;
        checkForUpdates: () => Promise<CheckForUpdatesResult>;
        quitAndInstall: () => Promise<{ ok: boolean }>;
      };
    };
  }
}

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
});

interface ShortcutRowProps {
  action: ShortcutAction;
  label: string;
}

function ShortcutRow({ action, label }: ShortcutRowProps) {
  const { t } = useTranslation("settings");
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
              title={t("removeShortcut")}
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
            {isCapturing ? t("capturePrompt") : t("addShortcut")}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Possible states the update flow can be in. Modeled as a discriminated
 * union so the UI can pick a single source of truth — we either
 * trust the one-shot `checkForUpdates` reply, or one of the streamed
 * events from the updater (which can arrive after the reply).
 */
type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "dev-mode" }
  | { kind: "up-to-date"; version: string }
  | { kind: "available"; version: string; percent: number }
  | { kind: "downloaded"; version: string }
  | { kind: "error"; message: string };

interface VersionInfo {
  version: string;
  isPackaged: boolean;
}

function VersionSection() {
  const { t } = useTranslation("settings");
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null);
  // Keep the latest "available" version separate from state — the
  // state machine can transition available → available with a higher
  // percent without losing the version label.
  const [state, setState] = useState<UpdateState>({ kind: "idle" });

  // Fetch the version on mount. window.api is absent in pure-browser
  // contexts (vite preview, E2E with no Electron); guard with optional
  // chaining — the section still renders with a "未知" placeholder.
  useEffect(() => {
    const api = window.api;
    if (!api?.app?.version) return;
    api.app
      .version()
      .then(setVersionInfo)
      .catch(() => setVersionInfo(null));
  }, []);

  // Subscribe to streamed updater events. The listeners are the
  // authoritative source for percent and "downloaded" — the one-shot
  // `checkForUpdates` reply is just an initial nudge.
  useEffect(() => {
    const api = window.api;
    if (!api?.updates) return;
    const unsubs = [
      api.updates.onChecking(() => setState({ kind: "checking" })),
      api.updates.onNotAvailable((info: UpdateInfo) => {
        const v = info?.version ?? versionInfo?.version ?? "";
        setState({ kind: "up-to-date", version: v });
      }),
      api.updates.onAvailable((info: UpdateInfo) => {
        const v = info?.version ?? "";
        setState((prev) =>
          prev.kind === "available"
            ? { kind: "available", version: v, percent: prev.percent }
            : { kind: "available", version: v, percent: 0 },
        );
      }),
      api.updates.onDownloadProgress((progress: { percent: number }) => {
        setState((prev) =>
          prev.kind === "available"
            ? { kind: "available", version: prev.version, percent: progress.percent }
            : prev,
        );
      }),
      api.updates.onDownloaded((info: UpdateInfo) => {
        const v = info?.version ?? "";
        setState({ kind: "downloaded", version: v });
      }),
      api.updates.onError((err: { message: string }) => setState({ kind: "error", message: err.message })),
    ];
    return () => {
      for (const off of unsubs) {
        try {
          off();
        } catch {
          /* ignore — best-effort cleanup */
        }
      }
    };
  }, [versionInfo?.version]);

  const triggerCheck = useCallback(async () => {
    const api = window.api;
    if (!api?.app?.checkForUpdates) return;
    setState({ kind: "checking" });
    try {
      const result = await api.app.checkForUpdates();
      // The event listeners will overwrite this for every state except
      // dev-mode / synchronous error, but we mirror the synchronous
      // result here so the UI doesn't sit on "checking…" forever if no
      // event fires (e.g. no network).
      if (result.status === "dev-mode") {
        setState({ kind: "dev-mode" });
      } else if (result.status === "error") {
        setState({ kind: "error", message: result.message });
      } else if (result.status === "not-available") {
        setState({ kind: "up-to-date", version: result.info.version });
      } else if (result.status === "available") {
        setState((prev) =>
          prev.kind === "available"
            ? prev
            : { kind: "available", version: result.info.version, percent: 0 },
        );
      } else if (result.status === "downloaded") {
        setState({ kind: "downloaded", version: result.info.version });
      }
      // "checking" — leave state as-is, the event stream will update.
    } catch (err) {
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  const triggerInstall = useCallback(async () => {
    const api = window.api;
    if (!api?.app?.quitAndInstall) return;
    try {
      await api.app.quitAndInstall();
    } catch (err) {
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  const versionLabel = versionInfo ? `v${versionInfo.version}` : t("versionUnknown");
  const isPackaged = versionInfo?.isPackaged ?? false;

  return (
    <div className="settings-version-block" data-testid="settings-version-block">
      <div className="settings-version-row">
        <span className="settings-version-label">{t("currentVersion")}</span>
        <span className="settings-version-value">{versionLabel}</span>
      </div>
      <div className="settings-version-status" data-testid="settings-version-status">
        <UpdateStatusText state={state} versionLabel={versionLabel} isPackaged={isPackaged} />
      </div>
      <div className="settings-version-actions">
        <button
          type="button"
          className="settings-version-check-btn"
          onClick={triggerCheck}
          disabled={!isPackaged || state.kind === "checking"}
          data-testid="settings-version-check-btn"
        >
          {state.kind === "checking" ? t("checkingButton") : t("checkForUpdates")}
        </button>
        {state.kind === "downloaded" && isPackaged && (
          <button
            type="button"
            className="settings-version-install-btn"
            onClick={triggerInstall}
            data-testid="settings-version-install-btn"
          >
            {t("installNow")}
          </button>
        )}
      </div>
    </div>
  );
}

function UpdateStatusText({
  state,
  versionLabel,
  isPackaged,
}: {
  state: UpdateState;
  versionLabel: string;
  isPackaged: boolean;
}) {
  const { t } = useTranslation("settings");
  if (!isPackaged) {
    return <span className="settings-version-hint">{t("devModeHint")}</span>;
  }
  switch (state.kind) {
    case "idle":
      return <span className="settings-version-hint">{t("idleHint")}</span>;
    case "checking":
      return <span className="settings-version-hint">{t("checkingHint")}</span>;
    case "dev-mode":
      return <span className="settings-version-hint">{t("devModeHint")}</span>;
    case "up-to-date":
      return <span className="settings-version-ok">{t("upToDateLabel", { version: versionLabel })}</span>;
    case "available": {
      const pct = Math.max(0, Math.min(100, Math.round(state.percent)));
      return (
        <span className="settings-version-progress">
          {t("downloadingLabel", { version: state.version, percent: pct })}
        </span>
      );
    }
    case "downloaded":
      return <span className="settings-version-ok">{t("downloadedLabel", { version: state.version })}</span>;
    case "error":
      return <span className="settings-version-error">{t("errorLabel", { message: state.message })}</span>;
  }
}

function SettingsPage() {
  const { t, i18n } = useTranslation("settings");
  const router = useRouter();
  const { resetShortcuts } = useStore();
  const currentLang = i18n.language as SupportedLanguage;

  const handleLanguageChange = async (lang: SupportedLanguage) => {
    await setLanguage(lang);
  };

  return (
    <div className="settings-page" data-testid="settings-page">
      <div className="settings-header">
        <button
          type="button"
          className="settings-back-btn"
          onClick={() => router.history.back()}
          title={t("back", { ns: "common" })}
        >
          ← {t("back", { ns: "common" })}
        </button>
        <h2 className="settings-title">{t("language")}</h2>
      </div>

      <div className="settings-section">
        <h3 className="settings-section-title">{t("language")}</h3>
        <div className="settings-language-options">
          {SUPPORTED_LANGUAGES.map((lang) => (
            <button
              key={lang.value}
              type="button"
              className={`settings-language-btn ${currentLang === lang.value ? "active" : ""}`}
              onClick={() => handleLanguageChange(lang.value)}
            >
              {lang.label}
            </button>
          ))}
        </div>
      </div>

      <div className="settings-section">
        <h3 className="settings-section-title">{t("version")}</h3>
        <VersionSection />
      </div>

      <div className="settings-section">
        <h3 className="settings-section-title">{t("shortcuts", { ns: "settings" })}</h3>
        <ShortcutRow action="dirSearchFocus" label={t("focusDirSearch", { ns: "settings" })} />
      </div>

      <div className="settings-footer">
        <button
          type="button"
          className="settings-reset-btn"
          onClick={resetShortcuts}
        >
          {t("resetDefault", { ns: "settings" })}
        </button>
      </div>
    </div>
  );
}
