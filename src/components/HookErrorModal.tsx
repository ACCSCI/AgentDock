import { useCallback, useState } from "react";
import { useHookErrors, useRetryHook, type HookError } from "../lib/queries";

interface HookErrorModalProps {
  sessionId: string;
  onClose: () => void;
}

function ErrorCard({ error, index }: { error: HookError; index: number }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={`hook-error-card ${expanded ? "hook-error-card-expanded" : ""}`}>
      <button
        type="button"
        className="hook-error-card-header"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="hook-error-card-arrow">{expanded ? "▼" : "▶"}</span>
        <span className="hook-error-card-index">{index + 1}.</span>
        <code className="hook-error-card-command">{error.run}</code>
        <span className="hook-error-card-exit">
          {error.timedOut ? "⏱ 超时" : error.exitCode !== null && error.exitCode !== undefined ? `exit ${error.exitCode}` : "失败"}
        </span>
      </button>
      {expanded && (
        <div className="hook-error-card-body">
          {error.error && (
            <div className="hook-error-section">
              <div className="hook-error-section-label">Error</div>
              <pre className="hook-error-pre">{error.error}</pre>
            </div>
          )}
          {error.stderr && (
            <div className="hook-error-section">
              <div className="hook-error-section-label">stderr</div>
              <pre className="hook-error-pre hook-error-pre-stderr">{error.stderr}</pre>
            </div>
          )}
          {error.stdout && (
            <div className="hook-error-section">
              <div className="hook-error-section-label">stdout</div>
              <pre className="hook-error-pre">{error.stdout}</pre>
            </div>
          )}
          {!error.stderr && !error.stdout && !error.error && (
            <div className="hook-error-empty">（无输出）</div>
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
    <div className="hook-error-overlay" onClick={onClose}>
      <div className="hook-error-modal" onClick={(e) => e.stopPropagation()}>
        <div className="hook-error-modal-header">
          <h3>⚠ 环境初始化失败</h3>
          <button type="button" className="hook-error-modal-close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="hook-error-modal-body">
          {isLoading && <ErrorSkeleton />}

          {isError && (
            <div className="hook-error-status">加载失败，请重试</div>
          )}

          {!isLoading && !isError && (!errors || errors.length === 0) && (
            <div className="hook-error-status">
              没有错误记录（可能在重试中）
            </div>
          )}

          {!isLoading && !isError && errors && errors.length > 0 && (
            <>
              <p className="hook-error-summary">
                以下 <strong>{errors.length}</strong> 个钩子执行出错：
              </p>
              <div className="hook-error-list">
                {errors.map((err, i) => (
                  <ErrorCard key={i} error={err} index={i} />
                ))}
              </div>
            </>
          )}
        </div>

        <div className="hook-error-modal-footer">
          <button type="button" className="hook-error-btn hook-error-btn-close" onClick={onClose}>
            关闭
          </button>
          <button
            type="button"
            className="hook-error-btn hook-error-btn-retry"
            onClick={handleRetry}
            disabled={retrying}
          >
            {retrying ? "重试中..." : "重试所有失败钩子"}
          </button>
        </div>
      </div>
    </div>
  );
}
