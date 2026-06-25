import { useEffect } from "react";
import { useTranslation } from "../i18n/react";

interface ConfirmDeleteModalProps {
  open: boolean;
  sessionName: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDeleteModal({
  open,
  sessionName,
  onConfirm,
  onCancel,
}: ConfirmDeleteModalProps) {
  const { t } = useTranslation("modals");
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div className="dir-modal-overlay" onClick={onCancel}>
      <div
        className="dir-modal git-init-modal"
        onClick={(e) => e.stopPropagation()}
        data-testid="confirm-delete-modal"
      >
        <div className="dir-modal-header">
          <div className="dir-modal-header-left">
            <h3>{t("confirmDelete.title")}</h3>
          </div>
          <button
            type="button"
            className="dir-modal-close"
            onClick={onCancel}
          >
            ✕
          </button>
        </div>

        <div className="git-init-description">
          <p>
            {t("confirmDelete.message", { name: sessionName })}
          </p>
          <p>{t("confirmDelete.consequence")}</p>
        </div>

        <div className="dir-modal-actions">
          <button
            type="button"
            className="dir-modal-btn dir-modal-btn-cancel"
            onClick={onCancel}
            data-testid="confirm-delete-cancel"
          >
            {t("confirmDelete.cancel")}
          </button>
          <button
            type="button"
            className="dir-modal-btn dir-modal-btn-confirm dir-modal-btn-danger"
            onClick={onConfirm}
            data-testid="confirm-delete-ok"
          >
            {t("confirmDelete.delete")}
          </button>
        </div>
      </div>
    </div>
  );
}
