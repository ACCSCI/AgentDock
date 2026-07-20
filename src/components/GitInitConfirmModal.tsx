import { GitBranch } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";

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
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !loading) onCancel();
      }}
    >
      <AlertDialogContent
        data-testid="git-init-modal"
        onEscapeKeyDown={(event) => {
          if (loading) event.preventDefault();
        }}
      >
        <AlertDialogHeader>
          <div className="flex size-9 items-center justify-center rounded-full bg-primary/10 text-primary">
            <GitBranch aria-hidden="true" className="size-4" />
          </div>
          <AlertDialogTitle>初始化 Git 仓库</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>选择的目录不是 Git 仓库。AgentDock 需要 Git 管理隔离的工作会话。</p>
              <code className="block max-h-20 overflow-auto rounded-md bg-muted px-3 py-2 font-mono text-xs text-foreground">
                {dirPath}
              </code>
              <p>
                继续后将自动执行 <code className="font-mono text-foreground">git init</code>。
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={loading} data-testid="git-init-cancel">
            取消
          </AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm} disabled={loading} data-testid="git-init-confirm">
            {loading ? "正在初始化…" : "初始化仓库"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
