import { ChevronLeft, ChevronRight, Folder, FolderUp } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useShortcutAction } from "../hooks/useShortcuts";
import { useTranslation } from "../i18n/react";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";

export interface DirEntry {
  name: string;
  path: string;
}

interface DirBrowserModalProps {
  open: boolean;
  onConfirm: (path: string) => void;
  onCancel: () => void;
  /** Element that opened the modal — used for focus restoration. */
  triggerRef?: React.RefObject<HTMLElement | null>;
}

export function DirBrowserModal({ open, onConfirm, onCancel, triggerRef }: DirBrowserModalProps) {
  const { t } = useTranslation("modals");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [currentPath, setCurrentPath] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const scrollPositions = useRef<Map<string, number>>(new Map());
  // Capture the trigger when dialog opens, so we can restore focus on close.
  const capturedTriggerRef = useRef<HTMLElement | null>(null);
  const effectiveTriggerRef = (triggerRef as React.RefObject<HTMLElement | null> | undefined) ?? capturedTriggerRef;

  // Register the shortcut so Alt+D (or whatever the user configured) focuses the search input.
  useShortcutAction(
    "dirSearchFocus",
    useCallback(() => {
      searchInputRef.current?.focus();
    }, []),
    open,
  );

  // Capture the currently focused element when the modal opens (the trigger).
  // Only needed when no external triggerRef is supplied.
  useEffect(() => {
    if (open && !triggerRef) {
      capturedTriggerRef.current = document.activeElement as HTMLElement | null;
    }
  }, [open, triggerRef]);

  // Restore focus to the trigger when modal closes — use the effective ref so an
  // externally-supplied triggerRef actually receives focus (not just the
  // internally captured one).
  useEffect(() => {
    if (!open) {
      const trigger = effectiveTriggerRef.current;
      if (trigger && typeof trigger.focus === "function") {
        // Small tick so the DOM has removed the modal content first.
        setTimeout(() => {
          try { trigger.focus(); } catch {}
        }, 0);
      }
      capturedTriggerRef.current = null;
    }
  }, [open, effectiveTriggerRef]);

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
      const data = await window.api.fs.browseDirs(path ?? "");
      setEntries(data);
      setCurrentPath(path ?? "");
    } catch (err) {
      setEntries([]);
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  /** Continuously save the current scroll position for the active directory. */
  const handleScroll = useCallback(() => {
    if (listRef.current) {
      scrollPositions.current.set(currentPath, listRef.current.scrollTop);
    }
  }, [currentPath]);

  // Restore scroll position when data for the new directory is ready
  useLayoutEffect(() => {
    if (!loading && listRef.current) {
      const saved = scrollPositions.current.get(currentPath);
      if (saved !== undefined) {
        listRef.current.scrollTop = saved;
      }
    }
  }, [currentPath, loading]);

  // Load root directories when modal opens
  useLayoutEffect(() => {
    if (open) {
      scrollPositions.current.clear();
      fetchDirs();
    }
  }, [open, fetchDirs]);

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
      const parentPath = /^[A-Z]:$/.test(parent) ? `${parent}\\` : parent;
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
        accumulated = `${part}\\`;
      } else if (!accumulated && isUnixRoot) {
        // First segment on Unix — prepend /
        accumulated = `/${part}`;
      } else {
        accumulated = `${accumulated}${sep}${part}`;
      }
      breadcrumbs.push({ label: part, path: accumulated });
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
      modal={true}
    >
      <DialogContent
        className="max-w-3xl gap-0 p-0"
        data-testid="dir-modal"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          searchInputRef.current?.focus();
        }}
      >
        <div className="dir-modal-header">
          <div className="dir-modal-header-left">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={goToParent}
              disabled={!currentPath}
              aria-label={t("dirBrowser.goUp")}
            >
              <ChevronLeft aria-hidden="true" />
            </Button>
            <DialogTitle>{t("dirBrowser.title")}</DialogTitle>
          </div>
        </div>

        {/* Breadcrumb — a single continuous, uniform-height path bar instead of
            a row of independent variable-width buttons (which read as
            "/ / C:" fragments and wrapped). Root "/" is merged into the first
            segment; long paths collapse with an ellipsis on the left. */}
        <div className="dir-modal-breadcrumb" data-testid="dir-breadcrumb">
          <nav className="dir-breadcrumb-trail" aria-label={t("dirBrowser.title")}>
            {breadcrumbs.length === 0 ? (
              <span className="dir-breadcrumb-current">/</span>
            ) : (
              breadcrumbs.map((seg, i) => {
                const isLast = i === breadcrumbs.length - 1;
                return (
                  <span key={seg.path} className="dir-breadcrumb-seg">
                    {i > 0 && <span className="dir-breadcrumb-sep" aria-hidden="true">›</span>}
                    <button
                      type="button"
                      className={`dir-breadcrumb-item ${isLast ? "dir-breadcrumb-current" : ""}`}
                      onClick={() => fetchDirs(seg.path)}
                      title={seg.path}
                    >
                      {seg.label}
                    </button>
                  </span>
                );
              })
            )}
          </nav>
        </div>

        {/* Search */}
        <div className="dir-modal-search">
          <label htmlFor="dir-search-input" className="sr-only">
            {t("dirBrowser.searchPlaceholder")}
          </label>
          <Input
            id="dir-search-input"
            type="search"
            className="dir-search-input"
            placeholder={t("dirBrowser.searchPlaceholder")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-testid="dir-search-input"
            ref={searchInputRef}
            aria-label={t("dirBrowser.searchPlaceholder")}
          />
        </div>

        {/* Directory list */}
        <div className="dir-modal-list" ref={listRef} onScroll={handleScroll}>
          {loading && <div className="dir-modal-status">{t("loading", { ns: "common" })}</div>}
          {error && <div className="dir-modal-status dir-modal-error">{error}</div>}
          {!loading && !error && displayEntries.length === 0 && (
            <div className="dir-modal-status">
              {search.trim() ? t("noMatch", { ns: "common" }) : t("loading", { ns: "common" })}
            </div>
          )}
          {!loading &&
            !error &&
            displayEntries.map((entry) => (
              <button
                type="button"
                key={entry.path}
                className={cn(
                  "flex w-full items-center gap-2 px-4 py-1.5 text-left text-[13px] transition-colors select-none hover:bg-secondary",
                  selected === entry.path && "bg-accent text-accent-foreground",
                )}
                onClick={() => handleEntryClick(entry)}
                onDoubleClick={() => handleEntryDoubleClick(entry)}
                data-testid="dir-entry"
                data-dir-path={entry.path}
              >
                <span className="w-5 shrink-0 text-center text-sm">
                  {entry.name === ".. (上级目录)" ? (
                    <FolderUp aria-hidden="true" />
                  ) : (
                    <Folder aria-hidden="true" />
                  )}
                </span>
                <span className="dir-entry-name min-w-0 flex-1 truncate">{entry.name}</span>
                {entry.name !== ".. (上级目录)" && (
                  <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                )}
              </button>
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
          <Button type="button" variant="outline" onClick={onCancel} data-testid="dir-cancel">
            {t("dirBrowser.cancel")}
          </Button>
          <Button
            type="button"
            disabled={!selected}
            onClick={handleConfirm}
            data-testid="dir-confirm"
          >
            {t("dirBrowser.select")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
