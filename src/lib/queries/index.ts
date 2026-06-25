/**
 * Query / Mutation hooks — barrel export.
 *
 * Re-exports all domain-specific hooks and types so consumers can import
 * from "src/lib/queries" as before (the directory index replaces the
 * former monolithic queries.ts file).
 */

// Types and helpers
export * from "./types.js";
export * from "./helpers.js";

// Domain hooks
export * from "./projects.js";
export * from "./sessions.js";
export * from "./terminals.js";
export * from "./hooks.js";
export * from "./orphan-files.js";
export * from "./config.js";
export * from "./v2-projects.js";
export * from "./todos.js";
