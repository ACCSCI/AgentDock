import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export interface DirEntry {
  name: string;
  path: string;
}

interface DirBrowserModalProps {
  open: boolean;
  onConfirm: (path: string) => void;
  onCancel: () => void;
}

export function DirBrowserModal({ open, onConfirm, onCancel }: DirBrowserModalProps) {
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [currentPath, setCurrentPath] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  /** Stores the scrollTop for each directory path we've visited. */
  const scrollPositions = useRef<Map<string, number>>(new Map());

  // Filter entries by search keyword
  const displayEntries = search.trim()
    ? entries.filter(
        (e) => e.name !== ".. (上级目录)" && e.name.toLowerCase().includes(search.toLowerCase()),
      )
    : entries;

  const fetchDirs = useCallback(async (path?: string) => {
    setLoading(true);
    setError(null);
    // Optimistically set currentPath so back navigation works even on error
    if (path) setCurrentPath(path);
    setSelected(null);
    setSearch("");
    try {
      const url = path ? `/api/browse-dirs?path=${encodeURIComponent(path)}` : "/api/browse-dirs";
      const res = await fetch(url);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to list directories");
      setEntries(data.entries);
      setCurrentPath(data.currentPath ?? "");
    } catch (err) {
      setEntries([]);
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  /** Continuously save the current scroll position for the active directory. */
  const handleScroll = useCallback(() => {
    if (listRef.current && currentPath) {
      scrollPositions.current.set(currentPath, listRef.current.scrollTop);
    }
  }, [currentPath]);

  // Restore scroll position when data for the new directory is ready
  useLayoutEffect(() => {
    if (!loading && listRef.current && currentPath) {
      const saved = scrollPositions.current.get(currentPath);
      if (saved !== undefined) {
        listRef.current.scrollTop = saved;
      }
    }
  }, [currentPath, entries, loading]);

  // Load root directories when modal opens
  useLayoutEffect(() => {
    if (open) {
      scrollPositions.current.clear();
      fetchDirs();
    }
  }, [open, fetchDirs]);

  // Keyboard navigation
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onCancel]);

  if (!open) return null;

  const handleEntryClick = (entry: DirEntry) => {
    if (entry.name === ".. (上级目录)") {
      // Navigate to parent — no selection
      fetchDirs(entry.path);
      return;
    }
    setSelected(entry.path === selected ? null : entry.path);
  };

  const handleEntryDoubleClick = (entry: DirEntry) => {
    // Double-click navigates into directory
    fetchDirs(entry.path);
  };

  const handleConfirm = () => {
    if (selected) onConfirm(selected);
  };

  const goToParent = () => {
    if (!currentPath) return;
    // At drive root (e.g. C:\) — go back to root list
    if (/^[A-Z]:\\?$/.test(currentPath)) {
      fetchDirs();
      return;
    }
    // Compute parent path directly from currentPath
    const normalized = currentPath.replace(/\\/g, "/");
    const lastSlash = normalized.lastIndexOf("/");
    if (lastSlash === 0) {
      // Unix: e.g. /usr → /
      fetchDirs("/");
    } else if (lastSlash > 0) {
      const parent = normalized.slice(0, lastSlash);
      // On Windows, "C:" needs a backslash — "C:/" → "C:\"
      const parentPath = /^[A-Z]:$/.test(parent) ? parent + "\\" : parent;
      fetchDirs(parentPath);
    } else {
      // Reached top — go to root list
      fetchDirs();
    }
  };

  // Build breadcrumb segments from currentPath
  const breadcrumbs: Array<{ label: string; path: string }> = [];
  if (currentPath) {
    const isUnixRoot = currentPath.startsWith("/");
    const isWindows = currentPath.includes("\\");
    const sep = isWindows ? "\\" : "/";
    const parts = currentPath.replace(/\\/g, "/").split("/").filter(Boolean);
    let accumulated = "";
    for (const part of parts) {
      if (part.endsWith(":")) {
        // Windows drive letter — e.g. "C:" → "C:\"
        accumulated = part + "\\";
      } else if (!accumulated && isUnixRoot) {
        // First segment on Unix — prepend /
        accumulated = "/" + part;
      } else {
        accumulated = `${accumulated}${sep}${part}`;
      }
      breadcrumbs.push({ label: part, path: accumulated });
    }
  }

  return (
    <div className="dir-modal-overlay" onClick={onCancel}>
      <div className="dir-modal" onClick={(e) => e.stopPropagation()}>
        <div className="dir-modal-header">
          <div className="dir-modal-header-left">
            <button
              type="button"
              className="dir-modal-back"
              onClick={goToParent}
              disabled={!currentPath}
              title="返回上一级"
            >
              ←
            </button>
            <h3>选择项目目录</h3>
          </div>
          <button type="button" className="dir-modal-close" onClick={onCancel}>
            ✕
          </button>
        </div>

        {/* Breadcrumb */}
        <div className="dir-modal-breadcrumb">
          <button
            type="button"
            className="dir-breadcrumb-item"
            onClick={() => fetchDirs()}
          >
            /
          </button>
          {breadcrumbs.map((seg) => (
            <span key={seg.path}>
              <span className="dir-breadcrumb-sep">/</span>
              <button
                type="button"
                className="dir-breadcrumb-item"
                onClick={() => fetchDirs(seg.path)}
              >
                {seg.label}
              </button>
            </span>
          ))}
        </div>

        {/* Search */}
        <div className="dir-modal-search">
          <input
            type="text"
            className="dir-search-input"
            placeholder="搜索文件夹名称..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {/* Directory list */}
        <div className="dir-modal-list" ref={listRef} onScroll={handleScroll}>
          {loading && <div className="dir-modal-status">加载中...</div>}
          {error && <div className="dir-modal-status dir-modal-error">{error}</div>}
          {!loading && !error && displayEntries.length === 0 && (
            <div className="dir-modal-status">
              {search.trim() ? "没有匹配的文件夹" : "空目录"}
            </div>
          )}
          {!loading &&
            !error &&
            displayEntries.map((entry) => (
              <div
                key={entry.path}
                className={`dir-entry ${selected === entry.path ? "dir-entry-selected" : ""}`}
                onClick={() => handleEntryClick(entry)}
                onDoubleClick={() => handleEntryDoubleClick(entry)}
              >
                <span className="dir-entry-icon">
                  {entry.name === ".. (上级目录)" ? "⬆" : "📁"}
                </span>
                <span className="dir-entry-name">{entry.name}</span>
                {entry.name !== ".. (上级目录)" && (
                  <button
                    type="button"
                    className="dir-entry-open"
                    onClick={(e) => {
                      e.stopPropagation();
                      fetchDirs(entry.path);
                    }}
                    title="进入目录"
                  >
                    ▶
                  </button>
                )}
              </div>
            ))}
        </div>

        {/* Selected path display */}
        <div className="dir-modal-selected">
          <span className="dir-modal-selected-label">已选择:</span>
          {selected ? (
            <span className="dir-modal-selected-path">{selected}</span>
          ) : (
            <span className="dir-modal-selected-empty">未选择</span>
          )}
        </div>

        {/* Actions */}
        <div className="dir-modal-actions">
          <button type="button" className="dir-modal-btn dir-modal-btn-cancel" onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className="dir-modal-btn dir-modal-btn-confirm"
            disabled={!selected}
            onClick={handleConfirm}
          >
            选择此目录
          </button>
        </div>
      </div>
    </div>
  );
}
