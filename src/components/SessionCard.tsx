import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionData } from "../lib/queries";

interface SessionCardProps {
  session: SessionData;
  isActive: boolean;
  onSelect: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
  onRename: (sessionId: string, newName: string) => void;
  onOpenInExplorer: (worktreePath: string) => void;
  onReassignPorts: (sessionId: string) => void;
}

export function SessionCard({
  session,
  isActive,
  onSelect,
  onDelete,
  onRename,
  onOpenInExplorer,
  onReassignPorts,
}: SessionCardProps) {
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(session.name);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

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
    onDelete(session.id);
  }, [session.id, onDelete]);

  const handleReassignPorts = useCallback(() => {
    setMenuPos(null);
    onReassignPorts(session.id);
  }, [session.id, onReassignPorts]);

  return (
    <>
      <div
        className={`session-card ${isActive ? "session-card-active" : ""}`}
        onClick={() => onSelect(session.id)}
        onContextMenu={handleContextMenu}
        onDoubleClick={handleStartRename}
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
          <span className="session-ports" title={`FRONTEND:${session.ports.FRONTEND_PORT} BACKEND:${session.ports.BACKEND_PORT} WS:${session.ports.WS_PORT} DEBUG:${session.ports.DEBUG_PORT} PREVIEW:${session.ports.PREVIEW_PORT}`}>
            :{session.ports.FRONTEND_PORT}
          </span>
        )}
        <button
          type="button"
          className="session-close"
          onClick={(e) => {
            e.stopPropagation();
            onDelete(session.id);
          }}
        >
          ✕
        </button>
      </div>

      {menuPos && (
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
