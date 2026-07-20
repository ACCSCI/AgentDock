import { cn } from "@/lib/utils";
import { GripVertical, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "../i18n/react";
import {
  useCreateTodo,
  useCycleStatusTodo,
  useDeleteTodo,
  useReorderTodo,
  useTodos,
  useUpdateTodo,
} from "../lib/queries";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

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

  const handleCopy = useCallback(
    async (content: string) => {
      try {
        await navigator.clipboard.writeText(content);
        showToast(t("copied"));
      } catch {
        showToast(t("copyFailed"));
      }
    },
    [showToast, t],
  );

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
        className="fixed top-9 right-3 z-50 flex max-h-[400px] w-[280px] flex-col overflow-hidden rounded-md border border-border bg-background shadow-[0_8px_32px_rgba(0,0,0,0.15)] animate-in fade-in duration-100"
        data-testid="todo-dropdown"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2.5">
          <span className="text-[13px] font-semibold text-foreground">{t("todo")}</span>
          {todos.length > 0 && (
            <span className="rounded-lg bg-secondary px-1.5 py-px text-[11px] text-muted-foreground">
              {doneCount}/{todos.length}
            </span>
          )}
        </div>

        <div className="flex shrink-0 gap-1 border-b border-border px-3 py-2">
          <Input
            ref={inputRef}
            type="text"
            className="h-7 flex-1 rounded-sm px-2 text-xs"
            placeholder={projectId ? t("addTask") : t("openProjectFirst")}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={!projectId}
            data-testid="todo-input"
          />
          <Button
            type="button"
            size="icon-sm"
            onClick={handleCreate}
            disabled={!projectId || !input.trim()}
            data-testid="todo-add-btn"
            aria-label={t("addTask")}
          >
            <Plus aria-hidden="true" />
          </Button>
        </div>

        <div
          ref={listRef}
          className="max-h-[300px] min-h-[60px] flex-1 overflow-y-auto"
          data-testid="todo-list"
        >
          {todos.length === 0 && (
            <div className="px-3 py-5 text-center text-xs text-muted-foreground">
              {projectId ? t("noTasks") : t("openProjectToAddTasks")}
            </div>
          )}
          {todos.map((todo) => (
            <div
              key={todo.id}
              className={cn(
                "group flex items-center gap-2 px-3 py-1.5 transition-colors hover:bg-secondary",
                dragId === todo.id && "opacity-40",
                dragOverId === todo.id && "border-t-2 border-primary",
              )}
              data-testid="todo-item"
              data-dragging={dragId === todo.id || undefined}
              draggable={false}
              onDragOver={(e) => handleDragOver(e, todo.id)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, todo.id)}
              onDragEnd={handleDragEnd}
            >
              <span
                className="w-3.5 shrink-0 cursor-grab select-none text-center text-[10px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-60 hover:!opacity-100 hover:text-primary group-data-[dragging]:cursor-grabbing"
                title={t("dragToReorder")}
                draggable
                onDragStart={(e) => handleDragStart(e, todo.id)}
              >
                <GripVertical aria-hidden="true" />
              </span>

              <button
                type="button"
                className={cn(
                  "w-5 shrink-0 cursor-pointer border-none bg-transparent p-0 text-center text-sm leading-none transition-colors",
                  todo.status === "pending" && "text-muted-foreground",
                  todo.status === "in_progress" && "text-success",
                  todo.status === "done" && "text-destructive",
                )}
                onClick={() => handleCycleStatus(todo.id)}
                title={
                  todo.status === "pending"
                    ? "Click: start"
                    : todo.status === "in_progress"
                      ? "Click: mark done"
                      : "Click: reset"
                }
                data-testid="todo-toggle-btn"
              >
                {todo.status === "pending" && "○"}
                {todo.status === "in_progress" && "●"}
                {todo.status === "done" && "●"}
              </button>

              {editingId === todo.id ? (
                <Input
                  ref={editInputRef}
                  type="text"
                  className="h-[22px] flex-1 rounded-sm border-primary px-1.5 text-xs"
                  value={editingContent}
                  onChange={(e) => setEditingContent(e.target.value)}
                  onBlur={handleEditSave}
                  onKeyDown={handleEditKeyDown}
                  data-testid="todo-edit-input"
                />
              ) : (
                <span
                  className={cn(
                    "todo-dropdown-item-text flex-1 cursor-default select-none overflow-hidden text-ellipsis whitespace-nowrap text-xs text-foreground transition-colors [scrollbar-width:none] group-hover:overflow-x-auto group-hover:text-clip group-hover:[scrollbar-width:thin]",
                    todo.status === "done" && "line-through opacity-50",
                    todo.status === "in_progress" && "text-success",
                  )}
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

              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="shrink-0 px-1 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-transparent hover:text-destructive"
                onClick={() => handleDelete(todo.id)}
                title={t("delete")}
                data-testid="todo-delete-btn"
                aria-label={t("delete")}
              >
                <Trash2 aria-hidden="true" />
              </Button>
            </div>
          ))}
        </div>
      </div>
      {toast &&
        createPortal(
          <div className="pointer-events-none fixed top-10 right-4 z-[9999] rounded-md bg-popover px-4 py-1.5 text-xs text-popover-foreground shadow-[0_4px_12px_rgba(0,0,0,0.2)] animate-in slide-in-from-right-1.5 fade-in duration-150">
            {toast}
          </div>,
          document.body,
        )}
    </>
  );
}
