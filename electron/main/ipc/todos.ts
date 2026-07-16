import { asc, eq, sql } from "drizzle-orm";
/**
 * Todo IPC handlers — per-project todo list CRUD.
 *
 * Channels:
 *   todos:list          — list todos for a project
 *   todos:create        — create a new todo
 *   todos:cycleStatus   — cycle pending → in_progress → done → pending
 *   todos:update        — update todo content
 *   todos:delete        — delete a todo
 */
import { ipcMain } from "electron";
import { nanoid } from "nanoid";
import { getActiveDb } from "../../../plugins/db/index.js";
import * as schema from "../../../plugins/db/schema.js";

const STATUS_CYCLE: Record<string, schema.TodoStatus> = {
  pending: "in_progress",
  in_progress: "done",
  done: "pending",
};

function nextStatus(current: string): schema.TodoStatus {
  return STATUS_CYCLE[current] ?? "pending";
}

function getDb() {
  const db = getActiveDb();
  if (!db) throw new Error("DB not initialized");
  return db;
}

export function registerTodos(): void {
  ipcMain.handle("todos:list", (_event, args: { projectId: string }) => {
    const { projectId } = args as { projectId: string };
    const db = getDb();
    return db
      .select()
      .from(schema.todos)
      .where(eq(schema.todos.projectId, projectId))
      .orderBy(asc(schema.todos.sortOrder), asc(schema.todos.createdAt))
      .all();
  });

  ipcMain.handle("todos:create", (_event, args: { projectId: string; content: string }) => {
    const { projectId, content } = args as { projectId: string; content: string };
    const db = getDb();
    const now = new Date().toISOString();
    const id = nanoid();

    // Get max sortOrder via database MAX聚合
    const [result] = db
      .select({ maxSort: sql.raw("COALESCE(MAX(sort_order), 0)") })
      .from(schema.todos)
      .where(eq(schema.todos.projectId, projectId))
      .all();
    const maxSort = (result?.maxSort as number) ?? 0;

    db.insert(schema.todos)
      .values({
        id,
        projectId,
        content,
        status: "pending",
        sortOrder: maxSort + 1,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    return db.select().from(schema.todos).where(eq(schema.todos.id, id)).get();
  });

  ipcMain.handle("todos:cycleStatus", (_event, args: { id: string }) => {
    const { id } = args as { id: string };
    const db = getDb();
    const todo = db
      .select({ status: schema.todos.status })
      .from(schema.todos)
      .where(eq(schema.todos.id, id))
      .get();
    if (!todo) return;
    db.update(schema.todos)
      .set({ status: nextStatus(todo.status ?? "pending"), updatedAt: new Date().toISOString() })
      .where(eq(schema.todos.id, id))
      .run();
  });

  ipcMain.handle("todos:update", (_event, args: { id: string; content: string }) => {
    const { id, content } = args as { id: string; content: string };
    const db = getDb();
    db.update(schema.todos)
      .set({ content, updatedAt: new Date().toISOString() })
      .where(eq(schema.todos.id, id))
      .run();
  });

  ipcMain.handle("todos:delete", (_event, args: { id: string }) => {
    const { id } = args as { id: string };
    const db = getDb();
    db.delete(schema.todos).where(eq(schema.todos.id, id)).run();
  });

  ipcMain.handle("todos:reorder", (_event, args: { todoIds: string[] }) => {
    const { todoIds } = args as { todoIds: string[] };
    const db = getDb();
    for (let i = 0; i < todoIds.length; i++) {
      db.update(schema.todos)
        .set({ sortOrder: i, updatedAt: new Date().toISOString() })
        .where(eq(schema.todos.id, todoIds[i]))
        .run();
    }
  });
}
