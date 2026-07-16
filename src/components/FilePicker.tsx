import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "../i18n/react";
import { type FileEntry, useProjectFiles } from "../lib/queries";

interface FilePickerProps {
  open: boolean;
  projectId: string;
  onConfirm: (filePath: string) => void;
  onCancel: () => void;
}

export function FilePicker({ open, projectId, onConfirm, onCancel }: FilePickerProps) {
  const { t } = useTranslation("modals");
  const [currentPath, setCurrentPath] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  /** Stores the scrollTop for each directory path we've visited. */
  const scrollPositions = useRef<Map<string, number>>(new Map());

  const { data: entries = [], isLoading } = useProjectFiles(projectId, currentPath, open);

  // Filter entries by search keyword
  const displayEntries = search.trim()
    ? entries.filter((e) => e.name.toLowerCase().includes(search.toLowerCase()))
    : entries;

  // Reset state when modal closes (avoids re-fetch on next open)
  useLayoutEffect(() => {
    if (!open) {
      scrollPositions.current.clear();
      setCurrentPath("");
      setSelected(null);
      setSearch("");
    }
  }, [open]);

  /** Continuously save the current scroll position for the active directory. */
  const handleScroll = useCallback(() => {
    if (listRef.current) {
      scrollPositions.current.set(currentPath, listRef.current.scrollTop);
    }
  }, [currentPath]);

  const handleNavigate = useCallback((entry: FileEntry) => {
    if (entry.isDir) {
      setCurrentPath(entry.path);
      setSelected(null);
      setSearch("");
    } else {
      setSelected(entry.path);
    }
  }, []);

  const handleBack = useCallback(() => {
    const parts = currentPath.split("/").filter(Boolean);
    parts.pop();
    setCurrentPath(parts.join("/"));
    setSelected(null);
    setSearch("");
  }, [currentPath]);

  const handleConfirm = useCallback(() => {
    if (selected) {
      onConfirm(selected);
    }
  }, [selected, onConfirm]);

  const handleSelectDir = useCallback(() => {
    if (currentPath) {
      // Append "/" to signal directory selection (resource-sync convention)
      onConfirm(currentPath.endsWith("/") ? currentPath : `${currentPath}/`);
    }
  }, [currentPath, onConfirm]);

  const goToPath = useCallback((path: string) => {
    setCurrentPath(path);
    setSelected(null);
    setSearch("");
  }, []);

  // Restore scroll position when data for the new directory is ready
  // biome-ignore lint/correctness/useExhaustiveDependencies: entries changing means the directory listing has finished refreshing and its scroll position can be restored.
  useLayoutEffect(() => {
    if (!isLoading && listRef.current) {
      const saved = scrollPositions.current.get(currentPath);
      if (saved !== undefined) {
        listRef.current.scrollTop = saved;
      }
    }
  }, [currentPath, entries, isLoading]);

  // Breadcrumb segments
  const breadcrumbs = currentPath ? currentPath.split("/").filter(Boolean) : [];

  if (!open) return null;

  return (
    <div
      className="file-picker-overlay"
      role="presentation"
      onClick={(event) => event.target === event.currentTarget && onCancel()}
      onKeyDown={(event) => event.key === "Escape" && onCancel()}
    >
      <div className="file-picker-modal">
        <div className="file-picker-header">
          <h3>{t("filePicker.title")}</h3>
          <button type="button" className="file-picker-close" onClick={onCancel}>
            ×
          </button>
        </div>

        {/* Breadcrumb navigation */}
        <div className="file-picker-breadcrumb">
          <button
            type="button"
            className="file-picker-breadcrumb-item"
            onClick={() => goToPath("")}
          >
            📁 项目根目录
          </button>
          {breadcrumbs.map((seg, i) => {
            const segPath = breadcrumbs.slice(0, i + 1).join("/");
            return (
              <span key={segPath}>
                <span className="file-picker-breadcrumb-sep">/</span>
                <button
                  type="button"
                  className="file-picker-breadcrumb-item"
                  onClick={() => goToPath(segPath)}
                >
                  {seg}
                </button>
              </span>
            );
          })}
        </div>

        {/* Search */}
        <div className="file-picker-search">
          <input
            type="text"
            placeholder={t("filePicker.searchPlaceholder")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {/* File list */}
        <div className="file-picker-list" ref={listRef} onScroll={handleScroll}>
          {isLoading ? (
            <div className="file-picker-loading">{t("loading", { ns: "common" })}</div>
          ) : displayEntries.length === 0 ? (
            <div className="file-picker-empty">{t("noMatch", { ns: "common" })}</div>
          ) : (
            displayEntries.map((entry) => (
              <button
                type="button"
                key={entry.path}
                className={`file-picker-entry ${selected === entry.path ? "file-picker-entry-selected" : ""}`}
                onClick={() => handleNavigate(entry)}
                onDoubleClick={() => {
                  if (!entry.isDir) onConfirm(entry.path);
                }}
              >
                <span className="file-picker-entry-icon">{entry.isDir ? "📁" : "📄"}</span>
                <span className="file-picker-entry-name">{entry.name}</span>
              </button>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="file-picker-footer">
          {currentPath && (
            <>
              <button
                type="button"
                className="file-picker-btn file-picker-btn-back"
                onClick={handleBack}
              >
                ← 返回上级
              </button>
              <button
                type="button"
                className="file-picker-btn file-picker-btn-select-dir"
                onClick={handleSelectDir}
              >
                📁 选择此目录
              </button>
            </>
          )}
          <div className="file-picker-footer-right">
            <button
              type="button"
              className="file-picker-btn file-picker-btn-cancel"
              onClick={onCancel}
            >
              {t("filePicker.cancel")}
            </button>
            <button
              type="button"
              className="file-picker-btn file-picker-btn-confirm"
              disabled={!selected}
              onClick={handleConfirm}
            >
              {t("filePicker.select")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
