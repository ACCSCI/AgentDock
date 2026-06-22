import { useEffect, useState } from "react";
import { type OrphanDir, useDeleteOrphans, useOrphans } from "../lib/queries";
import { useStore } from "../lib/store";

interface OrphanCleanModalProps {
  open: boolean;
  onClose: () => void;
}

const REASON_LABELS: Record<OrphanDir["reason"], string> = {
  "empty-dir": "空目录",
  "no-git-file": "无 .git 文件",
  "orphan-branch": "孤儿分支",
};

/**
 * Build a key that uniquely identifies an orphan regardless of type.
 *
 *   - dirs:     worktreePath (always non-empty)
 *   - branches: worktreePath is "", so use the branch name instead
 *
 * The old code used `worktreePath` for everything, which collapsed every
 * branch entry into a single empty-string key (user saw "全选 (2) 已选 1"
 * with two branch orphans selected).
 */
function orphanKey(o: OrphanDir): string {
  if (o.reason === "orphan-branch") {
    return `branch:${o.branch ?? o.sessionId}`;
  }
  return `path:${o.worktreePath}`;
}

export function OrphanCleanModal({ open, onClose }: OrphanCleanModalProps) {
  const { activeProjectId } = useStore();
  const { data: orphans, isLoading, error, refetch } = useOrphans(open ? activeProjectId : null);
  const deleteOrphans = useDeleteOrphans();

  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Reset selection when modal opens or data changes
  useEffect(() => {
    if (open) setSelected(new Set());
  }, [open, orphans]);

  // Keyboard: Escape to close
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const orphanList = orphans ?? [];
  const allSelected =
    orphanList.length > 0 && orphanList.every((o) => selected.has(orphanKey(o)));

  const toggleSelect = (o: OrphanDir) => {
    const key = orphanKey(o);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleAll = () => {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(orphanList.map(orphanKey)));
    }
  };

  const handleDelete = async () => {
    if (selected.size === 0) return;
    // Split the selection back into the body shape the handler expects:
    //   { paths: [...], branches: [...], projectId }
    // Without this split, every orphan-branch was sent as an empty path
    // string and the prefix validation in worktree-shell.ts rejected it
    // (user saw "0 成功, 1 失败" with no clue why).
    const paths: string[] = [];
    const branches: string[] = [];
    for (const o of orphanList) {
      if (!selected.has(orphanKey(o))) continue;
      if (o.reason === "orphan-branch") {
        if (o.branch) branches.push(o.branch);
      } else {
        if (o.worktreePath) paths.push(o.worktreePath);
      }
    }

    try {
      const result = await deleteOrphans.mutateAsync({
        paths,
        branches,
        projectId: activeProjectId ?? undefined,
      });
      if (result.failed.length > 0) {
        // Show the actual error per failure so the user can act on it
        // (permission denied, file in use, etc.) — the old alert just
        // said "N 失败" without explaining why.
        const lines = result.failed.map((f) => {
          const what = f.path ?? f.branch ?? "?";
          return `  · ${what} — ${f.error}`;
        });
        alert(
          `删除完成：${result.deleted.length} 成功，${result.failed.length} 失败\n\n失败详情:\n${lines.join("\n")}`,
        );
      }
      setSelected(new Set());
      refetch();
    } catch (err) {
      alert(`删除失败: ${err instanceof Error ? err.message : "未知错误"}`);
    }
  };

  return (
    <div className="dir-modal-overlay" onClick={onClose}>
      <div
        className="dir-modal orphan-modal"
        onClick={(e) => e.stopPropagation()}
        data-testid="orphan-modal"
      >
        <div className="dir-modal-header">
          <div className="dir-modal-header-left">
            <h3>🧹 清理孤儿目录</h3>
          </div>
          <button type="button" className="dir-modal-close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="orphan-description">
          以下条目存在于磁盘 / git 中但不属于任何活跃 session，可以安全删除。
        </div>

        {/* Select all — above the list */}
        {orphanList.length > 0 && (
          <div className="orphan-toolbar">
            <label className="orphan-select-all">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleAll}
                data-testid="orphan-select-all"
              />
              全选 ({orphanList.length})
            </label>
            <span className="orphan-count" data-testid="orphan-selected-count">
              已选 {selected.size}
            </span>
          </div>
        )}

        {/* Orphan list */}
        <div className="dir-modal-list orphan-list">
          {isLoading && <div className="dir-modal-status">扫描中...</div>}
          {error && <div className="dir-modal-status dir-modal-error">{error.message}</div>}
          {!isLoading && !error && orphanList.length === 0 && (
            <div className="dir-modal-status orphan-empty">✓ 没有孤儿目录</div>
          )}
          {!isLoading && !error && orphanList.map((orphan) => {
            const key = orphanKey(orphan);
            const isSelected = selected.has(key);
            // For branches, show the branch name; for dirs, the sessionId.
            const displayName =
              orphan.reason === "orphan-branch"
                ? (orphan.branch ?? orphan.sessionId)
                : orphan.sessionId;
            return (
              <div
                key={key}
                className={`orphan-item ${isSelected ? "orphan-item-selected" : ""}`}
                onClick={() => toggleSelect(orphan)}
                data-testid="orphan-item"
                data-orphan-key={key}
                data-orphan-reason={orphan.reason}
              >
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => toggleSelect(orphan)}
                  onClick={(e) => e.stopPropagation()}
                />
                <span className="orphan-name">{displayName}</span>
                <span className={`orphan-reason orphan-reason-${orphan.reason}`}>
                  {REASON_LABELS[orphan.reason]}
                </span>
              </div>
            );
          })}
        </div>

        {/* Actions */}
        <div className="dir-modal-actions">
          <button type="button" className="dir-modal-btn dir-modal-btn-cancel" onClick={onClose}>
            关闭
          </button>
          <button
            type="button"
            className="dir-modal-btn orphan-btn-delete"
            disabled={selected.size === 0 || deleteOrphans.isPending}
            onClick={handleDelete}
            data-testid="orphan-delete-selected"
          >
            {deleteOrphans.isPending ? "删除中..." : `删除选中 (${selected.size})`}
          </button>
        </div>
      </div>
    </div>
  );
}
