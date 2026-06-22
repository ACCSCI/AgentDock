import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  path: text("path").notNull(),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  branch: text("branch").notNull(),
  worktreePath: text("worktree_path").notNull(),
  ports: text("ports"),
  backgroundHookStatus: text("background_hook_status"),
  backgroundHookErrors: text("background_hook_errors"),
  userStatus: text("user_status"),
  lastActivatedAt: text("last_activated_at"),
  sortOrder: integer("sort_order").$defaultFn(() => Date.now()),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export type ProjectRow = typeof projects.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;

export type TodoStatus = "pending" | "in_progress" | "done";

export const todos = sqliteTable("todos", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  status: text("status").$type<TodoStatus>().notNull().default("pending"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export type TodoRow = typeof todos.$inferSelect;
