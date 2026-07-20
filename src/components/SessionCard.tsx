import { CheckCircle2, CircleHelp, ClipboardList, FileText, Send, Wrench } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "../i18n/react";
import {
  type CreatingSession,
  type DeletingSession,
  type SessionData,
  type SessionListItem,
  type SessionStep,
  type SessionUserStatus,
  isBackgroundHookFailed,
  isBackgroundHookRunning,
  isCreatingSession,
  isDeletingSession,
  useBackgroundHookStatus,
} from "../lib/queries";

// ── Session user-status definitions ────────────────────────────────
import { cn } from "../lib/utils";
import type { LucideIcon } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "./ui/context-menu";

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
  { key: "verifying", Icon: CircleHelp, label: "待验证", color: "#F97316" },
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
  return 0.5 ** (elapsed / HALF_LIFE);
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
  const stepMap = new Map((steps ?? []).map((s) => [s.step, s]));
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
  onRequestDelete: (sessionId: string) => void;
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
  onRequestDelete,
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
  const { t } = useTranslation("session");
  const USER_STATUS_OPTIONS = useMemo(
    () => [
      {
        key: "draft" as SessionUserStatus,
        Icon: FileText,
        label: t("status.draft"),
        color: "#8B5CF6",
      },
      {
        key: "plan" as SessionUserStatus,
        Icon: ClipboardList,
        label: t("status.plan"),
        color: "#3B82F6",
      },
      {
        key: "working" as SessionUserStatus,
        Icon: Wrench,
        label: t("status.working"),
        color: "#F59E0B",
      },
      { key: "pr" as SessionUserStatus, Icon: Send, label: t("status.pr"), color: "#10B981" },
      {
        key: "verifying" as SessionUserStatus,
        Icon: CircleHelp,
        label: t("status.verifying"),
        color: "#F97316",
      },
      {
        key: "done" as SessionUserStatus,
        Icon: CheckCircle2,
        label: t("status.done"),
        color: "#6B7280",
      },
    ],
    [t],
  );
  const createStepLabels = useMemo(
    () => ({
      beforeCreateSession: t("step.beforeCreateSession"),
      createWorktree: t("step.createWorktree"),
      syncResources: t("step.syncResources"),
      allocatePorts: t("step.allocatePorts"),
      afterCreateSession: t("step.afterCreateSession"),
    }),
    [t],
  );
  const deleteStepLabels = useMemo(
    () => ({
      beforeDeleteSession: t("step.beforeDeleteSession"),
      releasePorts: t("step.releasePorts"),
      removeWorktree: t("step.removeWorktree"),
      afterDeleteSession: t("step.afterDeleteSession"),
    }),
    [t],
  );
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(session.name);
  const inputRef = useRef<HTMLInputElement>(null);

  // Heat value — recomputed every 10s via interval + on session data change
  const lastActivatedAt =
    "lastActivatedAt" in session ? (session as SessionData).lastActivatedAt : null;
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

  // Sync editValue with session.name when not editing
  useEffect(() => {
    if (!editing) {
      setEditValue(session.name);
    }
  }, [session.name, editing]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const handleStartRename = useCallback(() => {
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
    onOpenInExplorer(session.worktreePath);
  }, [session.worktreePath, onOpenInExplorer]);

  const handleOpenInTerminal = useCallback(() => {
    onOpenInTerminal(session.worktreePath);
  }, [session.worktreePath, onOpenInTerminal]);

  const handleDelete = useCallback(() => {
    setEditing(false);
    onRequestDelete(session.id);
  }, [session.id, onRequestDelete]);

  const handleReassignPorts = useCallback(() => {
    onReassignPorts(session.id);
  }, [session.id, onReassignPorts]);

  const handleSetUserStatus = useCallback(
    (status: SessionUserStatus | null) => {
      onSetUserStatus?.(session.id, status);
    },
    [session.id, onSetUserStatus],
  );

  const handleSelect = useCallback(() => {
    onSelect(session.id);
    onActivate?.(session.id);
  }, [session.id, onSelect, onActivate]);

  const isForeign = session.status === "foreign";
  const statusLabel = session.status === "foreign" ? "Foreign" : null;
  const foreignTitle = session.ownerClientId
    ? `This session is currently managed by another AgentDock instance (${session.ownerClientId}).`
    : "This session is currently managed by another AgentDock instance.";

  // ── Inline styles for heatmap overlay ──────────────────────────────
  const heatmapStyle = useMemo<React.CSSProperties>(() => {
    if (statusColor) {
      const opacity = Math.min(heat * 0.3, 0.3);
      return {
        "--session-status-color": statusColor,
        "--session-heat": opacity,
      } as React.CSSProperties;
    }
    // No status: neutral overlay to mute the pink-tinted base. Use the theme's
    // own card color (NOT a hardcoded #fff) so it stays neutral in dark mode
    // too — a literal white overlay is exactly what made cards look washed-out
    // / white against the dark sidebar.
    return {
      "--session-status-color": "var(--card)",
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
        <LifecycleSteps
          steps={creating.steps}
          stepOrder={[
            "beforeCreateSession",
            "createWorktree",
            "syncResources",
            "allocatePorts",
            "afterCreateSession",
          ]}
          labels={createStepLabels}
        />
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
        <LifecycleSteps
          steps={deleting.steps}
          stepOrder={[
            "beforeDeleteSession",
            "releasePorts",
            "removeWorktree",
            "afterDeleteSession",
          ]}
          labels={deleteStepLabels}
        />
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
            onClick={(e) => {
              e.stopPropagation();
              handleSelect();
            }}
          >
            查看失败日志
          </button>
          <button
            type="button"
            className="failed-retry-btn"
            onClick={(e) => {
              e.stopPropagation();
              onRetryHooks(session.id);
            }}
          >
            重试
          </button>
          <button
            type="button"
            className="failed-delete-btn"
            onClick={(e) => {
              e.stopPropagation();
              onRequestDelete(session.id);
            }}
          >
            删除
          </button>
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
          {statusLabel && (
            <span className="session-status-badge session-status-badge-foreign">{statusLabel}</span>
          )}
        </div>
      </div>
    );
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={cn(
            "session-card session-card-user-status",
            isActive && "session-card-active",
          )}
          style={heatmapStyle}
          draggable={!!onDragStart}
          onDragStart={(e) => {
            e.dataTransfer.setData("text/plain", session.id);
            e.dataTransfer.effectAllowed = "move";
            onDragStart?.(session.id);
          }}
          onDragEnd={() => onDragEnd?.()}
        >
          {/* Main selectable area — single button for select/rename/double-click */}
          <button
            type="button"
            className="session-card-main"
            onClick={handleSelect}
            onDoubleClick={session.canRename === false ? undefined : handleStartRename}
            aria-pressed={isActive}
          >
            {/* Status icon */}
            <span className="session-status-icon">
              {StatusIconComp ? (
                <StatusIconComp size={14} strokeWidth={2.2} style={{ color: statusColor ?? undefined }} />
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
                onClick={(e) => e.stopPropagation()}
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
              <span className={`session-status-badge session-status-badge-${session.status}`}>
                {statusLabel}
              </span>
            )}
          </button>

          {/* Sibling action buttons — no longer nested inside role=button */}
          <button
            type="button"
            className="session-close"
            aria-label={t("closeSession", { name: session.name })}
            onClick={(e) => {
              e.stopPropagation();
              onRequestDelete(session.id);
            }}
          >
            ✕
          </button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {session.canRename !== false && (
          <ContextMenuItem onSelect={handleStartRename}>重命名</ContextMenuItem>
        )}
        {onSetUserStatus && (
          <ContextMenuSub>
            <ContextMenuSubTrigger>设置状态</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuRadioGroup
                value={userStatus ?? ""}
                onValueChange={(value) =>
                  handleSetUserStatus(value ? (value as SessionUserStatus) : null)
                }
              >
                {USER_STATUS_OPTIONS.map((opt) => (
                  <ContextMenuRadioItem key={opt.key} value={opt.key}>
                    <opt.Icon
                      aria-hidden="true"
                      size={14}
                      strokeWidth={2}
                      style={{ color: opt.color }}
                    />
                    {opt.label}
                  </ContextMenuRadioItem>
                ))}
              </ContextMenuRadioGroup>
              {userStatus && (
                <>
                  <ContextMenuSeparator />
                  <ContextMenuItem onSelect={() => handleSetUserStatus(null)}>
                    清除状态
                  </ContextMenuItem>
                </>
              )}
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}
        <ContextMenuItem onSelect={handleOpenInExplorer}>在文件管理器中打开</ContextMenuItem>
        <ContextMenuItem onSelect={handleOpenInTerminal}>在终端中打开</ContextMenuItem>
        {session.canReassign !== false && (
          <ContextMenuItem onSelect={handleReassignPorts}>重新分配端口</ContextMenuItem>
        )}
        {session.canDelete !== false && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onSelect={handleDelete}>
              删除
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
