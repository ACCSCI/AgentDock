import { ChevronLeft, Folder, FolderOpen } from "lucide-react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useProjectFiles, type FileEntry } from "../lib/queries";
import { useTranslation } from "../i18n/react";
import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";

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

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
      modal={true}
    >
      <DialogContent className="max-w-xl gap-0 p-0">
        <div className="flex items-center justify-between border-b border-border px-4 py-3 pr-12">
          <DialogTitle>{t("filePicker.title")}</DialogTitle>
        </div>

        {/* Breadcrumb navigation */}
        <div className="flex flex-wrap items-center gap-0.5 border-b border-border px-4 py-2 text-[13px]">
          <button
            type="button"
            className="rounded-sm px-1 py-0.5 text-[13px] text-primary hover:bg-accent"
            onClick={() => goToPath("")}
          >
            <Folder className="mr-1 inline size-3.5" aria-hidden="true" />
            项目根目录
          </button>
          {breadcrumbs.map((seg, i) => {
            const segPath = breadcrumbs.slice(0, i + 1).join("/");
            return (
              <span key={segPath}>
                <span className="text-xs text-muted-foreground">/</span>
                <button
                  type="button"
                  className="rounded-sm px-1 py-0.5 text-[13px] text-primary hover:bg-accent"
                  onClick={() => goToPath(segPath)}
                >
                  {seg}
                </button>
              </span>
            );
          })}
        </div>

        {/* Search */}
        <div className="border-b border-border px-4 py-2">
          <Input
            type="text"
            placeholder={t("filePicker.searchPlaceholder")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label={t("filePicker.searchPlaceholder")}
          />
        </div>

        {/* File list */}
        <div
          className="max-h-[400px] min-h-[200px] flex-1 overflow-y-auto"
          ref={listRef}
          onScroll={handleScroll}
        >
          {isLoading ? (
            <div className="flex h-[120px] items-center justify-center text-[13px] text-muted-foreground">
              {t("loading", { ns: "common" })}
            </div>
          ) : displayEntries.length === 0 ? (
            <div className="flex h-[120px] items-center justify-center text-[13px] text-muted-foreground">
              {t("noMatch", { ns: "common" })}
            </div>
          ) : (
            displayEntries.map((entry) => (
              <div
                key={entry.path}
                className={cn(
                  "flex cursor-pointer items-center gap-2 px-4 py-2 transition-colors hover:bg-secondary",
                  selected === entry.path && "bg-accent hover:bg-accent",
                )}
                onClick={() => handleNavigate(entry)}
                onDoubleClick={() => {
                  if (!entry.isDir) onConfirm(entry.path);
                }}
              >
                <span className="shrink-0 text-base">
                  {entry.isDir ? "📁" : "📄"}
                </span>
                <span className="flex-1 truncate text-[13px]">{entry.name}</span>
                {entry.status !== "untracked" ? (
                  <Badge variant="success" className="shrink-0">
                    已跟踪
                  </Badge>
                ) : (
                  <Badge variant="secondary" className="shrink-0">
                    未跟踪
                  </Badge>
                )}
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-border px-4 py-2.5">
          {currentPath && (
            <>
              <Button type="button" variant="secondary" size="sm" onClick={handleBack}>
                <ChevronLeft aria-hidden="true" />
                返回上级
              </Button>
              <Button type="button" variant="default" size="sm" onClick={handleSelectDir}>
                <FolderOpen aria-hidden="true" />
                选择此目录
              </Button>
            </>
          )}
          <div className="ml-auto flex gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={onCancel}>
              {t("filePicker.cancel")}
            </Button>
            <Button
              type="button"
              variant="default"
              size="sm"
              disabled={!selected}
              onClick={handleConfirm}
            >
              {t("filePicker.select")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
