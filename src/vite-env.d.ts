/// <reference types="vite/client" />

interface Window {
  showDirectoryPicker(options?: {
    id?: string;
    mode?: "read" | "readwrite";
    startIn?: "desktop" | "documents" | "downloads" | "音乐" | "图片" | "视频";
  }): Promise<FileSystemDirectoryHandle>;
}

type FileSystemDirectoryHandle = {
  kind: "directory";
  name: string;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileSystemFileHandle>;
  getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<FileSystemDirectoryHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  values(): AsyncIterableIterator<FileSystemHandle>;
  [Symbol.asyncIterator](): AsyncIterableIterator<FileSystemHandle>;
};

type FileSystemFileHandle = {
  kind: "file";
  name: string;
  getFile(): Promise<File>;
};

type FileSystemHandle = FileSystemDirectoryHandle | FileSystemFileHandle;
