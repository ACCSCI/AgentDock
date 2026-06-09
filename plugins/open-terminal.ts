import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";

/**
 * Open a system terminal at the given directory.
 *
 * Platform behavior:
 * - win32: Opens cmd.exe via start so a new console window appears.
 * - darwin: Opens a new Terminal.app window at the directory.
 * - linux: Uses x-terminal-emulator as a sensible default.
 *
 * Security: the path is passed to execFile as a discrete argument array,
 * never interpolated into a shell command string. This prevents command
 * injection even if dirPath contains shell metacharacters.
 */
export function openInTerminal(dirPath: string): Promise<void> {
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
      cmd = "cmd.exe";
      args = ["/c", "start", "", "/D", dirPath, "cmd.exe"];
    } else if (process.platform === "darwin") {
      cmd = "open";
      args = ["-a", "Terminal", dirPath];
    } else {
      cmd = "x-terminal-emulator";
      args = ["--working-directory", dirPath];
    }

    execFile(cmd, args, (err) => {
      if (err) {
        if (process.platform === "linux" && cmd === "x-terminal-emulator") {
          execFile("gnome-terminal", ["--working-directory", dirPath], (err2) => {
            if (err2) {
              reject(new Error(`Failed to open terminal: ${err2.message}`));
              return;
            }
            resolve();
          });
          return;
        }
        reject(err);
        return;
      }
      resolve();
    });
  });
}
