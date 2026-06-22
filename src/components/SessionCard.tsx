import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import { FileText, ClipboardList, Wrench, Send, CheckCircle2 } from "lucide-react";
import { isCreatingSession, isDeletingSession, isBackgroundHookRunning, isBackgroundHookFailed, useBackgroundHookStatus, type CreatingSession, type DeletingSession, type SessionData, type SessionListItem, type SessionStep, type SessionUserStatus } from "../lib/queries";

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

// ── Session user-status definitions ────────────────────────────────
import type { LucideIcon } from "lucide-react";

const USER_STATUS_OPTIONS: Array<{
  key: SessionUserStatus;
  Icon: LucideIcon;
  label: string;
  color: string;
}> = [
  { key: "draft", Icon: FileText, label: "草稿", color: "#8B5CF6" },
  { key: "plan", Icon: ClipboardList, label: "规划中", color: "#3B82F6" },
  { key: "working", Icon: Wrench, label: "开发中", color: "#F59E0B" },
  { key: "pr", Icon: Send, label: "待合并", color: "#10B981" },
  { key: "done", Icon: CheckCircle2, label: "已完成", color: "#6B7280" },
];

const STATUS_COLOR_MAP: Record<SessionUserStatus, string> = Object.fromEntries(
  USER_STATUS_OPTIONS.map((o) => [o.key, o.color]),
) as Record<SessionUserStatus, string>;

const STATUS_ICON_MAP: Record<SessionUserStatus, LucideIcon> = Object.fromEntries(
  USER_STATUS_OPTIONS.map((o) => [o.key, o.Icon]),
) as Record<SessionUserStatus, LucideIcon>;

// ── Heat decay ─────────────────────────────────────────────────────
// Exponential decay: half-life = 24 hours.  Returns 0..1.
function computeHeat(lastActivatedAt: string | null | undefined): number {
  if (!lastActivatedAt) return 0;
  const ts = new Date(lastActivatedAt).getTime();
  if (Number.isNaN(ts)) return 0;
  const elapsed = Date.now() - ts;
  if (elapsed < 0) return 0;
  const HALF_LIFE = 5 * 60 * 1000; // 5 min → 30 min ≈ 0.016 (nearly invisible)
  return Math.pow(0.5, elapsed / HALF_LIFE);
}

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
  onOpenInTerminal: (worktreePath: string) => void;
  onReassignPorts: (sessionId: string) => void;
  onRetryHooks: (sessionId: string) => void;
  onSetUserStatus?: (sessionId: string, status: SessionUserStatus | null) => void;
  onActivate?: (sessionId: string) => void;
  onHover?: (sessionId: string) => void;
  onDragStart?: (sessionId: string) => void;
  onDragEnd?: () => void;
}

