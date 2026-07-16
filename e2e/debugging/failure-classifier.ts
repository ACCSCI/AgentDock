/**
 * Failure Classifier — categorizes test failures based on error patterns.
 *
 * Why classify failures automatically:
 *   - Network flakiness (ECONNREFUSED, ETIMEOUT) should be retried, not
 *     treated as real bugs. Auto-classifying saves developer time by
 *     separating noise from signal.
 *   - Environment issues (EBUSY, port-in-use) indicate infrastructure
 *     problems — fixing them in the test code is wasteful.
 *   - The classifier feeds into the pipeline runner's retry logic and
 *     the fix-suggester's recommendations.
 *
 * Extending rules:
 *   - Add a pattern to the `rules` array below. Each rule has:
 *     - `pattern`: RegExp that matches the error message or stack trace
 *     - `type`: classification category
 *     - `action`: suggested next step for the pipeline
 *   - For Electron-specific failures, add patterns like
 *     `Electron.*crash|GPU.*initialization failed` → `environment`.
 *   - For Playwright-specific patterns, add
 *     `page.*closed|navigation.*timeout` → `flaky`.
 *
 * Limitations:
 *   - Heuristic-based; confidence is fixed at 0.8 for matches, 0.5 for
 *     the fallback. Use the Claude Code `agent` tool for nuanced root-cause
 *     analysis when the heuristic is insufficient.
 *   - No cross-test correlation yet — a single ECONNREFUSED might mean a
 *     real server bug, not flakiness. The `confidence` score reflects this.
 */
export interface FailureClassification {
  type: "flaky" | "real-bug" | "environment" | "timeout" | "unknown";
  confidence: number;
  reason: string;
  suggestedAction: "retry" | "skip" | "fix" | "investigate";
  relatedFiles?: string[];
}

interface ClassificationRule {
  pattern: RegExp;
  type: FailureClassification["type"];
  action: FailureClassification["suggestedAction"];
  description: string;
}

const rules: ClassificationRule[] = [
  // --- Network flakiness ---
  {
    pattern: /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE/,
    type: "flaky",
    action: "retry",
    description: "Network connection issue — likely transient",
  },
  // --- Port / file lock contention ---
  {
    pattern: /port.*in.*use|EADDRINUSE|EBUSY|EPERM|EACCES|LOCK_TIMEOUT/,
    type: "environment",
    action: "skip",
    description: "Port or file lock contention — test environment issue",
  },
  // --- Process / OS issues ---
  {
    pattern: /ENOSPC|ENOMEM|spawn.*ENOENT|fork.*ENOENT/,
    type: "environment",
    action: "skip",
    description: "System resource exhaustion or missing binary",
  },
  // --- Playwright / Electron crashes ---
  {
    pattern: /Electron.*crash|SIGKILL|SIGTERM.*killed|GPU.*initialization/,
    type: "environment",
    action: "retry",
    description: "Electron process crashed — may be transient GPU issue",
  },
  // --- Timeout patterns ---
  {
    pattern: /timeout|exceeded.*ms|timed out/i,
    type: "timeout",
    action: "investigate",
    description: "Timeout — test or assertion exceeded time limit",
  },
];

/**
 * Classify a test failure based on its error message and stack trace.
 *
 * @param errorMessage - The error message string
 * @param stackTrace - The full stack trace (if available)
 * @param testPath - Path to the failing test (for context)
 * @returns Classification with type, confidence, reason, and suggested action
 */
export function classifyFailure(
  errorMessage: string,
  stackTrace: string,
  testPath: string,
): FailureClassification {
  const combined = `${errorMessage}\n${stackTrace}`;

  for (const rule of rules) {
    if (rule.pattern.test(combined) || rule.pattern.test(errorMessage)) {
      return {
        type: rule.type,
        confidence: 0.8,
        reason: `${rule.description} (pattern: ${rule.pattern.source})`,
        suggestedAction: rule.action,
        relatedFiles: [testPath],
      };
    }
  }

  // No pattern matched — assume real bug with moderate confidence.
  // A high-fidelity classifier (e.g. Claude agent) would analyze the
  // stack trace and diff to raise confidence.
  return {
    type: "real-bug",
    confidence: 0.5,
    reason: "No matching heuristic pattern — likely a real bug (investigate)",
    suggestedAction: "fix",
    relatedFiles: [testPath],
  };
}
