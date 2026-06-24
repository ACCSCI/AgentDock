/**
 * Prompt template for converting a project to be "AgentDock Compatible".
 *
 * Copied to clipboard via the IconSidebar 📋 button.
 * Contains the full AgentDock Compatible Specification so any AI tool can
 * help convert a project — without needing access to docs/.
 * Does NOT include YAML config — users configure that in AgentDock directly.
 */

import i18n from "../i18n";

/**
 * Get the compat prompt in the current language.
 * Language switching automatically returns the corresponding version.
 */
export function getCompatPrompt(): string {
  return i18n.t("content", { ns: "compat-prompt" });
}

// Keep backward compatibility for existing imports
export const AGENTDOCK_COMPAT_PROMPT = getCompatPrompt();
