/**
 * Fix Suggester — produces actionable fix suggestions from failure classifications.
 *
 * Why a separate module from the classifier:
 *   - The classifier answers "what kind of failure?" The suggester answers
 *     "what should we do about it?" These are different concerns.
 *   - The suggester can be swapped for a Claude-powered version (using the
 *     `agent` tool) without changing the classifier.
 *
 * Extending suggestions:
 *   - The `suggestionRules` array below maps `(failureType, suggestedAction)`
 *     to a list of `FixSuggestion` objects. To add project-specific fixes:
 *     1. Add a rule for a known failure pattern.
 *     2. Point `files` at the test file and/or the source under test.
 *     3. Describe a concrete `change` (e.g. "add waitFor selector before click").
 *
 * Integration:
 *   - `runSuggestFix()` reads `e2e/reports/latest.json`, finds failures,
 *     runs the classifier, and writes suggestions to stdout.
 *   - The `e2e:suggest-fix` npm script invokes this.
 */
import type { FailureClassification } from "./failure-classifier.js";

export interface FixSuggestion {
  title: string;
  description: string;
  files: Array<{
    path: string;
    change: "modify" | "create" | "delete";
    rationale: string;
  }>;
  confidence: number;
}

/**
 * Suggest fixes for a given failure classification.
 *
 * @param classification - Output from `classifyFailure()`
 * @param testPath - Path to the failing test
 * @param errorMessage - The raw error message
 * @returns Array of fix suggestions, ordered by confidence descending
 */
export function suggestFix(
  classification: FailureClassification,
  testPath: string,
  errorMessage: string
): FixSuggestion[] {
  const suggestions: FixSuggestion[] = [];

  // --- Timeout suggestions ---
  if (classification.type === "timeout") {
    suggestions.push({
      title: "Increase test timeout",
      description:
        "The test exceeded its time limit. If the operation is legitimately slow " +
        "(e.g. cold Electron boot, AI agent response), increase the per-test timeout " +
        "in e2e/pipeline.yaml or add a custom timeout in the test.",
      files: [
        {
          path: testPath,
          change: "modify",
          rationale: "Add `test.setTimeout(120_000)` at the top of the test.",
        },
      ],
      confidence: 0.6,
    });
  }

  // --- Environment suggestions ---
  if (classification.type === "environment") {
    if (/EADDRINUSE|port.*in.*use/.test(errorMessage)) {
      suggestions.push({
        title: "Port conflict — check for zombie processes",
        description:
          "A port is already in use. Kill leftover processes or use a random port. " +
          "The fixture should already allocate a random port, so this may indicate " +
          "a race condition in port allocation.",
        files: [
          {
            path: testPath,
            change: "modify",
            rationale:
              "Check if the test hardcodes a port. Switch to port 0 or use the fixture's " +
              "dynamic port allocation.",
          },
        ],
        confidence: 0.7,
      });
    }
    if (/EBUSY|EPERM/.test(errorMessage)) {
      suggestions.push({
        title: "File lock contention",
        description:
          "A file is locked by another process. This is common on Windows when " +
          "Electron doesn't exit cleanly. Ensure proper cleanup in the fixture's " +
          "afterAll.",
        files: [
          {
            path: testPath,
            change: "modify",
            rationale:
              "Add retry logic for file operations, or ensure Electron process " +
              "is fully terminated before teardown.",
          },
        ],
        confidence: 0.6,
      });
    }
  }

  // --- Flaky (network) suggestions ---
  if (classification.type === "flaky") {
    suggestions.push({
      title: "Network flakiness — add retry guard",
      description:
        "The failure is likely transient. The pipeline will auto-retry based on the " +
        "classifier's action. If this recurs, add a retry wrapper or increase the " +
        "retries count in e2e/pipeline.yaml.",
      files: [
        {
          path: "e2e/pipeline.yaml",
          change: "modify",
          rationale: "Set `pipeline.global.retries: 2` for this group.",
        },
      ],
      confidence: 0.5,
    });
  }

  // --- Real bug (fallback) ---
  if (classification.type === "real-bug") {
    suggestions.push({
      title: "Investigate as a real bug",
      description:
        "The classifier could not auto-categorize this failure. Investigate the " +
        "stack trace and the code under test. The Claude Code `agent` tool can " +
        "help with root-cause analysis.",
      files: [
        {
          path: testPath,
          change: "modify",
          rationale:
            "Read the failing test, the code it exercises, and the error stack trace.",
        },
      ],
      confidence: 0.3,
    });
  }

  return suggestions.sort((a, b) => b.confidence - a.confidence);
}
