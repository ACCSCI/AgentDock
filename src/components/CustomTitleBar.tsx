import { Copy, ListTodo, Maximize2, Minimize, PanelsTopLeft, X } from "lucide-react";
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
        list: (projectId: string) => Promise<
          Array<{
            id: string;
            projectId: string;
            content: string;
            completed: boolean;
            sortOrder: number;
            createdAt: string;
            updatedAt: string;
          }>
        >;
        create: (
          projectId: string,
          content: string,
        ) => Promise<{
          id: string;
          projectId: string;
          content: string;
          completed: boolean;
          sortOrder: number;
          createdAt: string;
          updatedAt: string;
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
        className={`flex shrink-0 select-none items-center border-b border-border bg-secondary ${isMac ? "h-7 pl-[70px]" : "h-8"}`}
        data-testid="custom-titlebar"
      >
        {isMac ? (
          /* macOS: leave space for traffic lights, show drag region + todo icon */
          <>
            <div className="h-full flex-1 [-webkit-app-region:drag]" />
            <button
              type="button"
              className="flex size-7 items-center justify-center rounded-sm border-0 bg-transparent text-muted-foreground transition-colors [-webkit-app-region:no-drag] hover:bg-muted hover:text-foreground"
              aria-label="打开任务列表"
              onClick={handleTodoToggle}
              onMouseDown={(e) => e.stopPropagation()}
              data-testid="todo-toggle"
            >
              <ListTodo aria-hidden="true" size={15} />
            </button>
          </>
        ) : (
          /* Windows/Linux: full custom titlebar */
          <>
            <div className="flex shrink-0 items-center px-3">
              <span className="inline-flex items-center gap-2 text-xs font-semibold text-muted-foreground">
                <PanelsTopLeft aria-hidden="true" size={14} className="text-primary" />
                AgentDock
              </span>
            </div>
            <div className="h-full flex-1 [-webkit-app-region:drag]" />
            <div className="flex shrink-0 items-center [-webkit-app-region:no-drag]">
              <button
                type="button"
                className="flex size-7 items-center justify-center rounded-sm border-0 bg-transparent text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                aria-label="打开任务列表"
                onClick={handleTodoToggle}
                onMouseDown={(e) => e.stopPropagation()}
                data-testid="todo-toggle"
              >
                <ListTodo aria-hidden="true" size={15} />
              </button>
              <button
                type="button"
                className="flex h-8 w-[46px] items-center justify-center border-0 bg-transparent text-sm text-muted-foreground transition-colors [-webkit-app-region:no-drag] hover:bg-muted hover:text-foreground"
                aria-label="最小化窗口"
                onClick={handleMinimize}
                data-testid="window-minimize"
              >
                <Minimize aria-hidden="true" size={14} />
              </button>
              <button
                type="button"
                className="flex h-8 w-[46px] items-center justify-center border-0 bg-transparent text-sm text-muted-foreground transition-colors [-webkit-app-region:no-drag] hover:bg-muted hover:text-foreground"
                aria-label={isMaximized ? "还原窗口" : "最大化窗口"}
                onClick={handleMaximize}
                data-testid="window-maximize"
              >
                {isMaximized ? (
                  <Copy aria-hidden="true" size={13} />
                ) : (
                  <Maximize2 aria-hidden="true" size={13} />
                )}
              </button>
              <button
                type="button"
                className="flex h-8 w-[46px] items-center justify-center border-0 bg-transparent text-muted-foreground transition-colors [-webkit-app-region:no-drag] hover:bg-destructive hover:text-white"
                aria-label="关闭窗口"
                onClick={handleClose}
                data-testid="window-close"
              >
                <X aria-hidden="true" size={15} />
              </button>
            </div>
          </>
        )}
      </div>
      {todoOpen && <TodoDropdown projectId={activeProjectId} onClose={handleTodoClose} />}
    </>
  );
}
