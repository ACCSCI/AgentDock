import { useEffect } from "react";
import { useTranslation } from "react-i18next";

interface GitInitConfirmModalProps {
  open: boolean;
  dirPath: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** When true, the confirm button shows a loading state and is disabled. */
  loading?: boolean;
}

/**
 * Confirmation modal for initializing a Git repository in a non-git directory.
 *
 * Reuses the `dir-modal-overlay` / `dir-modal` shell so it visually matches
 * DirBrowserModal and OrphanCleanModal. Escape and click-outside cancel.
 */
export function GitInitConfirmModal({
  open,
  dirPath,
  onConfirm,
  onCancel,
  loading = false,
}: GitInitConfirmModalProps) {
  const { t } = useTranslation("home");
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !loading) onCancel();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onCancel, loading]);

  if (!open) return null;

  return (
    <div
      className="dir-modal-overlay"
      onMouseDown={(event) => {
        if (!loading && event.target === event.currentTarget) onCancel();
      }}
    >
      <div className="dir-modal git-init-modal" data-testid="git-init-modal">
        <div className="dir-modal-header">
          <div className="dir-modal-header-left">
            <h3>{t("notGitRepository")}</h3>
          </div>
          <button
            type="button"
            className="dir-modal-close"
            onClick={onCancel}
            disabled={loading}
            aria-label={t("close")}
          >
            ✕
          </button>
        </div>

        <div className="git-init-description">
          <p>{t("notGitRepositoryDescription", { path: dirPath })}</p>
          <p>
            {t("gitRequiredDescription")} <code>git init</code>?
          </p>
        </div>

        <div className="dir-modal-actions">
          <button
            type="button"
            className="dir-modal-btn dir-modal-btn-cancel"
            onClick={onCancel}
            disabled={loading}
            data-testid="git-init-cancel"
          >
            {t("cancel")}
          </button>
          <button
            type="button"
            className="dir-modal-btn dir-modal-btn-confirm"
            onClick={onConfirm}
            disabled={loading}
            data-testid="git-init-confirm"
          >
            {loading ? t("initializingGit") : "git init"}
          </button>
        </div>
      </div>
    </div>
  );
}
