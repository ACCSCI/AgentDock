import { AlertTriangle, ChevronDown, ChevronRight } from "lucide-react";
import { useCallback, useState } from "react";
import { type HookError, useHookErrors, useRetryHook } from "../lib/queries";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";

interface HookErrorModalProps {
  sessionId: string;
  onClose: () => void;
}

function ErrorCard({ error, index }: { error: HookError; index: number }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="overflow-hidden rounded-sm border border-border">
      <button
        type="button"
        className="flex w-full cursor-pointer items-center gap-2 bg-secondary px-3 py-2.5 text-left text-[13px] text-foreground transition-colors hover:bg-muted"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="w-3 shrink-0 text-center text-muted-foreground">
          {expanded ? (
            <ChevronDown aria-hidden="true" className="size-3" />
          ) : (
            <ChevronRight aria-hidden="true" className="size-3" />
          )}
        </span>
        <span className="shrink-0 text-muted-foreground">{index + 1}.</span>
        <code className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[13px] text-foreground">
          {error.run}
        </code>
        <Badge variant="destructive" className="shrink-0">
          {error.timedOut
            ? "⏱ 超时"
            : error.exitCode !== null && error.exitCode !== undefined
              ? `exit ${error.exitCode}`
              : "失败"}
        </Badge>
      </button>
      {expanded && (
        <div className="flex flex-col gap-2 border-t border-border bg-background p-3">
          {error.error && (
            <div>
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Error
              </div>
              <pre className="m-0 max-h-[200px] overflow-x-auto whitespace-pre-wrap break-all rounded-sm bg-popover p-2.5 font-mono text-xs leading-normal text-popover-foreground">
                {error.error}
              </pre>
            </div>
          )}
          {error.stderr && (
            <div>
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                stderr
              </div>
              <pre className="m-0 max-h-[200px] overflow-x-auto whitespace-pre-wrap break-all rounded-sm bg-destructive-bg p-2.5 font-mono text-xs leading-normal text-destructive-text">
                {error.stderr}
              </pre>
            </div>
          )}
          {error.stdout && (
            <div>
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                stdout
              </div>
              <pre className="m-0 max-h-[200px] overflow-x-auto whitespace-pre-wrap break-all rounded-sm bg-popover p-2.5 font-mono text-xs leading-normal text-popover-foreground">
                {error.stdout}
              </pre>
            </div>
          )}
          {!error.stderr && !error.stdout && !error.error && (
            <div className="py-2 text-[13px] italic text-muted-foreground">（无输出）</div>
          )}
        </div>
      )}
    </div>
  );
}

function ErrorSkeleton() {
  return (
    <div className="hook-error-modal-skeleton">
      <div className="hook-error-modal-skeleton-line" />
      <div className="hook-error-modal-skeleton-line" />
      <div className="hook-error-modal-skeleton-line" />
    </div>
  );
}

export function HookErrorModal({ sessionId, onClose }: HookErrorModalProps) {
  const { data: errors, isLoading, isError } = useHookErrors(sessionId);
  const retryMutation = useRetryHook();
  const [retrying, setRetrying] = useState(false);

  const handleRetry = useCallback(async () => {
    setRetrying(true);
    try {
      await retryMutation.mutateAsync(sessionId);
      onClose();
    } catch {
      setRetrying(false);
    }
  }, [sessionId, retryMutation, onClose]);

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="max-w-3xl gap-0 p-0">
        <DialogHeader className="border-b border-border p-5">
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle aria-hidden="true" className="size-4 text-destructive" />
            环境初始化失败
          </DialogTitle>
          <DialogDescription>查看失败钩子的输出，修复后可以重新运行。</DialogDescription>
        </DialogHeader>

        <div className="hook-error-modal-body">
          {isLoading && <ErrorSkeleton />}

          {isError && <div className="hook-error-status">加载失败，请重试</div>}

          {!isLoading && !isError && (!errors || errors.length === 0) && (
            <div className="hook-error-status">没有错误记录（可能在重试中）</div>
          )}

          {!isLoading && !isError && errors && errors.length > 0 && (
            <>
              <p className="hook-error-summary">
                以下 <strong>{errors.length}</strong> 个钩子执行出错：
              </p>
              <div className="hook-error-list">
                {errors.map((err, i) => (
                  <ErrorCard key={`${err.run}-${err.exitCode}-${i}`} error={err} index={i} />
                ))}
              </div>
            </>
          )}
        </div>

        <div className="hook-error-modal-footer">
          <Button type="button" variant="outline" onClick={onClose}>
            关闭
          </Button>
          <Button
            type="button"
            className="hook-error-btn hook-error-btn-retry"
            onClick={handleRetry}
            disabled={retrying}
          >
            {retrying ? "重试中..." : "重试所有失败钩子"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
