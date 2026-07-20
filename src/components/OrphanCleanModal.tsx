import { Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "../i18n/react";
import { type OrphanDir, useDeleteOrphans, useOrphans } from "../lib/queries";
import { useStore } from "../lib/store";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";

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
  const { t } = useTranslation("modals");
  const { activeProjectId } = useStore();
  const { data: orphans, isLoading, error, refetch } = useOrphans(open ? activeProjectId : null);
  const deleteOrphans = useDeleteOrphans();

  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Reset selection when modal opens or data changes
  useEffect(() => {
    if (open) setSelected(new Set());
  }, [open, orphans]);

  if (!open) return null;

  const orphanList = orphans ?? [];
  const allSelected = orphanList.length > 0 && orphanList.every((o) => selected.has(orphanKey(o)));

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
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="max-w-2xl gap-0 p-0" data-testid="orphan-modal">
        <DialogHeader className="border-b border-border p-5">
          <DialogTitle className="flex items-center gap-2">
            <Sparkles aria-hidden="true" className="size-4 text-primary" />
            {t("orphanClean.title")}
          </DialogTitle>
          <DialogDescription>{t("orphanClean.description")}</DialogDescription>
        </DialogHeader>

        {/* Select all — above the list */}
        {orphanList.length > 0 && (
          <div className="flex items-center justify-between border-b border-border px-4 py-2 text-xs">
            <label className="flex cursor-pointer items-center gap-1.5 text-muted-foreground">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleAll}
                data-testid="orphan-select-all"
              />
              全选 ({orphanList.length})
            </label>
            <span className="text-[11px] text-muted-foreground" data-testid="orphan-selected-count">
              已选 {selected.size}
            </span>
          </div>
        )}

        {/* Orphan list */}
        <div className="max-h-80 min-h-40 flex-1 overflow-y-auto py-1">
          {isLoading && (
            <div className="px-4 py-6 text-center text-[13px] text-muted-foreground">扫描中...</div>
          )}
          {error && (
            <div className="px-4 py-6 text-center text-[13px] text-destructive">{error.message}</div>
          )}
          {!isLoading && !error && orphanList.length === 0 && (
            <div className="px-4 py-6 text-center text-sm text-success">✓ 没有孤儿目录</div>
          )}
          {!isLoading &&
            !error &&
            orphanList.map((orphan) => {
              const key = orphanKey(orphan);
              const isSelected = selected.has(key);
              // For branches, show the branch name; for dirs, the sessionId.
              const displayName =
                orphan.reason === "orphan-branch"
                  ? (orphan.branch ?? orphan.sessionId)
                  : orphan.sessionId;
              return (
                <label
                  key={key}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 border border-transparent px-4 py-2 text-[13px] transition-colors hover:bg-secondary",
                    isSelected && "border-primary bg-primary/5",
                  )}
                  data-testid="orphan-item"
                  data-orphan-key={key}
                  data-orphan-reason={orphan.reason}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleSelect(orphan)}
                  />
                  <span className="flex-1 truncate">{displayName}</span>
                  <span className="shrink-0 rounded-sm bg-muted px-1.5 py-px text-[11px] text-muted-foreground">
                    {REASON_LABELS[orphan.reason]}
                  </span>
                </label>
              );
            })}
        </div>

        {/* Actions */}
        <div className="flex shrink-0 justify-end gap-2 border-t border-border px-4 py-3">
          <Button type="button" variant="outline" onClick={onClose}>
            {t("orphanClean.cancel")}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={selected.size === 0 || deleteOrphans.isPending}
            onClick={handleDelete}
            data-testid="orphan-delete-selected"
          >
            {deleteOrphans.isPending
              ? t("loading", { ns: "common" })
              : `${t("orphanClean.clean")} (${selected.size})`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
