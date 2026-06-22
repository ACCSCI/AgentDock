import { useCallback, useEffect, useRef, useState } from "react";
import {
  useTodos,
  useCreateTodo,
  useToggleTodo,
  useDeleteTodo,
  useUpdateTodo,
  useReorderTodo,
} from "../lib/queries";

interface TodoDropdownProps {
  projectId: string | null;
  onClose: () => void;
}

export function TodoDropdown({ projectId, onClose }: TodoDropdownProps) {
  const [input, setInput] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const { data: todos = [] } = useTodos(projectId);
  const createTodo = useCreateTodo();
  const toggleTodo = useToggleTodo();
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

  // ── Toggle ──
  const handleToggle = useCallback(
    (id: string, completed: boolean) => {
      toggleTodo.mutate({ id, completed: !completed });
    },
    [toggleTodo],
  );

  // ── Delete ──
  const handleDelete = useCallback(
    (id: string) => {
      deleteTodo.mutate(id);
    },
    [deleteTodo],
  );

  // ── Edit (double-click) ──
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

  // ── Reorder (up/down) ──
  const handleMove = useCallback(
    (index: number, direction: -1 | 1) => {
      const targetIndex = index + direction;
      if (targetIndex < 0 || targetIndex >= todos.length) return;
      const ids = todos.map((t) => t.id);
      // Swap
      [ids[index], ids[targetIndex]] = [ids[targetIndex], ids[index]];
      reorderTodo.mutate(ids);
    },
    [todos, reorderTodo],
  );

  // ── Copy ──
  const handleCopy = useCallback(async (content: string) => {
    try {
      await navigator.clipboard.writeText(content);
    } catch {
      // Clipboard API not available or denied
    }
  }, []);

  const completedCount = todos.filter((t) => t.completed).length;

  return (
    <div
      ref={dropdownRef}
      className="todo-dropdown"
      data-testid="todo-dropdown"
    >
      <div className="todo-dropdown-header">
        <span className="todo-dropdown-title">Todo</span>
        {todos.length > 0 && (
          <span className="todo-dropdown-count">
            {completedCount}/{todos.length}
          </span>
        )}
      </div>

      <div className="todo-dropdown-input-row">
        <input
          ref={inputRef}
          type="text"
          className="todo-dropdown-input"
          placeholder={projectId ? "Add a task..." : "Open a project first"}
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

      <div className="todo-dropdown-list" data-testid="todo-list">
        {todos.length === 0 && (
          <div className="todo-dropdown-empty">
            {projectId ? "No tasks yet" : "Open a project to add tasks"}
          </div>
        )}
        {todos.map((todo, index) => (
          <div
            key={todo.id}
            className={`todo-dropdown-item ${todo.completed ? "todo-dropdown-item--completed" : ""}`}
            data-testid="todo-item"
          >
            <button
              type="button"
              className="todo-dropdown-checkbox"
              onClick={() => handleToggle(todo.id, todo.completed)}
              data-testid="todo-toggle-btn"
            >
              {todo.completed ? "☑" : "☐"}
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
                data-testid="todo-text"
              >
                {todo.content}
              </span>
            )}

            <div className="todo-dropdown-actions">
              <button
                type="button"
                className="todo-dropdown-action-btn"
                onClick={() => handleMove(index, -1)}
                disabled={index === 0}
                title="Move up"
                data-testid="todo-move-up"
              >
                ↑
              </button>
              <button
                type="button"
                className="todo-dropdown-action-btn"
                onClick={() => handleMove(index, 1)}
                disabled={index === todos.length - 1}
                title="Move down"
                data-testid="todo-move-down"
              >
                ↓
              </button>
              <button
                type="button"
                className="todo-dropdown-action-btn"
                onClick={() => handleCopy(todo.content)}
                title="Copy"
                data-testid="todo-copy"
              >
                📋
              </button>
              <button
                type="button"
                className="todo-dropdown-delete-btn"
                onClick={() => handleDelete(todo.id)}
                title="Delete"
                data-testid="todo-delete-btn"
              >
                ×
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
