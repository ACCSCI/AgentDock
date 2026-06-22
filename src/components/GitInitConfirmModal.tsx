import { useEffect } from "react";

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
    <div className="dir-modal-overlay" onClick={loading ? undefined : onCancel}>
      <div
        className="dir-modal git-init-modal"
        onClick={(e) => e.stopPropagation()}
        data-testid="git-init-modal"
      >
        <div className="dir-modal-header">
          <div className="dir-modal-header-left">
            <h3>不是 Git 仓库</h3>
          </div>
          <button
            type="button"
            className="dir-modal-close"
            onClick={onCancel}
            disabled={loading}
          >
            ✕
          </button>
        </div>

        <div className="git-init-description">
          <p>
            选择的目录 <strong>{dirPath}</strong> 不是一个 Git 仓库。
          </p>
          <p>
            AgentDock 需要 Git 来管理项目会话（worktree）。
            是否自动执行 <code>git init</code>？
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
            取消
          </button>
          <button
            type="button"
            className="dir-modal-btn dir-modal-btn-confirm"
            onClick={onConfirm}
            disabled={loading}
            data-testid="git-init-confirm"
          >
            {loading ? "初始化中..." : "git init"}
          </button>
        </div>
      </div>
    </div>
  );
}
