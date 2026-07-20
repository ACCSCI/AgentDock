#!/usr/bin/env node
/**
 * Migrate legacy component CSS class selectors to Tailwind utilities.
 *
 * For each CSS module we hand-write a codemod that replaces a class selector's
 * declarations with semantically-equivalent Tailwind utilities, keeping the
 * SAME selector so all existing markup (`className="session-card ..."` and
 * `data-testid`) keeps working without touching every .tsx at once.
 *
 *   .session-card { padding:9px 10px; ... }
 *     →  .session-card { @apply flex items-center justify-between px-2.5 py-2
 *                        bg-card border border-border rounded-md cursor-pointer
 *                        transition-[background,border-color,transform]; }
 *
 * `tailwind-merge`-style semantics are not needed here — `@apply` compiles the
 * utilities to plain CSS at build time. Tokens (bg-card / border-border /
 * text-muted-foreground) resolve through Tailwind's `@theme`, which is
 * theme-aware in BOTH light and dark (unlike the old var(--card) bug).
 *
 * Usage:  node scripts/migrate-css-to-tailwind.mjs <module-name>
 * Prints the transformed file to stdout; review then write back.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const moduleName = process.argv[2];
if (!moduleName) {
  console.error("usage: node scripts/migrate-css-to-tailwind.mjs <module-name>");
  process.exit(1);
}

// ── Per-selector Tailwind mappings, keyed by CSS module ─────────────────────
// Each entry: exact selector → array of Tailwind class strings for @apply.
// Only selectors that are PURE static styling are listed; interactive states
// (:hover/.active) and structural bits are handled in the same block by
// appending variant-prefixed classes.
const MAPPINGS = {
  "tab-bar": {
    ".app-shell": ["flex", "flex-col", "h-full", "overflow-hidden"],
    ".app-content": ["flex-1", "overflow-hidden"],
    ".tab-bar": [
      "flex", "items-center", "h-10", "bg-secondary", "border-b", "border-border",
      "px-1", "gap-0.5", "shrink-0", "overflow-x-auto", "overflow-y-hidden",
      "scroll-smooth", "[scrollbar-width:none]", "[&::-webkit-scrollbar]:hidden",
    ],
    ".tab-item": [
      "flex", "items-center", "gap-2", "px-3", "py-1.5", "h-8", "bg-secondary",
      "border", "border-border", "rounded-sm", "cursor-pointer", "shrink-0",
      "whitespace-nowrap", "text-[13px]", "select-none", "transition-colors",
    ],
    ".tab-item:hover": ["bg-muted"],
    ".tab-item.active": ["bg-card", "border-primary"],
    ".tab-select": [
      "flex", "min-w-0", "flex-1", "items-center", "self-stretch", "border-0",
      "bg-transparent", "text-inherit", "cursor-pointer", "text-start",
    ],
    ".tab-name": ["max-w-[120px]", "overflow-hidden", "text-ellipsis", "whitespace-nowrap"],
    ".tab-close": [
      "bg-transparent", "border-0", "text-muted-foreground", "cursor-pointer",
      "text-xs", "px-0.5", "leading-none", "rounded",
    ],
    ".tab-close:hover": ["text-primary", "bg-secondary"],
    ".tab-add": [
      "bg-transparent", "border", "border-dashed", "border-border", "text-primary",
      "cursor-pointer", "text-base", "size-8", "rounded-sm", "flex", "items-center",
      "justify-center", "shrink-0", "transition-colors",
    ],
    ".tab-add:hover": ["bg-secondary", "border-primary"],
  },
  "icon-sidebar": {
    ".icon-sidebar": [
      "w-12", "border-r", "border-border", "flex", "flex-col", "items-center",
      "py-2", "bg-secondary", "shrink-0",
    ],
    ".icon-sidebar-top, .icon-sidebar-bottom": ["flex", "flex-col", "items-center", "gap-1"],
    ".icon-sidebar-top": ["flex-1"],
    ".icon-sidebar-bottom": ["mt-auto"],
  },
};

// ── Engine ───────────────────────────────────────────────────────────────────
const file = join(ROOT, "src", "styles", "components", `${moduleName}.css`);
const src = readFileSync(file, "utf8");
const map = MAPPINGS[moduleName];
if (!map) {
  console.error(`no mapping defined for module "${moduleName}". Add it to MAPPINGS.`);
  process.exit(1);
}

let out = src;
let replaced = 0;
for (const [selector, classes] of Object.entries(map)) {
  // Match `selector { ... }` — naive but our modules are flat (no nesting).
  const re = new RegExp(
    `${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{[^}]*\\}`,
    "g",
  );
  if (!re.test(out)) {
    console.warn(`  ⚠ selector not found: ${selector}`);
    continue;
  }
  out = out.replace(re, `${selector} { @apply ${classes.join(" ")}; }`);
  replaced++;
}

console.error(`✓ ${moduleName}: replaced ${replaced}/${Object.keys(map).length} selectors`);
process.stdout.write(out);
