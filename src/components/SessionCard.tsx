import { useCallback, useEffect, useRef, useState } from "react";
import { isCreatingSession, isDeletingSession, isBackgroundHookRunning, isBackgroundHookFailed, useBackgroundHookStatus, type CreatingSession, type DeletingSession, type SessionData, type SessionListItem, type SessionStep } from "../lib/queries";

const CREATE_STEP_LABELS: Record<string, string> = {
  beforeCreateSession: "前置检查",
  createWorktree: "创建工作区",
  syncResources: "同步资源",
  allocatePorts: "分配端口",
  afterCreateSession: "初始化环境",
};

const DELETE_STEP_LABELS: Record<string, string> = {
  beforeDeleteSession: "前置检查",
  releasePorts: "释放端口",
  removeWorktree: "清理工作区",
  afterDeleteSession: "后置清理",
};

function StepIcon({ status }: { status: SessionStep["status"] }) {
  if (status === "done") return <span className="step-icon step-icon-done">✓</span>;
  if (status === "error") return <span className="step-icon step-icon-error">✗</span>;
  return (
    <span className="step-icon step-icon-running">
      <span className="step-spinner" />
    </span>
  );
}

function LifecycleSteps({
  steps,
  stepOrder,
  labels,
}: { steps: SessionStep[]; stepOrder: string[]; labels: Record<string, string> }) {
  const stepMap = new Map(steps.map((s) => [s.step, s]));
  return (
    <div className="creating-steps">
      {stepOrder.map((stepName) => {
        const step = stepMap.get(stepName);
        if (!step && stepMap.size === 0) return null;
        const label = labels[stepName] ?? stepName;
        return (
          <div key={stepName} className="step-item">
            {step ? (
              <StepIcon status={step.status} />
            ) : (
              <span className="step-icon step-icon-pending">○</span>
            )}
            <span className="step-label">{label}</span>
            {step?.duration != null && step.duration > 0 && (
              <span className="step-duration">{step.duration}ms</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

interface SessionCardProps {
  session: SessionListItem;
  isActive: boolean;
  onSelect: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
  onRename: (sessionId: string, newName: string) => void;
  onOpenInExplorer: (worktreePath: string) => void;
  onReassignPorts: (sessionId: string) => void;
  onRetryHooks: (sessionId: string) => void;
  onHover?: (sessionId: string) => void;
}

export function SessionCard({
  session,
  isActive,
  onSelect,
  onDelete,
  onRename,
  onOpenInExplorer,
  onReassignPorts,
  onRetryHooks,
  onHover,
}: SessionCardProps) {
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(session.name);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLDivElement>(null);

  // Poll the background hook status while an async afterCreateSession hook
  // (e.g. `bun install`) is still running. The create SSE stream closes as soon
  // as the async hook starts, so polling is how the card learns the hook
  // finished and can leave the "环境初始化中" state. The hook writes the
  // terminal status back into the projects cache itself.
  useBackgroundHookStatus(session.id, isBackgroundHookRunning(session));

  useEffect(() => {
    if (!menuPos) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuPos(null);
      }
    };
    window.addEventListener("mousedown", handleClick);
    return () => window.removeEventListener("mousedown", handleClick);
  }, [menuPos]);

  // Cancel delete confirmation on click-outside or Escape
  useEffect(() => {
    if (!confirmingDelete) return;
    const handleClick = (e: MouseEvent) => {
      if (confirmRef.current && !confirmRef.current.contains(e.target as Node)) {
        setConfirmingDelete(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setConfirmingDelete(false);
    };
    window.addEventListener("mousedown", handleClick);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("mousedown", handleClick);
      window.removeEventListener("keydown", handleKey);
    };
  }, [confirmingDelete]);

  // Clamp context menu position to viewport
  useEffect(() => {
    if (!menuPos || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const x = Math.min(menuPos.x, window.innerWidth - rect.width - 4);
    const y = Math.min(menuPos.y, window.innerHeight - rect.height - 4);
    menuRef.current.style.left = `${Math.max(0, x)}px`;
    menuRef.current.style.top = `${Math.max(0, y)}px`;
  }, [menuPos]);

  // Sync editValue with session.name when not editing
  useEffect(() => {
    if (!editing) {
      setEditValue(session.name);
    }
  }, [session.name, editing]);

  // Reset delete confirmation when card becomes inactive
  useEffect(() => {
    if (!isActive) {
      setConfirmingDelete(false);
    }
  }, [isActive]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenuPos({ x: e.clientX, y: e.clientY });
  }, []);

  const handleStartRename = useCallback(() => {
    setMenuPos(null);
    setConfirmingDelete(false);
    setEditValue(session.name);
    setEditing(true);
  }, [session.name]);

  const handleConfirmRename = useCallback(() => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== session.name) {
      onRename(session.id, trimmed);
    }
    setEditing(false);
  }, [editValue, session.name, session.id, onRename]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        handleConfirmRename();
      } else if (e.key === "Escape") {
        setEditing(false);
      }
    },
    [handleConfirmRename],
  );

  const handleOpenInExplorer = useCallback(() => {
    setMenuPos(null);
    onOpenInExplorer(session.worktreePath);
  }, [session.worktreePath, onOpenInExplorer]);

  const handleDelete = useCallback(() => {
    setMenuPos(null);
    setEditing(false);
    setConfirmingDelete(true);
  }, []);

  const handleReassignPorts = useCallback(() => {
    setMenuPos(null);
    onReassignPorts(session.id);
  }, [session.id, onReassignPorts]);

  const isForeign = session.status === "foreign";
  const statusLabel = session.status === "reclaimed"
    ? "Recovered"
    : session.status === "allocated"
      ? "Ports refreshed"
      : session.status === "foreign"
        ? "Foreign"
        : null;
  const foreignTitle = session.ownerClientId
    ? `This session is currently managed by another AgentDock instance (${session.ownerClientId}).`
    : "This session is currently managed by another AgentDock instance.";

  // Creating state — show spinner + steps, no interaction
  if (isCreatingSession(session)) {
    const creating = session as CreatingSession;
    return (
      <div className="session-card session-card-creating">
        <div className="session-card-header">
          <span className="step-spinner" />
          <span className="session-name">{creating.name}</span>
        </div>
        <LifecycleSteps steps={creating.steps} stepOrder={["beforeCreateSession", "createWorktree", "syncResources", "allocatePorts", "afterCreateSession"]} labels={CREATE_STEP_LABELS} />
      </div>
    );
  }

  // Deleting state — show spinner + steps, no interaction
  if (isDeletingSession(session)) {
    const deleting = session as DeletingSession;
    return (
      <div className="session-card session-card-deleting">
        <div className="session-card-header">
          <span className="step-spinner" />
          <span className="session-name">{deleting.name}</span>
        </div>
        <LifecycleSteps steps={deleting.steps} stepOrder={["beforeDeleteSession", "releasePorts", "removeWorktree", "afterDeleteSession"]} labels={DELETE_STEP_LABELS} />
      </div>
    );
  }

  // Failed state — async background hook failed, show warning + retry button
  if (isBackgroundHookFailed(session)) {
    return (
      <div className="session-card session-card-failed">
        <div className="session-card-header">
          <span className="failed-icon">⚠</span>
          <span className="session-name">{session.name}</span>
        </div>
        <div className="failed-hint">环境初始化失败</div>
        <button
          type="button"
          className="failed-retry-btn"
          onClick={(e) => { e.stopPropagation(); onRetryHooks(session.id); }}
        >
          重试
        </button>
      </div>
    );
  }

  // Foreign state — visible but intentionally not interactive
  if (isForeign) {
    return (
      <div className="session-card session-card-foreign" title={foreignTitle}>
        <span className="session-name">{session.name}</span>
        <div className="session-card-meta">
          {session.ports && <span className="session-ports">:{session.ports.FRONTEND_PORT}</span>}
          {statusLabel && <span className="session-status-badge session-status-badge-foreign">{statusLabel}</span>}
        </div>
      </div>
    );
  }

  return (
    <>
      <div
        className={`session-card ${isActive ? "session-card-active" : ""}`}
        onClick={() => onSelect(session.id)}
        onMouseEnter={() => onHover?.(session.id)}
        onContextMenu={handleContextMenu}
        onDoubleClick={session.canRename === false ? undefined : handleStartRename}
        onKeyDown={(e) => e.key === "Enter" && onSelect(session.id)}
        tabIndex={0}
        role="button"
        aria-pressed={isActive}
      >
        {editing ? (
          <input
            ref={inputRef}
            className="session-rename-input"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={handleConfirmRename}
            onKeyDown={handleKeyDown}
          />
        ) : (
          <span className="session-name">{session.name}</span>
        )}
        {session.ports && (
          <span
            className="session-ports"
            title={`FRONTEND:${session.ports.FRONTEND_PORT} BACKEND:${session.ports.BACKEND_PORT} WS:${session.ports.WS_PORT} DEBUG:${session.ports.DEBUG_PORT} PREVIEW:${session.ports.PREVIEW_PORT}`}
          >
            :{session.ports.FRONTEND_PORT}
          </span>
        )}
        {statusLabel && session.status !== "foreign" && (
          <span className={`session-status-badge session-status-badge-${session.status}`}>{statusLabel}</span>
        )}
        {confirmingDelete ? (
          <div ref={confirmRef} className="session-delete-confirm" onClick={(e) => e.stopPropagation()}>
            <span className="session-delete-confirm-text">确认删除?</span>
            <button
              type="button"
              className="session-delete-confirm-btn session-delete-confirm-yes"
              onClick={(e) => {
                e.stopPropagation();
                setConfirmingDelete(false);
                onDelete(session.id);
              }}
              title="确认删除"
            >
              ✓
            </button>
            <button
              type="button"
              className="session-delete-confirm-btn session-delete-confirm-no"
              onClick={(e) => {
                e.stopPropagation();
                setConfirmingDelete(false);
              }}
              title="取消"
            >
              ✕
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="session-close"
            onClick={(e) => {
              e.stopPropagation();
              setConfirmingDelete(true);
            }}
          >
            ✕
          </button>
        )}
      </div>

      {menuPos && session.canRename !== false && session.canDelete !== false && session.canReassign !== false && (
        <div ref={menuRef} className="context-menu" style={{ left: menuPos.x, top: menuPos.y }}>
          <button type="button" className="context-menu-item" onClick={handleStartRename}>
            重命名
          </button>
          <button type="button" className="context-menu-item" onClick={handleOpenInExplorer}>
            在文件管理器中打开
          </button>
          <button type="button" className="context-menu-item" onClick={handleReassignPorts}>
            重新分配端口
          </button>
          <div className="context-menu-separator" />
          <button
            type="button"
            className="context-menu-item context-menu-danger"
            onClick={handleDelete}
          >
            删除
          </button>
        </div>
      )}
    </>
  );
}
