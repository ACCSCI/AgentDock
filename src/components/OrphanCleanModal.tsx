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

/** A stable key per orphan item — uses worktreePath for dirs and branch for branches. */
function orphanKey(o: OrphanDir): string {
  return o.reason === "orphan-branch" ? `branch:${o.branch}` : `dir:${o.worktreePath}`;
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
  const allSelected = orphanList.length > 0 && orphanList.every((o) => selected.has(orphanKey(o)));

  const toggleSelect = (key: string) => {
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
    // Split selected items by type so the API can route correctly.
    const paths: string[] = [];
    const branches: string[] = [];
    for (const o of orphanList) {
      if (!selected.has(orphanKey(o))) continue;
      if (o.reason === "orphan-branch") {
        if (o.branch) branches.push(o.branch);
      } else if (o.worktreePath) {
        paths.push(o.worktreePath);
      }
    }
    if (paths.length === 0 && branches.length === 0) return;
    try {
      const result = await deleteOrphans.mutateAsync({
        paths,
        branches,
        projectId: activeProjectId ?? undefined,
      });
      if (result.failed.length > 0) {
        alert(`删除完成：${result.deleted.length} 成功，${result.failed.length} 失败`);
      }
      setSelected(new Set());
      refetch();
    } catch (err) {
      alert(`删除失败: ${err instanceof Error ? err.message : "未知错误"}`);
    }
  };

  return (
    <div className="dir-modal-overlay" onClick={onClose}>
      <div className="dir-modal orphan-modal" onClick={(e) => e.stopPropagation()}>
        <div className="dir-modal-header">
          <div className="dir-modal-header-left">
            <h3>🧹 清理孤儿</h3>
          </div>
          <button type="button" className="dir-modal-close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="orphan-description">
          以下条目是已删除 session 残留的目录或分支，可以安全删除。
        </div>

        {/* Select all — above the list */}
        {orphanList.length > 0 && (
          <div className="orphan-toolbar">
            <label className="orphan-select-all">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleAll}
              />
              全选 ({orphanList.length})
            </label>
            <span className="orphan-count">已选 {selected.size}</span>
          </div>
        )}

        {/* Orphan list */}
        <div className="dir-modal-list orphan-list">
          {isLoading && <div className="dir-modal-status">扫描中...</div>}
          {error && <div className="dir-modal-status dir-modal-error">{error.message}</div>}
          {!isLoading && !error && orphanList.length === 0 && (
            <div className="dir-modal-status orphan-empty">✓ 没有孤儿</div>
          )}
          {!isLoading && !error && orphanList.map((orphan) => {
            const key = orphanKey(orphan);
            return (
              <div
                key={key}
                className={`orphan-item ${selected.has(key) ? "orphan-item-selected" : ""}`}
                onClick={() => toggleSelect(key)}
              >
                <input
                  type="checkbox"
                  checked={selected.has(key)}
                  onChange={() => toggleSelect(key)}
                  onClick={(e) => e.stopPropagation()}
                />
                <span className="orphan-name">
                  {orphan.reason === "orphan-branch" ? orphan.branch : orphan.sessionId}
                </span>
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
          >
            {deleteOrphans.isPending ? "删除中..." : `删除选中 (${selected.size})`}
          </button>
        </div>
      </div>
    </div>
  );
}
