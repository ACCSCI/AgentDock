import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";

/**
 * Open a directory in the OS file manager.
 *
 * Security: the path is passed to execFile as a discrete argument array,
 * never interpolated into a shell command string. This prevents command
 * injection even if `dirPath` contains shell metacharacters.
 */
export function openInFileManager(dirPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!dirPath || typeof dirPath !== "string") {
      reject(new Error("path is required"));
      return;
    }
    if (!existsSync(dirPath) || !statSync(dirPath).isDirectory()) {
      reject(new Error(`Not a directory: ${dirPath}`));
      return;
    }

    let cmd: string;
    let args: string[];
    if (process.platform === "win32") {
      cmd = "explorer";
      args = [dirPath];
    } else if (process.platform === "darwin") {
      cmd = "open";
      args = [dirPath];
    } else {
      cmd = "xdg-open";
      args = [dirPath];
    }

    execFile(cmd, args, (err) => {
      // Windows `explorer` returns exit code 1 even on success, so ignore that
      // specific case; surface other failures.
      if (err && !(process.platform === "win32" && (err as { code?: number }).code === 1)) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}
