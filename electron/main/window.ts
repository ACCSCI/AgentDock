/**
 * Window creation — BrowserWindow factory with DevTools, titlebar, and
 * lifecycle wiring.
 *
 * Extracted from main.ts. Uses a callback pattern so the caller can
 * capture the window reference (since `createWindow` mutates the module-
 * level `mainWindow` variable back in main.ts).
 */
import { app, BrowserWindow } from "electron";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Create the main BrowserWindow and return it.
 *
 * The caller is responsible for storing the reference in the module-level
 * `mainWindow` variable (or wherever it keeps state). This function also
 * wires `ready-to-show`, maximize/unmaximize notifications, and `closed`
 * cleanup internally.
 *
 * @param onCreated - Optional callback invoked with the new window before
 *   it is shown, giving the caller a chance to stash the reference.
 *   Receives the window before `ready-to-show` fires.
 * @returns The newly created BrowserWindow.
 */
export function createWindow(
  onCreated?: (win: BrowserWindow) => void,
): BrowserWindow {
  // e2e/debug knob — when AGENTDOCK_E2E_DEVTOOLS=1 the test runner (or a
  // developer reproducing a failure) gets a detached DevTools window so
  // they can inspect React state / network / storage from outside the
  // automated Playwright session.
  const wantDevTools = process.env.AGENTDOCK_E2E_DEVTOOLS === "1";

  // devTools enabled unless app is packaged (electron-builder).
  const devToolsEnabled = wantDevTools || !app.isPackaged;

  const isMac = process.platform === "darwin";
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: "AgentDock",
    show: false, // Show after ready-to-show to avoid white flash
    frame: isMac, // macOS uses native frame (traffic lights); Windows/Linux use custom titlebar
    titleBarStyle: isMac ? "hiddenInset" : undefined, // macOS: hide title text, keep traffic lights
    webPreferences: {
      preload: resolve(__dirname, "../preload/preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload needs node-pty access via main IPC
      devTools: devToolsEnabled,
    },
  });

  onCreated?.(win);

  if (wantDevTools) {
    win.webContents.once("did-finish-load", () => {
      win.webContents.openDevTools({ mode: "detach" });
    });
  }

  // Allow F12 to toggle DevTools in development
  if (devToolsEnabled) {
    win.webContents.on("before-input-event", (event, input) => {
      if (input.key === "F12" && input.type === "keyDown") {
        if (event.sender.isDevToolsOpened()) {
          event.sender.closeDevTools();
        } else {
          event.sender.openDevTools({ mode: "detach" });
        }
      }
    });
  }

  // Ctrl+W / Cmd+W — close the active project tab.
  //
  // We use IPC (main → renderer) instead of letting the renderer's
  // own keydown handler do the work, because event.preventDefault()
  // in `before-input-event` blocks the keydown event from reaching
  // the renderer's DOM listeners (the event is intercepted before
  // it enters the renderer's event system). Without this main-process
  // hook, macOS's default Electron menu would consume Cmd+W and close
  // the entire window before the renderer sees the key.
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    if (!(input.control || input.meta)) return;
    if (input.key !== "w" && input.key !== "W") return;
    if (input.alt || input.shift) return;
    event.preventDefault();
    // Tell the renderer to close the active project tab.
    win.webContents.send("app:close-tab");
  });

  win.once("ready-to-show", () => {
    win.show();
  });

  // Notify renderer when maximize state changes (for toggle button icon).
  win.on("maximize", () => {
    win.webContents.send("window:maximize-change", true);
  });
  win.on("unmaximize", () => {
    win.webContents.send("window:maximize-change", false);
  });

  return win;
}
