import { useCallback, useEffect, useState } from "react";
import { useStore } from "../lib/store";
import { TodoDropdown } from "./TodoDropdown";

declare global {
  interface Window {
    api: {
      windowControls: {
        minimize: () => Promise<void>;
        maximize: () => Promise<void>;
        close: () => Promise<void>;
        isMaximized: () => Promise<boolean>;
        platform: () => Promise<string>;
        onMaximizeChange: (cb: (maximized: boolean) => void) => () => void;
      };
      todos: {
        list: (projectId: string) => Promise<Array<{
          id: string; projectId: string; content: string;
          completed: boolean; sortOrder: number; createdAt: string; updatedAt: string;
        }>>;
        create: (projectId: string, content: string) => Promise<{
          id: string; projectId: string; content: string;
          completed: boolean; sortOrder: number; createdAt: string; updatedAt: string;
        }>;
        toggle: (id: string, completed: boolean) => Promise<void>;
        update: (id: string, content: string) => Promise<void>;
        delete: (id: string) => Promise<void>;
      };
    };
  }
}

export function CustomTitleBar() {
  const [platform, setPlatform] = useState<string>("win32");
  const [isMaximized, setIsMaximized] = useState(false);
  const [todoOpen, setTodoOpen] = useState(false);
  const { activeProjectId } = useStore();

  useEffect(() => {
    window.api.windowControls.platform().then(setPlatform);
    window.api.windowControls.isMaximized().then(setIsMaximized);

    const unsub = window.api.windowControls.onMaximizeChange((maximized: boolean) => {
      setIsMaximized(maximized);
    });
    return unsub;
  }, []);

  const handleMinimize = useCallback(() => {
    window.api.windowControls.minimize();
  }, []);

  const handleMaximize = useCallback(() => {
    window.api.windowControls.maximize();
  }, []);

  const handleClose = useCallback(() => {
    window.api.windowControls.close();
  }, []);

  const handleTodoToggle = useCallback(() => {
    setTodoOpen((prev) => !prev);
  }, []);

  const handleTodoClose = useCallback(() => {
    setTodoOpen(false);
  }, []);

  const isMac = platform === "darwin";

  return (
    <>
      <div
        className={`custom-titlebar ${isMac ? "custom-titlebar--macos" : ""}`}
        data-testid="custom-titlebar"
      >
        {isMac ? (
          /* macOS: leave space for traffic lights, show drag region + todo icon */
          <>
            <div className="custom-titlebar-drag custom-titlebar-drag--macos" />
            <button
              type="button"
              className="custom-titlebar-todo-btn"
              onClick={handleTodoToggle}
              onMouseDown={(e) => e.stopPropagation()}
              data-testid="todo-toggle"
            >
              📝
            </button>
          </>
        ) : (
          /* Windows/Linux: full custom titlebar */
          <>
            <div className="custom-titlebar-left">
              <span className="custom-titlebar-title">AgentDock</span>
            </div>
            <div className="custom-titlebar-drag" />
            <div className="custom-titlebar-right">
              <button
                type="button"
                className="custom-titlebar-todo-btn"
                onClick={handleTodoToggle}
                onMouseDown={(e) => e.stopPropagation()}
                data-testid="todo-toggle"
              >
                📝
              </button>
              <button
                type="button"
                className="custom-titlebar-btn"
                onClick={handleMinimize}
                data-testid="window-minimize"
              >
                ─
              </button>
              <button
                type="button"
                className="custom-titlebar-btn"
                onClick={handleMaximize}
                data-testid="window-maximize"
              >
                {isMaximized ? "❐" : "□"}
              </button>
              <button
                type="button"
                className="custom-titlebar-btn custom-titlebar-btn--close"
                onClick={handleClose}
                data-testid="window-close"
              >
                ×
              </button>
            </div>
          </>
        )}
      </div>
      {todoOpen && (
        <TodoDropdown
          projectId={activeProjectId}
          onClose={handleTodoClose}
        />
      )}
    </>
  );
}