export function SessionCard({
  session,
  isActive,
  onSelect,
  onDelete,
  onRename,
  onOpenInExplorer,
  onOpenInTerminal,
  onReassignPorts,
  onRetryHooks,
  onSetUserStatus,
  onActivate,
  onHover,
  onDragStart,
  onDragEnd,
}: SessionCardProps) {
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [submenuPos, setSubmenuPos] = useState<{ x: number; y: number } | null>(null);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(session.name);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLDivElement>(null);

  // Heat value — recomputed every 10s via interval + on session data change
  const lastActivatedAt = "lastActivatedAt" in session ? (session as SessionData).lastActivatedAt : null;
  const [heat, setHeat] = useState(() => computeHeat(lastActivatedAt));

  useEffect(() => {
    // Immediate sync when data changes
    setHeat(computeHeat(lastActivatedAt));
    // Periodic decay
    const timer = setInterval(() => {
      setHeat(computeHeat(lastActivatedAt));
    }, 10_000);
    return () => clearInterval(timer);
  }, [lastActivatedAt]);

  const userStatus: SessionUserStatus | null | undefined =
    "userStatus" in session ? (session as SessionData).userStatus : null;
  const statusColor = userStatus ? STATUS_COLOR_MAP[userStatus] : null;
  const StatusIconComp = userStatus ? STATUS_ICON_MAP[userStatus] : null;

  // Poll the background hook status while an async afterCreateSession hook
  // (e.g. `bun install`) is still running. The create SSE stream closes as soon
  // as the async hook starts, so polling is how the card learns the hook
  // finished and can leave the "环境初始化中" state. The hook writes the
  // terminal status back into the projects cache itself.
  useBackgroundHookStatus(session.id, isBackgroundHookRunning(session));

  // ── Context menu close on click-outside ──────────────────────────
  useEffect(() => {
    if (!menuPos) return;
    const handleClick = (e: MouseEvent) => {
      const menuEl = menuRef.current;
      const subEl = submenuRef.current;
      const clickedInMenu = menuEl?.contains(e.target as Node) ?? false;
      const clickedInSub = subEl?.contains(e.target as Node) ?? false;
      if (!clickedInMenu && !clickedInSub) {
        setMenuPos(null);
        setSubmenuPos(null);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenuPos(null);
        setSubmenuPos(null);
      }
    };
    window.addEventListener("mousedown", handleClick);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("mousedown", handleClick);
      window.removeEventListener("keydown", handleKey);
    };
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

  // Clamp submenu position to viewport
  useEffect(() => {
    if (!submenuPos || !submenuRef.current) return;
    const rect = submenuRef.current.getBoundingClientRect();
    const x = Math.min(submenuPos.x, window.innerWidth - rect.width - 4);
    const y = Math.min(submenuPos.y, window.innerHeight - rect.height - 4);
    submenuRef.current.style.left = `${Math.max(0, x)}px`;
    submenuRef.current.style.top = `${Math.max(0, y)}px`;
  }, [submenuPos]);

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
    setSubmenuPos(null);
  }, []);

  const handleStartRename = useCallback(() => {
    setMenuPos(null);
    setSubmenuPos(null);
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
    setSubmenuPos(null);
    onOpenInExplorer(session.worktreePath);
  }, [session.worktreePath, onOpenInExplorer]);

  const handleOpenInTerminal = useCallback(() => {
    setMenuPos(null);
    setSubmenuPos(null);
    onOpenInTerminal(session.worktreePath);
  }, [session.worktreePath, onOpenInTerminal]);

  const handleDelete = useCallback(() => {
    setMenuPos(null);
    setSubmenuPos(null);
    setEditing(false);
    setConfirmingDelete(true);
  }, []);

  const handleReassignPorts = useCallback(() => {
    setMenuPos(null);
    setSubmenuPos(null);
    onReassignPorts(session.id);
  }, [session.id, onReassignPorts]);

  const handleSetUserStatus = useCallback(
    (status: SessionUserStatus | null) => {
      setMenuPos(null);
      setSubmenuPos(null);
      onSetUserStatus?.(session.id, status);
    },
    [session.id, onSetUserStatus],
  );

  const handleSelect = useCallback(() => {
    onSelect(session.id);
    onActivate?.(session.id);
  }, [session.id, onSelect, onActivate]);

  // Submenu positioning: show to the right of the parent item
  const handleSubmenuEnter = useCallback(
    (itemEl: HTMLElement) => {
      if (!menuPos) return;
      const rect = itemEl.getBoundingClientRect();
      setSubmenuPos({ x: rect.right + 2, y: rect.top });
    },
    [menuPos],
  );

  const isForeign = session.status === "foreign";
  const statusLabel = session.status === "foreign" ? "Foreign" : null;
  const foreignTitle = session.ownerClientId
    ? `This session is currently managed by another AgentDock instance (${session.ownerClientId}).`
    : "This session is currently managed by another AgentDock instance.";

  // ── Inline styles for heatmap overlay ──────────────────────────────
  const heatmapStyle = useMemo<React.CSSProperties>(() => {
    if (statusColor) {
      const opacity = Math.min(heat * 0.30, 0.30);
      return {
        "--session-status-color": statusColor,
        "--session-heat": opacity,
      } as React.CSSProperties;
    }
    // No status: white overlay to neutralize the pink base
    return {
      "--session-status-color": "#ffffff",
      "--session-heat": 0.7,
    } as React.CSSProperties;
  }, [statusColor, heat]);

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

  // Failed state — async background hook failed, show warning + retry + view logs
  if (isBackgroundHookFailed(session)) {
    return (
      <div
        className="session-card session-card-failed"
        onClick={() => handleSelect()}
        onKeyDown={(e) => e.key === "Enter" && handleSelect()}
        tabIndex={0}
        role="button"
        aria-pressed={isActive}
      >
        <div className="session-card-header">
          <span className="failed-icon">⚠</span>
          <span className="session-name">{session.name}</span>
        </div>
        <div className="failed-hint">环境初始化失败</div>
        <div className="failed-actions">
          <button
            type="button"
            className="failed-log-btn"
            onClick={(e) => { e.stopPropagation(); handleSelect(); }}
          >
            查看失败日志
          </button>
          <button
            type="button"
            className="failed-retry-btn"
            onClick={(e) => { e.stopPropagation(); onRetryHooks(session.id); }}
          >
            重试
          </button>
          {confirmingDelete ? (
            <span className="session-delete-confirm" onClick={(e) => e.stopPropagation()}>
              <span className="session-delete-confirm-text">确认删除?</span>
              <button
                type="button"
                className="session-delete-confirm-btn session-delete-confirm-yes"
                onClick={() => { setConfirmingDelete(false); onDelete(session.id); }}
              >
                ✓
              </button>
              <button
                type="button"
                className="session-delete-confirm-btn session-delete-confirm-no"
                onClick={() => setConfirmingDelete(false)}
              >
                ✕
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="failed-delete-btn"
              onClick={(e) => { e.stopPropagation(); setConfirmingDelete(true); }}
            >
              删除
            </button>
          )}
        </div>
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
        className={`session-card session-card-user-status${isActive ? " session-card-active" : ""}`}
        style={heatmapStyle}
        draggable={!!onDragStart}
        onDragStart={(e) => {
          e.dataTransfer.setData("text/plain", session.id);
          e.dataTransfer.effectAllowed = "move";
          onDragStart?.(session.id);
        }}
        onDragEnd={() => onDragEnd?.()}
        onClick={handleSelect}
        onMouseEnter={() => onHover?.(session.id)}
        onContextMenu={handleContextMenu}
        onDoubleClick={session.canRename === false ? undefined : handleStartRename}
        onKeyDown={(e) => e.key === "Enter" && handleSelect()}
        tabIndex={0}
        role="button"
        aria-pressed={isActive}
      >
        {/* Status icon — always visible, empty circle when no status */}
        <span className="session-status-icon">
          {StatusIconComp ? (
            <StatusIconComp size={14} strokeWidth={2.2} style={{ color: statusColor! }} />
          ) : (
            <span className="session-status-icon-empty" />
          )}
        </span>

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

      {menuPos && (
        <div ref={menuRef} className="context-menu" style={{ left: menuPos.x, top: menuPos.y }}>
          {session.canRename !== false && (
            <button type="button" className="context-menu-item" onClick={handleStartRename} onMouseEnter={() => setSubmenuPos(null)}>
              重命名
            </button>
          )}
          {/* ── Set Status submenu ── */}
          {onSetUserStatus && (
            <div
              className="context-menu-item context-menu-submenu-trigger"
              onMouseEnter={(e) => handleSubmenuEnter(e.currentTarget)}
            >
              <span>设置状态</span>
              <span className="context-menu-submenu-arrow">▸</span>
            </div>
          )}
          <button type="button" className="context-menu-item" onClick={handleOpenInExplorer} onMouseEnter={() => setSubmenuPos(null)}>
            在文件管理器中打开
          </button>
          <button type="button" className="context-menu-item" onClick={handleOpenInTerminal} onMouseEnter={() => setSubmenuPos(null)}>
            在终端中打开
          </button>
          {session.canReassign !== false && (
            <button type="button" className="context-menu-item" onClick={handleReassignPorts} onMouseEnter={() => setSubmenuPos(null)}>
              重新分配端口
            </button>
          )}
          {session.canDelete !== false && (
            <>
              <div className="context-menu-separator" />
              <button
                type="button"
                className="context-menu-item context-menu-danger"
                onClick={handleDelete}
                onMouseEnter={() => setSubmenuPos(null)}
              >
                删除
              </button>
            </>
          )}
        </div>
      )}

      {/* ── Status submenu ── */}
      {menuPos && submenuPos && (
        <div ref={submenuRef} className="context-menu context-menu-submenu" style={{ left: submenuPos.x, top: submenuPos.y }}>
          {USER_STATUS_OPTIONS.map((opt) => (
            <button
              key={opt.key}
              type="button"
              className={`context-menu-item context-menu-status-item${userStatus === opt.key ? " context-menu-status-active" : ""}`}
              onClick={() => handleSetUserStatus(opt.key)}
            >
              <span className="context-menu-status-icon">
                <opt.Icon size={14} strokeWidth={2} style={{ color: opt.color }} />
              </span>
              <span>{opt.label}</span>
              {userStatus === opt.key && <span className="context-menu-check">✓</span>}
            </button>
          ))}
          {userStatus && (
            <>
              <div className="context-menu-separator" />
              <button
                type="button"
                className="context-menu-item"
                onClick={() => handleSetUserStatus(null)}
              >
                清除状态
              </button>
            </>
          )}
        </div>
      )}
    </>
  );
}
