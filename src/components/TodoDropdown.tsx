import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  useTodos,
  useCreateTodo,
  useCycleStatusTodo,
  useDeleteTodo,
  useUpdateTodo,
  useReorderTodo,
} from "../lib/queries";
import { useTranslation } from "../i18n/react";

interface TodoDropdownProps {
  projectId: string | null;
  onClose: () => void;
}

export function TodoDropdown({ projectId, onClose }: TodoDropdownProps) {
  const { t } = useTranslation("todo");
  const [input, setInput] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const { data: todos = [] } = useTodos(projectId);
  const createTodo = useCreateTodo();
  const cycleStatusTodo = useCycleStatusTodo();
  const deleteTodo = useDeleteTodo();
  const updateTodo = useUpdateTodo();
  const reorderTodo = useReorderTodo();

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Focus edit input when editing starts
  useEffect(() => {
    if (editingId) {
      editInputRef.current?.focus();
      editInputRef.current?.select();
    }
  }, [editingId]);

  // Close on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", handleClick);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("mousedown", handleClick);
      window.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  // Shift + wheel → horizontal scroll on todo text items (non-passive to allow preventDefault)
  useEffect(() => {
    const listEl = listRef.current;
    if (!listEl) return;

    const handleWheel = (e: WheelEvent) => {
      if (!e.shiftKey) return;
      const target = e.target as HTMLElement;
      const textEl = target.closest<HTMLElement>(".todo-dropdown-item-text");
      if (textEl && textEl.scrollWidth > textEl.clientWidth) {
        e.preventDefault();
        textEl.scrollLeft += e.deltaY;
      }
    };

    listEl.addEventListener("wheel", handleWheel, { passive: false });
    return () => listEl.removeEventListener("wheel", handleWheel);
  }, []);

  // ── Create ──
  const handleCreate = useCallback(() => {
    const content = input.trim();
    if (!content || !projectId) return;
    createTodo.mutate({ projectId, content });
    setInput("");
  }, [input, projectId, createTodo]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleCreate();
      }
    },
    [handleCreate],
  );

  // ── Cycle status (pending → in_progress → done → pending) ──
  const handleCycleStatus = useCallback(
    (id: string) => {
      cycleStatusTodo.mutate(id);
    },
    [cycleStatusTodo],
  );

  // ── Delete ──
  const handleDelete = useCallback(
    (id: string) => {
      deleteTodo.mutate(id);
    },
    [deleteTodo],
  );

  // ── Edit (double-click text → edit) ──
  const handleDoubleClick = useCallback((id: string, content: string) => {
    setEditingId(id);
    setEditingContent(content);
  }, []);

  const handleEditSave = useCallback(() => {
    if (!editingId) return;
    const trimmed = editingContent.trim();
    if (trimmed && trimmed !== todos.find((t) => t.id === editingId)?.content) {
      updateTodo.mutate({ id: editingId, content: trimmed });
    }
    setEditingId(null);
    setEditingContent("");
  }, [editingId, editingContent, todos, updateTodo]);

  const handleEditKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleEditSave();
      } else if (e.key === "Escape") {
        setEditingId(null);
        setEditingContent("");
      }
    },
    [handleEditSave],
  );

  // ── Copy (right-click text) ──
  const showToast = useCallback((msg: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(msg);
    toastTimer.current = setTimeout(() => setToast(null), 1500);
  }, []);

  const handleCopy = useCallback(async (content: string) => {
    try {
      await navigator.clipboard.writeText(content);
      showToast(t("copied"));
    } catch {
      showToast("Copy failed");
    }
  }, [showToast]);

  // ── Drag & Drop reorder (only from handle) ──
  const handleDragStart = useCallback((e: React.DragEvent, id: string) => {
    e.stopPropagation();
    setDragId(id);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", id);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, id: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverId(id);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragOverId(null);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent, targetId: string) => {
      e.preventDefault();
      if (!dragId || dragId === targetId) {
        setDragId(null);
        setDragOverId(null);
        return;
      }
      const ids = todos.map((t) => t.id);
      const fromIndex = ids.indexOf(dragId);
      const toIndex = ids.indexOf(targetId);
      if (fromIndex === -1 || toIndex === -1) return;
      ids.splice(fromIndex, 1);
      ids.splice(toIndex, 0, dragId);
      reorderTodo.mutate(ids);
      setDragId(null);
      setDragOverId(null);
    },
    [dragId, todos, reorderTodo],
  );

  const handleDragEnd = useCallback(() => {
    setDragId(null);
    setDragOverId(null);
  }, []);

  // Cleanup toast timer on unmount
  useEffect(() => {
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);

  const doneCount = todos.filter((t) => t.status === "done").length;

  return (
    <>
    <div
      ref={dropdownRef}
      className="todo-dropdown"
      data-testid="todo-dropdown"
    >
      <div className="todo-dropdown-header">
        <span className="todo-dropdown-title">{t("todo")}</span>
        {todos.length > 0 && (
          <span className="todo-dropdown-count">
            {doneCount}/{todos.length}
          </span>
        )}
      </div>

      <div className="todo-dropdown-input-row">
        <input
          ref={inputRef}
          type="text"
          className="todo-dropdown-input"
          placeholder={projectId ? t("addTask") : "Open a project first"}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={!projectId}
          data-testid="todo-input"
        />
        <button
          type="button"
          className="todo-dropdown-add-btn"
          onClick={handleCreate}
          disabled={!projectId || !input.trim()}
          data-testid="todo-add-btn"
        >
          +
        </button>
      </div>

      <div ref={listRef} className="todo-dropdown-list" data-testid="todo-list">
        {todos.length === 0 && (
          <div className="todo-dropdown-empty">
            {projectId ? t("noTasks") : "Open a project to add tasks"}
          </div>
        )}
        {todos.map((todo) => (
          <div
            key={todo.id}
            className={[
              "todo-dropdown-item",
              todo.status === "done" ? "todo-dropdown-item--done" : "",
              todo.status === "in_progress" ? "todo-dropdown-item--in-progress" : "",
              todo.status === "pending" ? "todo-dropdown-item--pending" : "",
              dragId === todo.id ? "todo-dropdown-item--dragging" : "",
              dragOverId === todo.id ? "todo-dropdown-item--drag-over" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            data-testid="todo-item"
            draggable={false}
            onDragOver={(e) => handleDragOver(e, todo.id)}
            onDragLeave={handleDragLeave}
            onDrop={(e) => handleDrop(e, todo.id)}
            onDragEnd={handleDragEnd}
          >
            <span
              className="todo-dropdown-drag-handle"
              title={t("dragToReorder")}
              draggable
              onDragStart={(e) => handleDragStart(e, todo.id)}
            >
              ⠿
            </span>

            <button
              type="button"
              className={`todo-dropdown-checkbox todo-dropdown-checkbox--${todo.status}`}
              onClick={() => handleCycleStatus(todo.id)}
              title={todo.status === "pending" ? "Click: start" : todo.status === "in_progress" ? "Click: mark done" : "Click: reset"}
              data-testid="todo-toggle-btn"
            >
              {todo.status === "pending" && "○"}
              {todo.status === "in_progress" && "●"}
              {todo.status === "done" && "●"}
            </button>

            {editingId === todo.id ? (
              <input
                ref={editInputRef}
                type="text"
                className="todo-dropdown-edit-input"
                value={editingContent}
                onChange={(e) => setEditingContent(e.target.value)}
                onBlur={handleEditSave}
                onKeyDown={handleEditKeyDown}
                data-testid="todo-edit-input"
              />
            ) : (
              <span
                className="todo-dropdown-item-text"
                onDoubleClick={() => handleDoubleClick(todo.id, todo.content)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  handleCopy(todo.content);
                }}
                title={`${t("doubleClickToEdit")} · ${t("rightClickToCopy")}`}
                data-testid="todo-text"
              >
                {todo.content}
              </span>
            )}

            <button
              type="button"
              className="todo-dropdown-delete-btn"
              onClick={() => handleDelete(todo.id)}
              title={t("delete")}
              data-testid="todo-delete-btn"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
      {toast && createPortal(
        <div className="todo-toast">{toast}</div>,
        document.body,
      )}
    </>
  );
}
