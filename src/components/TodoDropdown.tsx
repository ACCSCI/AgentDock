import { useCallback, useEffect, useRef, useState } from "react";
import { useTodos, useCreateTodo, useToggleTodo, useDeleteTodo } from "../lib/queries";

interface TodoDropdownProps {
  projectId: string | null;
  onClose: () => void;
}

export function TodoDropdown({ projectId, onClose }: TodoDropdownProps) {
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const { data: todos = [] } = useTodos(projectId);
  const createTodo = useCreateTodo();
  const toggleTodo = useToggleTodo();
  const deleteTodo = useDeleteTodo();

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

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

  const handleToggle = useCallback(
    (id: string, completed: boolean) => {
      toggleTodo.mutate({ id, completed: !completed });
    },
    [toggleTodo],
  );

  const handleDelete = useCallback(
    (id: string) => {
      deleteTodo.mutate(id);
    },
    [deleteTodo],
  );

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
        {todos.map((todo) => (
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
            <span className="todo-dropdown-item-text">{todo.content}</span>
            <button
              type="button"
              className="todo-dropdown-delete-btn"
              onClick={() => handleDelete(todo.id)}
              data-testid="todo-delete-btn"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
