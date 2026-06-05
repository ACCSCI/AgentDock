import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { terminalManager } from "./terminal-manager.js";

const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * 在 Vite HTTP Server 上创建 Terminal WebSocket 服务。
 *
 * WebSocket 协议：
 *   Client → Server: { type: "input", data: string }
 *   Client → Server: { type: "resize", cols: number, rows: number }
 *   Client → Server: { type: "heartbeat" }
 *   Server → Client: { type: "output", data: string }
 *   Server → Client: { type: "exit", code: number|null, signal?: number }
 *   Server → Client: { type: "error", message: string }
 *   Server → Client: { type: "opened", terminalId: string, sessionId: string, pid: number }
 *   Server → Client: { type: "heartbeat_ack" }
 *
 * URL: /api/terminal?terminalId=xxx
 */
export function createTerminalWebSocket(
  httpServer: import("node:http").Server,
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  // ---- HTTP Upgrade 拦截 ----
  httpServer.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    if (url.pathname !== "/api/terminal") {
      return;
    }

    const terminalId = url.searchParams.get("terminalId");
    if (!terminalId) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req, terminalId);
    });
  });

  // ---- 连接处理 ----
  wss.on("connection", async (ws: WebSocket, _req: IncomingMessage, terminalId: string) => {
    try {
      // 1. Look up the terminal
      const terminal = terminalManager.get(terminalId);
      if (!terminal) {
        ws.send(JSON.stringify({ type: "error", message: `Terminal not found: ${terminalId}` }));
        ws.close();
        return;
      }

      // 2. Attach connection
      terminalManager.attach(terminalId, ws);

      // 3. Replay buffer (for reconnection / reattach)
      for (const chunk of terminal.buffer) {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: "output", data: chunk }));
        }
      }

      // 4. Send opened event
      ws.send(JSON.stringify({
        type: "opened",
        terminalId,
        sessionId: terminal.sessionId,
        pid: terminal.pid,
        status: terminal.status,
      }));

      console.log(`[TerminalWS] Terminal ${terminalId} connected (connections=${terminal.connections.size}, status=${terminal.status})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.error(`[TerminalWS] Failed to attach to terminal ${terminalId}:`, msg);
      try {
        ws.send(JSON.stringify({ type: "error", message: msg }));
      } catch { /* ignore */ }
      ws.close();
      return;
    }

    // ---- 消息处理 ----
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        switch (msg.type) {
          case "input":
            terminalManager.write(terminalId, msg.data);
            break;

          case "resize":
            if (typeof msg.cols === "number" && typeof msg.rows === "number") {
              terminalManager.resize(terminalId, msg.cols, msg.rows);
            }
            break;

          case "heartbeat":
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify({ type: "heartbeat_ack" }));
            }
            break;

          default:
            console.warn(`[TerminalWS] Unknown message type from ${terminalId}: ${msg.type}`);
        }
      } catch (err) {
        console.error(`[TerminalWS] Invalid message from ${terminalId}:`, err);
      }
    });

    // ---- 断开处理：detach, 不 kill PTY ----
    ws.on("close", () => {
      terminalManager.detach(terminalId, ws);
      console.log(`[TerminalWS] Terminal ${terminalId} detached`);
    });

    ws.on("error", (err) => {
      console.error(`[TerminalWS] WebSocket error for ${terminalId}:`, err.message);
      terminalManager.detach(terminalId, ws);
    });
  });

  // ---- 心跳检测 ----
  const heartbeatTimer = setInterval(() => {
    wss.clients.forEach((ws) => {
      if ((ws as any)._isAlive === false) {
        ws.terminate();
        return;
      }
      (ws as any)._isAlive = false;
      ws.ping();
    });
  }, HEARTBEAT_INTERVAL_MS);

  wss.on("connection", (ws) => {
    (ws as any)._isAlive = true;
    ws.on("pong", () => {
      (ws as any)._isAlive = true;
    });
  });

  // ---- 清理 ----
  wss.on("close", () => {
    clearInterval(heartbeatTimer);
    terminalManager.killAll();
  });

  console.log("[TerminalWS] WebSocket server ready at /api/terminal");
  return wss;
}
